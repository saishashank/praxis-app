// Pick-alert mail (M17 WP4; EML-038..041, ARN-113/114, D-388/D-389/D-448..D-455).
//
// Order: the alert state is already written by the poll (state first); this module then decides
// what to do with each unmailed transition: preference (off), staging (none), quiet hours (held),
// own daily cap (suppressed_cap), then ONE claimKey per alert per session through `sendEmail`
// (pool slot only; the P0 slot is never touched). Every outcome is a `pick_alert_mail` row, so the
// mailer derives "unmailed" from `pick_alert` rows without such a row and a lost tick is repaired.
// Writes here: `pick_alert_mail` only (the e-mail rows go through sendEmail / recordRow).
import type { Client } from "@libsql/client";
import { inQuietHours, parseQuietHours, type QuietHours } from "@/lib/alerts/api";
import {
  MAILED_CLEAR_REASONS,
  type AlertRow,
  type AlertStateName,
  type ClearReason,
  type MailableTransition,
  type MailerCtx,
  type PickAlertMailer,
} from "@/lib/alerts/pick/types";
import { getConfig } from "@/lib/config/store";
import type { Exec } from "@/lib/cortex/store/common";
import type { EmailEnv } from "@/lib/sentinel/schema";
import { COUNTED, loadCaps, recordRow } from "./caps";
import { emailKeys, melbourneDate, PICK_MAIL_KINDS } from "./keys";
import { emailEnvName, sendEmail, type SendContext } from "./send";
import type {
  Latency,
  PickCandidateFacts,
  PickClearedFacts,
  PickHitFacts,
  PickLine,
} from "./templates/pickAlerts";

export type PickKind = (typeof PICK_MAIL_KINDS)[number];
export type PickMailResult = "sent" | "batched" | "suppressed_cap" | "held" | "off";
export type PickEvent = "hit" | "below_stop" | "above_chase_cap" | "candidate";

/** SendContext plus the auth DB (preferences and quiet hours live there; absent = defaults). */
export type PickMailCtx = SendContext & { auth?: Exec };

/** One mailable thing: a hit, a mailed clear or a candidate, with its pre-formatted facts. */
export type PickItem = {
  /** `pick_alert.alert_id`, or `cand:<market>:<d>:<code>` for a candidate. */
  alertId: string;
  event: PickEvent;
  hit?: PickHitFacts;
  cleared?: PickClearedFacts;
  candidate?: PickCandidateFacts;
  line: PickLine;
};

export type PickFacts = {
  market: string;
  sessionD: string;
  /** Tick slot HHMM (part of the batch key). */
  hhmm: string;
  items: PickItem[];
  latency?: Latency;
};

const SESSION_END = "16:00"; // threshold-ok: last quote-poll tick (D-388)

const pickKindOf = (e: PickEvent): PickKind =>
  e === "hit" ? "pick_hit" : e === "candidate" ? "pick_candidate" : "pick_cleared";

const itemKey = (it: PickItem, f: PickFacts): string => {
  if (it.event === "hit") return emailKeys.pickHit(it.alertId, f.sessionD);
  if (it.event === "candidate") {
    const code = it.candidate?.code ?? it.line.code;
    return emailKeys.pickCandidate(f.market, f.sessionD, code);
  }
  return emailKeys.pickCleared(it.alertId, f.sessionD);
};

async function num(db: Exec, key: string): Promise<number> {
  return Number(await getConfig(db as Client, key as never));
}

// ---- the daily cap --------------------------------------------------------------------------------

const KIND_LIST = PICK_MAIL_KINDS.map((k) => `'${k}'`).join(",");

/**
 * Pick mails still allowed on Melbourne date `d` (EML-041, D-389, D-449): `pick_alert_emails_per_day`
 * minus the counted pick rows, and never more than the pool room that is left after the unused P0
 * allowance (capped at the headroom the own cap leaves), so pick mail cannot crowd out a P0 alert.
 * `candidate`: also bounded by `intraday_candidate_emails_per_day`.
 */
export async function pickCapRemaining(
  db: Exec,
  env: EmailEnv,
  d: string,
  opts: { candidate?: boolean } = {},
): Promise<number> {
  const own = await num(db, "pick_alert_emails_per_day");
  const count = async (extra: string): Promise<number> => {
    const r = await db.execute({
      sql: `SELECT COUNT(*) AS n FROM email_message m WHERE m.env = ? AND m.d = ? AND ${extra} AND ${COUNTED}`,
      args: [env, d],
    });
    return Number(r.rows[0].n);
  };
  const used = await count(`m.kind IN (${KIND_LIST})`);
  let left = own - used;
  const caps = await loadCaps(db);
  const poolSize = Math.max(0, caps.dailyCap - caps.reservedSlots);
  const poolUsed = await count("m.slot IN ('pool','p0')");
  const p0Used = await count("m.slot = 'p0'");
  const p0Reserve = Math.min(Math.max(0, caps.p0DailyCap - p0Used), Math.max(0, poolSize - own));
  left = Math.min(left, poolSize - poolUsed - p0Reserve);
  if (opts.candidate) {
    const candCap = await num(db, "intraday_candidate_emails_per_day");
    left = Math.min(left, candCap - (await count("m.kind = 'pick_candidate'")));
  }
  return Math.max(0, left);
}

// ---- pick_alert_mail rows ---------------------------------------------------------------------------

type MailStatus = "sent" | "batched" | "suppressed_cap" | "held" | "held_to_review" | "off";

async function writeMail(
  db: Exec,
  alertId: string,
  kind: PickKind,
  key: string | null,
  status: MailStatus,
  at: string,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO pick_alert_mail (alert_id, kind, email_key, status, at)
          SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS
            (SELECT 1 FROM pick_alert_mail WHERE alert_id = ? AND email_key IS ? AND status = ?)`,
    args: [alertId, kind, key, status, at, alertId, key, status],
  });
}

// ---- preferences and quiet hours (auth DB) -----------------------------------------------------------

type UserPrefs = {
  alerts: boolean;
  cleared: boolean;
  candidates: boolean;
  quiet: QuietHours | null;
};

const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

async function readPrefs(
  auth: Exec | undefined,
  userId: string,
  ownerOn: boolean,
): Promise<UserPrefs> {
  if (!auth) return { alerts: true, cleared: true, candidates: true, quiet: null };
  const r = await auth.execute({
    sql: "SELECT u.role AS role, p.prefs_json AS prefs_json FROM app_user u LEFT JOIN user_preference p ON p.user_id = u.id WHERE u.id = ?",
    args: [Number(userId)],
  });
  if (!r.rows.length) return { alerts: false, cleared: false, candidates: false, quiet: null };
  let v: Record<string, unknown> = {};
  if (r.rows[0].prefs_json !== null) {
    try {
      const j: unknown = JSON.parse(String(r.rows[0].prefs_json));
      if (isRec(j)) v = j;
    } catch {
      v = {};
    }
  }
  const alerts =
    v.pick_alerts === "on"
      ? true
      : v.pick_alerts === "off"
        ? false
        : String(r.rows[0].role) === "owner" && ownerOn;
  return {
    alerts,
    cleared: v.cleared_pick_emails !== "off",
    candidates: v.intraday_candidate_emails !== "off",
    quiet: parseQuietHours(v.quiet_hours),
  };
}

// ---- sending ------------------------------------------------------------------------------------------

/**
 * Sends (or holds, suppresses, batches) the pick mail for one user. `kind` is the kind of a single
 * mail; two or more items go out as one `pick_batch` (tick batching, EML-041). Never throws on a
 * decided outcome. `alertIds` names the items for the rows; it must match `facts.items`.
 */
export async function sendPickMail(
  ctx: PickMailCtx,
  x: { kind: PickKind; userId: string; alertIds: string[]; facts: PickFacts },
): Promise<PickMailResult> {
  const now = (ctx.now ?? (() => new Date()))();
  const at = now.toISOString();
  const d = melbourneDate(now);
  const env = emailEnvName(ctx.env);
  const ids = new Set(x.alertIds);
  const all = x.facts.items.filter((i) => ids.has(i.alertId));
  if (all.length === 0) return "off";
  const record = async (
    items: PickItem[],
    status: MailStatus,
    key?: (i: PickItem) => string | null,
  ) => {
    for (const i of items) {
      await writeMail(
        ctx.db,
        i.alertId,
        pickKindOf(i.event),
        key ? key(i) : itemKey(i, x.facts),
        status,
        at,
      );
    }
  };

  // 1. Staging sends none to the inbox (EML-041).
  if (env === "staging") {
    await record(all, "off");
    return "off";
  }
  // 2. Preferences (D-444): pick_alerts off, cleared mail off, candidate mail off.
  const prefs = await readPrefs(
    ctx.auth,
    x.userId,
    String(await getConfig(ctx.db as Client, "pick_alerts_default_owner")) === "on",
  );
  const wanted = prefs.alerts
    ? all.filter((i) =>
        i.event === "candidate" ? prefs.candidates : i.event === "hit" ? true : prefs.cleared,
      )
    : [];
  const dropped = all.filter((i) => !wanted.includes(i));
  if (dropped.length) await record(dropped, "off");
  if (wanted.length === 0) return "off";

  // 3. Quiet hours: nothing claimed; a `held` row (D-388). A window ending after the last tick
  //    (16:00), and every candidate, goes straight to Evening Review section 9 (`held_to_review`).
  if (inQuietHours(now, prefs.quiet)) {
    const toReview = prefs.quiet !== null && prefs.quiet.end > SESSION_END;
    for (const i of wanted) {
      await writeMail(
        ctx.db,
        i.alertId,
        pickKindOf(i.event),
        itemKey(i, x.facts),
        toReview || i.event === "candidate" ? "held_to_review" : "held",
        at,
      );
    }
    return "held";
  }

  // 4. Own cap, then the claim.
  return deliver(ctx, x.userId, wanted, x.facts, at, d, env);
}

async function deliver(
  ctx: PickMailCtx,
  userId: string,
  items: PickItem[],
  f: PickFacts,
  at: string,
  d: string,
  env: EmailEnv,
): Promise<PickMailResult> {
  const batch = items.length > 1;
  const single = items[0];
  const candidate = !batch && single.event === "candidate";
  const mailKind: PickKind = batch ? "pick_batch" : pickKindOf(single.event);
  const key = batch ? emailKeys.pickBatch(userId, f.sessionD, f.hhmm) : itemKey(single, f);
  const mark = async (status: MailStatus) => {
    for (const i of items) await writeMail(ctx.db, i.alertId, mailKind, key, status, at);
  };

  if ((await pickCapRemaining(ctx.db, env, d, { candidate })) < 1) {
    await recordRow(ctx.db, {
      key,
      kind: mailKind,
      env,
      d,
      slot: "pool",
      status: "suppressed_cap",
      nowIso: at,
    });
    await mark("suppressed_cap");
    return "suppressed_cap";
  }
  const latency = f.latency;
  let out;
  if (batch) {
    out = await sendEmail(ctx, "pick_batch", key, {
      window: `${melbourneHm(ctx.now?.() ?? new Date(at))} Melbourne`,
      lines: items.map((i) => i.line),
      latency,
    });
  } else if (single.event === "hit") {
    out = await sendEmail(ctx, "pick_hit", key, { facts: single.hit!, latency });
  } else if (single.event === "candidate") {
    out = await sendEmail(ctx, "pick_candidate", key, { facts: single.candidate!, latency });
  } else {
    out = await sendEmail(ctx, "pick_cleared", key, { facts: single.cleared!, latency });
  }
  switch (out.status) {
    case "sent":
    case "duplicate":
      await mark(batch ? "batched" : "sent");
      return batch ? "batched" : "sent";
    case "suppressed_cap":
      await mark("suppressed_cap");
      return "suppressed_cap";
    case "pending":
      return "held"; // retried by the next tick through the derived-unmailed read (D-451)
    default:
      // suppressed_off, suppressed_paused, no_recipient, invalid, failed: final for pick mail (D-451)
      await mark("off");
      return "off";
  }
}

const hmFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Australia/Melbourne",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const melbourneHm = (at: Date): string => hmFmt.format(at);
const stampFmt = new Intl.DateTimeFormat("en-AU", {
  timeZone: "Australia/Melbourne",
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
});
/** "Wed 4 Nov 2026 10:42 AEDT" (Melbourne). */
export const melbourneStamp = (iso: string): string =>
  stampFmt.format(new Date(iso)).replace(/,/g, "").replace(/\s+/g, " ");

/** micro-AUD to "A$12.345" (three decimals, no float). */
export function priceText(micro: bigint): string {
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n) / 1_000n;
  return `A$${whole}.${String(frac).padStart(3, "0")}`;
}

// ---- deriving the unmailed transitions and building their facts --------------------------------------

const toRow = (x: Record<string, unknown>): AlertRow => ({
  alertId: String(x.alert_id),
  seq: Number(x.seq),
  userId: String(x.user_id),
  market: String(x.market),
  pickD: String(x.pick_d),
  profile: String(x.profile),
  rank: Number(x.rank),
  code: String(x.code),
  sessionD: String(x.session_d),
  state: String(x.state) as AlertStateName,
  limitMicro: BigInt(x.limit_micro as number),
  stopMicro: BigInt(x.stop_micro as number),
  at: String(x.at),
  hitMicro: x.hit_micro === null ? null : BigInt(x.hit_micro as number),
  quoteAt: x.quote_at === null ? null : String(x.quote_at),
  clearReason: x.clear_reason === null ? null : (String(x.clear_reason) as ClearReason),
});

/** Hit rows and mailed clears of the session that have no `pick_alert_mail` row at or after them. */
async function unmailed(db: Exec, c: MailerCtx): Promise<AlertRow[]> {
  const reasons = MAILED_CLEAR_REASONS.map((r) => `'${r}'`).join(",");
  const r = await db.execute({
    sql: `SELECT a.alert_id, a.seq, a.user_id, a.market, a.pick_d, a.profile, a.rank, a.code, a.session_d,
                 a.state, a.limit_micro, a.stop_micro, a.at, a.hit_micro, a.quote_at, a.clear_reason
          FROM pick_alert a
          WHERE a.market = ? AND a.session_d = ?
            AND (a.state = 'hit' OR (a.state = 'cleared' AND a.clear_reason IN (${reasons})))
            AND NOT EXISTS (SELECT 1 FROM pick_alert_mail m WHERE m.alert_id = a.alert_id AND m.at >= a.at)
          ORDER BY a.at, a.pick_d, a.profile, a.rank, a.seq`,
    args: [c.market, c.sessionD],
  });
  return r.rows.map(toRow);
}

async function pickInfo(db: Exec, t: AlertRow) {
  const r = await db.execute({
    sql: "SELECT label, size_micro, time_frame_sessions, created_at FROM pick WHERE market = ? AND d = ? AND profile = ? AND rank = ?",
    args: [t.market, t.pickD, t.profile, t.rank],
  });
  const x = r.rows[0];
  return {
    name: x ? String(x.label) : t.code,
    sizeMicro: x ? BigInt(x.size_micro as number) : 0n,
    timeFrame:
      x && x.time_frame_sessions !== null ? `${Number(x.time_frame_sessions)} sessions` : null,
    publishedAt: x ? melbourneStamp(String(x.created_at)) : melbourneStamp(`${t.pickD}T07:10:00Z`),
  };
}

async function latencyOf(db: Exec): Promise<Latency> {
  return {
    delayMin: await num(db, "intraday_quote_delay_min"),
    refreshMin: await num(db, "intraday_refresh_min"),
  };
}

/** The item (facts and line) of one stored transition. */
export async function itemOf(db: Exec, t: AlertRow): Promise<PickItem> {
  const info = await pickInfo(db, t);
  const quoteTime = melbourneStamp(t.quoteAt ?? t.at);
  if (t.state === "hit" && t.hitMicro !== null) {
    const distance = ((t.hitMicro - t.stopMicro) * 1000n) / t.hitMicro; // tenths of a percent
    const shares = t.limitMicro > 0n ? Number(info.sizeMicro / t.limitMicro) : 0;
    const parcel =
      info.sizeMicro > 0n && shares > 0
        ? { amount: priceText(info.sizeMicro).replace(/\.\d{3}$/, ""), shares }
        : null;
    return {
      alertId: t.alertId,
      event: "hit",
      hit: {
        alertId: t.alertId,
        code: t.code,
        name: info.name,
        publishedAt: info.publishedAt,
        limit: priceText(t.limitMicro),
        last: priceText(t.hitMicro),
        quoteTime,
        stop: priceText(t.stopMicro),
        stopDistancePct: `${distance / 10n}.${distance % 10n}%`,
        parcel,
        timeFrame: info.timeFrame,
      },
      line: { code: t.code, what: "Buy price hit", price: priceText(t.hitMicro), quoteTime },
    };
  }
  const below = t.clearReason === "below_stop";
  let capText: string | undefined;
  if (!below) {
    const cap = await num(db, "chase_cap_pct");
    capText = `${cap}% above the limit (${priceText((t.limitMicro * BigInt(Math.round(cap * 1000))) / 100_000n + t.limitMicro)})`;
  }
  return {
    alertId: t.alertId,
    event: below ? "below_stop" : "above_chase_cap",
    cleared: {
      alertId: t.alertId,
      code: t.code,
      name: info.name,
      variant: below ? "below_stop" : "above_chase_cap",
      limit: priceText(t.limitMicro),
      stop: priceText(t.stopMicro),
      last: null,
      quoteTime,
      capText,
    },
    line: {
      code: t.code,
      what: below ? "Cleared: fell under the stop" : "Cleared: ran above the limit",
      price: "n/a",
      quoteTime,
    },
  };
}

// ---- the mailer plugged into the poll ---------------------------------------------------------------------

/** `notify` mails the session's unmailed transitions per user; `digest` sends the held mail after quiet hours. */
export function createPickMailer(ctx: PickMailCtx): PickAlertMailer {
  return {
    notify: async (c: MailerCtx, _hint: readonly MailableTransition[]) => {
      void _hint; // a hint only: the unmailed rows are re-derived (state first, repaired next tick)
      const rows = await unmailed(c.db, c);
      if (rows.length === 0) return;
      const latency = await latencyOf(c.db);
      const byUser = new Map<string, AlertRow[]>();
      for (const t of rows) byUser.set(t.userId, [...(byUser.get(t.userId) ?? []), t]);
      for (const [userId, list] of byUser) {
        const items: PickItem[] = [];
        for (const t of list) items.push(await itemOf(c.db, t));
        await sendPickMail(
          { ...ctx, db: c.db, now: () => c.now },
          {
            kind: pickKindOf(items[0].event),
            userId,
            alertIds: items.map((i) => i.alertId),
            facts: { market: c.market, sessionD: c.sessionD, hhmm: c.slot, items, latency },
          },
        );
      }
    },
    digest: async (c: MailerCtx) => sendDigest({ ...ctx, db: c.db, now: () => c.now }, c),
  };
}

type Held = { alertId: string; key: string; userId: string; sessionD: string };

/** `held` rows that no later row with the same key has resolved. */
async function heldPending(db: Exec): Promise<Held[]> {
  const r = await db.execute(
    `SELECT m.alert_id, m.email_key FROM pick_alert_mail m
     WHERE m.status = 'held' AND m.email_key IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pick_alert_mail n WHERE n.alert_id = m.alert_id
                       AND n.email_key = m.email_key AND n.id > m.id)
     ORDER BY m.id`,
  );
  const out: Held[] = [];
  for (const x of r.rows) {
    const key = String(x.email_key);
    const m = /^pick(?:hit|clr):[0-9a-f]+:(\d{4}-\d{2}-\d{2})$/.exec(key);
    if (!m) continue;
    const a = await db.execute({
      sql: "SELECT user_id FROM pick_alert WHERE alert_id = ? LIMIT 1",
      args: [String(x.alert_id)],
    });
    if (!a.rows.length) continue;
    out.push({
      alertId: String(x.alert_id),
      key,
      userId: String(a.rows[0].user_id),
      sessionD: m[1],
    });
  }
  return out;
}

/**
 * Step 3 of every tick (D-388): after a user's quiet hours end, the first tick sends one
 * `pick_digest` for what was held today; held items of earlier sessions go to Evening Review.
 * Key-idempotent (`pickdg:<user>:<d>`): a second call sends nothing.
 */
export async function sendDigest(ctx: PickMailCtx, c: MailerCtx): Promise<void> {
  const held = await heldPending(c.db);
  if (held.length === 0) return;
  const at = c.now.toISOString();
  const d = melbourneDate(c.now);
  const env = emailEnvName(ctx.env);
  const byUser = new Map<string, Held[]>();
  for (const h of held) byUser.set(h.userId, [...(byUser.get(h.userId) ?? []), h]);
  const ownerOn = String(await getConfig(c.db as Client, "pick_alerts_default_owner")) === "on";
  for (const [userId, list] of byUser) {
    const prefs = await readPrefs(ctx.auth, userId, ownerOn);
    if (inQuietHours(c.now, prefs.quiet)) continue; // still quiet: keep holding
    const today = list.filter((h) => h.sessionD === c.sessionD);
    for (const h of list.filter((x) => x.sessionD !== c.sessionD)) {
      await writeMail(
        c.db,
        h.alertId,
        h.key.startsWith("pickhit") ? "pick_hit" : "pick_cleared",
        h.key,
        "held_to_review",
        at,
      );
    }
    if (today.length === 0) continue;
    const items: PickItem[] = [];
    const rows = await alertRows(
      c.db,
      today.map((h) => h.alertId),
    );
    for (const h of today) {
      const t = rows.find(
        (r) =>
          r.alertId === h.alertId &&
          (r.state === "hit"
            ? emailKeys.pickHit(r.alertId, r.sessionD)
            : emailKeys.pickCleared(r.alertId, r.sessionD)) === h.key,
      );
      if (t) items.push(await itemOf(c.db, t));
    }
    if (items.length === 0) continue;
    const digestKey = emailKeys.pickDigest(userId, c.sessionD);
    const mark = async (status: MailStatus) => {
      for (const h of today) {
        await writeMail(c.db, h.alertId, "pick_digest", h.key, status, at);
      }
    };
    if ((await pickCapRemaining(c.db, env, d)) < 1) {
      await recordRow(c.db, {
        key: digestKey,
        kind: "pick_digest",
        env,
        d,
        slot: "pool",
        status: "suppressed_cap",
        nowIso: at,
      });
      await mark("suppressed_cap");
      continue;
    }
    const q = prefs.quiet;
    const out = await sendEmail(ctx, "pick_digest", digestKey, {
      quietWindow: q ? `${q.start}-${q.end}` : "earlier",
      lines: items.map((i) => i.line),
      latency: await latencyOf(c.db),
    });
    if (out.status === "pending") continue;
    await mark(
      out.status === "sent" || out.status === "duplicate"
        ? "sent"
        : out.status === "suppressed_cap"
          ? "suppressed_cap"
          : "off",
    );
  }
}

async function alertRows(db: Exec, alertIds: string[]): Promise<AlertRow[]> {
  const out: AlertRow[] = [];
  for (const id of new Set(alertIds)) {
    const r = await db.execute({
      sql: `SELECT alert_id, seq, user_id, market, pick_d, profile, rank, code, session_d, state, limit_micro,
                   stop_micro, at, hit_micro, quote_at, clear_reason FROM pick_alert
            WHERE alert_id = ? AND state <> 'armed' ORDER BY seq`,
      args: [id],
    });
    for (const x of r.rows) {
      out.push(toRow(x));
    }
  }
  return out;
}
