// Alert creation and P0 delivery (M5 T6; AGT-115, EML-020, EML-022, NFR-012; docs/M5_design.md 4.3;
// D-096 decisions 9, 24, 27, 40; D-101).
//
//  - `raiseAnnouncementAlerts` turns assessed announcements (item_assessment, written by the Sentinel
//    ingest) into `alert` rows, idempotently by alert key (INSERT ... ON CONFLICT DO NOTHING, so a
//    repeated feed or a repeated call never writes or emails twice). Tier = tiers.ts.
//  - `deliverP0` sends the P0 email: the FIRST P0 at once through `sendEmail` (key p0:<alert_key>);
//    a P0 that arrives within `p0_batch_window_min` of the last P0 email is left pending and
//    `worker_state.alert_flush_due` is set to the window end; `flushAlerts` (flush.ts) then sends
//    one `p0b:<first key>` email for all of them. Caps, the production switch, the recipient and
//    retries are the email core's (T3): this module only decides WHICH email and WHEN.
//  - P1/P2 are never emailed (decision 9): they are rows for the inbox and the review section 8.
//  - R1 wording (optional, in-app only) is requested AFTER the emails and stored once; it changes no
//    tier, no materiality and no email byte (AGT-011a).
// Nothing here logs; the facts are template fields only (no model text reaches an email).
import type { Client, InStatement } from "@libsql/client";
import { safeSourceUrl } from "@/lib/http/safeLink";
import { getConfig } from "@/lib/config/store";
import { ASX_SOURCE } from "@/lib/data/asxToken";
import { emailKeys, melbourneDate } from "@/lib/email/keys";
import type { EmailEnvVars, EmailProvider } from "@/lib/email/provider";
import { emailEnvName, sendEmail, type SendOutcome, type SendStatus } from "@/lib/email/send";
import type { P0AlertFacts } from "@/lib/email/templates/alerts";
import { formatMelbourne } from "@/lib/health/format";
import type { LlmRouter } from "@/lib/llm/router";
import type { AlertKind, AlertRow, AlertTier } from "@/lib/sentinel/schema";
import {
  alertKeys,
  categoryLabel,
  categoryOf,
  ppmToPct,
  rulesText,
  thresholdPpm,
  tierForAnnouncement,
  weightPpm,
  whyText,
  type AlertFacts,
  type Holder,
} from "./tiers";

export const FLUSH_DUE_KEY = "alert_flush_due";
export const MARKET = "AU";
/** A P0 older than this is no longer emailed (a late "critical" mail is worse than none). */
export const P0_PENDING_MAX_MIN = 30; // threshold-ok: delivery freshness bound, D-101
/** Announcements first assessed longer ago than this raise no alert (the backfill, not news). */
export const RAISE_WINDOW_H = 48; // threshold-ok: same carry window as the Sentinel ingest
const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
export const ASX_FALLBACK_URL =
  "https://www.asx.com.au/markets/trade-our-cash-market/announcements";

export type AlertCtx = {
  db: Client;
  env: EmailEnvVars;
  now?: () => Date;
  provider?: EmailProvider;
  sleep?: (ms: number) => Promise<void>;
  /** R1 router; null or absent = rules text only, nothing is stored (decision 21). */
  router?: LlmRouter | null;
};

export const nowOf = (c: { now?: () => Date }): Date => (c.now ?? (() => new Date()))();

const sendCtx = (c: AlertCtx) => ({
  db: c.db,
  env: c.env,
  now: c.now,
  provider: c.provider,
  sleep: c.sleep,
});

const toBig = (v: unknown): bigint => {
  try {
    return typeof v === "bigint" ? v : BigInt(Math.trunc(Number(v ?? 0)));
  } catch {
    return 0n;
  }
};

// ---- holders ------------------------------------------------------------------------------------

/**
 * Live E-execution holders of each code with the weight inputs: the position value at the cohort's
 * latest NAV date and that NAV (raw close x qty over NAV, the stored end-of-day snapshot). A holder
 * with no snapshot yet has value 0 / nav 0, so it never meets the weight.
 */
export async function loadHolders(
  db: Pick<Client, "execute">,
  market: string,
  codes: readonly string[],
): Promise<Map<string, Holder[]>> {
  const out = new Map<string, Holder[]>();
  if (codes.length === 0) return out;
  const r = await db.execute({
    sql:
      "SELECT DISTINCT t.code AS code, e.id AS eid, e.family AS fam, e.variant AS var, " +
      "COALESCE(p.value_micro, 0) AS value_micro, COALESCE(n.nav_micro, 0) AS nav_micro " +
      "FROM trade t JOIN cohort c ON c.id = t.cohort_id AND c.live = 1 " +
      "JOIN execution e ON e.id = c.execution_id AND e.kind = 'E' AND e.market = ? " +
      "JOIN market m ON m.code = e.market AND m.mode = 'full' " +
      "LEFT JOIN nav_daily n ON n.cohort_id = c.id AND n.d = " +
      "(SELECT MAX(d) FROM nav_daily WHERE cohort_id = c.id) " +
      "LEFT JOIN nav_daily_pos p ON p.cohort_id = c.id AND p.d = n.d AND p.code = t.code " +
      `WHERE t.exit_type IS NULL AND t.code IN (${codes.map(() => "?").join(",")}) ` +
      "ORDER BY t.code, e.id",
    args: [market, ...codes],
  });
  for (const row of r.rows) {
    const code = String(row.code);
    const list = out.get(code) ?? [];
    list.push({
      executionId: String(row.eid),
      label: `${String(row.fam ?? "")} ${String(row.var ?? "")}`.trim(),
      valueMicro: toBig(row.value_micro),
      navMicro: toBig(row.nav_micro),
    });
    out.set(code, list);
  }
  return out;
}

// ---- raising alerts -----------------------------------------------------------------------------

type Pending = {
  annId: string;
  code: string;
  materiality: 0 | 1 | 2 | 3;
  held: boolean;
  watch: boolean;
  title: string;
  type: string | null;
  url: string | null;
  publishedAt: string;
};

export type RaiseResult = {
  created: number;
  p0Keys: string[];
  /** P0 and P1 keys created now (the ones that get optional R1 wording). */
  wordKeys: string[];
  p1: number;
  p2: number;
};

const safeUrl = (u: string | null | undefined): string =>
  (typeof u === "string" && u.length <= 500 ? safeSourceUrl(u) : null) ?? ASX_FALLBACK_URL;

export async function raiseAnnouncementAlerts(
  ctx: AlertCtx,
  o: { market?: string; limit?: number } = {},
): Promise<RaiseResult> {
  const market = o.market ?? MARKET;
  const now = nowOf(ctx);
  const nowIso = now.toISOString();
  const since = new Date(now.getTime() - RAISE_WINDOW_H * HOUR_MS).toISOString();
  const res: RaiseResult = { created: 0, p0Keys: [], wordKeys: [], p1: 0, p2: 0 };

  const q = await ctx.db.execute({
    sql:
      "SELECT s.ann_id AS ann_id, s.code AS code, s.materiality AS materiality, s.held AS held, " +
      "s.watch AS watch, a.title AS title, a.type AS type, a.url AS url, a.published_at AS published_at " +
      "FROM item_assessment s JOIN announcement a ON a.source = s.source AND a.ann_id = s.ann_id " +
      "WHERE s.source = ? AND s.market = ? AND s.materiality >= 1 AND s.assessed_at >= ? " +
      "AND NOT EXISTS (SELECT 1 FROM alert x WHERE x.alert_key = 'ann:' || s.market || ':' || s.source || ':' || s.ann_id) " +
      "ORDER BY a.published_at ASC, s.ann_id ASC LIMIT ?",
    args: [ASX_SOURCE, market, since, o.limit ?? 200],
  });
  if (q.rows.length === 0) return res;
  const items: Pending[] = q.rows.map((r) => ({
    annId: String(r.ann_id),
    code: String(r.code),
    materiality: Number(r.materiality) as Pending["materiality"],
    held: Number(r.held) === 1,
    watch: Number(r.watch) === 1,
    title: String(r.title),
    type: r.type === null ? null : String(r.type),
    url: r.url === null ? null : String(r.url),
    publishedAt: String(r.published_at),
  }));

  const rawW = await getConfig(ctx.db, "alert_p0_weight", market);
  const thr = thresholdPpm(typeof rawW === "number" ? rawW : 0.1);
  const heldCodes = [...new Set(items.filter((i) => i.held).map((i) => i.code))];
  const holders = await loadHolders(ctx.db, market, heldCodes);

  const stmts: InStatement[] = [];
  const keys: { key: string; tier: AlertTier }[] = [];
  for (const it of items) {
    const category = categoryOf(it.type, it.title);
    const hs = it.held ? (holders.get(it.code) ?? []) : [];
    const d = tierForAnnouncement({
      kind: "announcement",
      category,
      materiality: it.materiality,
      held: it.held,
      watch: it.watch,
      holders: hs,
      thresholdPpm: thr,
    });
    if (d === null) continue;
    const key = alertKeys.announcement(market, ASX_SOURCE, it.annId);
    const facts: AlertFacts = {
      source: ASX_SOURCE,
      annId: it.annId,
      title: it.title,
      type: it.type ?? categoryLabel(category),
      url: safeUrl(it.url),
      category,
      rule: d.rule,
      why: whyText(d, category, thr),
      executions: hs.map((h) => ({
        id: h.executionId,
        label: h.label,
        weightPct: ppmToPct(weightPpm(h)),
      })),
    };
    stmts.push({
      sql:
        "INSERT INTO alert (alert_key, market, code, kind, tier, execution_id, weight_ppm, materiality, " +
        "published_at, detected_at, facts_json) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
      args: [
        key,
        market,
        it.code,
        d.kind,
        d.tier,
        d.holder?.executionId ?? null,
        d.weightPpm,
        it.materiality,
        it.publishedAt,
        nowIso,
        JSON.stringify(facts),
      ],
    });
    keys.push({ key, tier: d.tier });
  }
  if (stmts.length === 0) return res;
  const written = await ctx.db.batch(stmts, "write");
  written.forEach((w, i) => {
    if (w.rowsAffected !== 1) return; // a duplicate: never counted, never emailed again
    res.created += 1;
    const { key, tier } = keys[i];
    if (tier !== "P2") res.wordKeys.push(key);
    if (tier === "P0") res.p0Keys.push(key);
    else if (tier === "P1") res.p1 += 1;
    else res.p2 += 1;
  });
  return res;
}

// ---- reading an alert for delivery --------------------------------------------------------------

export function parseFacts(json: string): AlertFacts {
  try {
    const v = JSON.parse(json) as Partial<AlertFacts> | null;
    if (v && typeof v === "object") {
      return { rule: "", why: "", executions: [], ...v } as AlertFacts;
    }
  } catch {
    // fall through
  }
  return { rule: "", why: "", executions: [] };
}

export async function readAlert(
  db: Pick<Client, "execute">,
  key: string,
): Promise<AlertRow | null> {
  const r = await db.execute({ sql: "SELECT * FROM alert WHERE alert_key = ?", args: [key] });
  return r.rows.length ? (r.rows[0] as unknown as AlertRow) : null;
}

/** Template facts of a P0 email (EML-022): what happened, why, source link, Melbourne time. */
export function p0Facts(
  a: Pick<AlertRow, "alert_key" | "code" | "published_at" | "detected_at">,
  f: AlertFacts,
): P0AlertFacts {
  return {
    alertKey: a.alert_key,
    code: a.code ?? "n/a",
    title: f.title ?? "Announcement",
    type: f.type ?? "Announcement",
    why: f.why || "Critical alert (P0 rule).",
    executions: f.executions.map((e) => ({
      id: e.id,
      label: e.label || e.id,
      weightPct: e.weightPct,
    })),
    sourceUrl: safeUrl(f.url),
    time: formatMelbourne(a.published_at ?? a.detected_at),
  };
}

// ---- P0 delivery --------------------------------------------------------------------------------

export async function windowMinutes(db: Client): Promise<number> {
  const raw = await getConfig(db, "p0_batch_window_min");
  return typeof raw === "number" && raw >= 1 ? raw : 5;
}

/** When the last P0 email (single or batch) was accepted or is in flight, else null. */
export async function lastP0EmailAt(ctx: AlertCtx): Promise<Date | null> {
  const r = await ctx.db.execute({
    sql:
      "SELECT MAX(COALESCE(sent_at, created_at)) AS t FROM email_message " +
      "WHERE env = ? AND kind IN ('p0','p0_batch') AND status IN ('claimed','sent')",
    args: [emailEnvName(ctx.env)],
  });
  const t = r.rows[0]?.t;
  return typeof t === "string" ? new Date(t) : null;
}

/** The window end of the last P0 email if it is still in the future, else null. */
export async function openWindowEnd(ctx: AlertCtx): Promise<Date | null> {
  const last = await lastP0EmailAt(ctx);
  if (last === null) return null;
  const end = new Date(last.getTime() + (await windowMinutes(ctx.db)) * MIN_MS);
  return end.getTime() > nowOf(ctx).getTime() ? end : null;
}

export async function readFlushDue(db: Pick<Client, "execute">): Promise<Date | null> {
  const r = await db.execute({
    sql: "SELECT value_json FROM worker_state WHERE key = ?",
    args: [FLUSH_DUE_KEY],
  });
  if (!r.rows.length) return null;
  try {
    const v: unknown = JSON.parse(String(r.rows[0].value_json));
    const t = typeof v === "string" ? Date.parse(v) : NaN;
    return Number.isFinite(t) ? new Date(t) : null;
  } catch {
    return null;
  }
}

/** Sets the flush time to `due` unless an earlier, still-future one is already set. */
export async function scheduleFlush(ctx: AlertCtx, due: Date): Promise<Date> {
  const now = nowOf(ctx);
  const cur = await readFlushDue(ctx.db);
  const next =
    cur !== null && cur.getTime() > now.getTime() && cur.getTime() <= due.getTime() ? cur : due;
  await ctx.db.execute({
    sql:
      "INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
    args: [FLUSH_DUE_KEY, JSON.stringify(next.toISOString()), now.toISOString()],
  });
  return next;
}

export async function clearFlushDue(db: Pick<Client, "execute">): Promise<void> {
  await db.execute({ sql: "DELETE FROM worker_state WHERE key = ?", args: [FLUSH_DUE_KEY] });
}

export const RETRY_DUE_MS = 60_000; // the email core's retry gap (RETRY_GAP_S)

/** Statuses after which the alert is "handled" (sent, owned by another sender, capped, failed). */
const FINAL: ReadonlySet<SendStatus> = new Set(["sent", "duplicate", "suppressed_cap", "failed"]);

export async function markEmailed(
  db: Pick<Client, "execute">,
  alertKeys_: readonly string[],
  emailKey: string,
): Promise<void> {
  for (const k of alertKeys_) {
    await db.execute({
      sql: "UPDATE alert SET email_key = ? WHERE alert_key = ? AND email_key IS NULL",
      args: [emailKey, k],
    });
  }
}

/** Same code and announcement under another source already emailed: never email twice. */
async function emailedElsewhere(db: Pick<Client, "execute">, a: AlertRow): Promise<string | null> {
  const parts = a.alert_key.split(":");
  if (parts[0] !== "ann" || parts.length < 4 || a.code === null) return null;
  const annId = parts.slice(3).join(":");
  const r = await db.execute({
    sql:
      "SELECT email_key FROM alert WHERE code = ? AND alert_key <> ? AND alert_key LIKE 'ann:%' " +
      "AND substr(alert_key, length(alert_key) - length(?) + 1) = ? AND email_key IS NOT NULL LIMIT 1",
    args: [a.code, a.alert_key, annId, annId],
  });
  return r.rows.length ? String(r.rows[0].email_key) : null;
}

export type P0Result = { key: string; action: "sent" | "batched" | "skipped"; status?: SendStatus };

/** One single-alert P0 email (key p0:<alert_key>), then the alert row is marked if final. */
export async function sendSingleP0(ctx: AlertCtx, a: AlertRow): Promise<SendOutcome> {
  const key = emailKeys.p0(a.alert_key);
  const out = await sendEmail(sendCtx(ctx), "p0", key, {
    alert: p0Facts(a, parseFacts(a.facts_json)),
  });
  if (FINAL.has(out.status)) await markEmailed(ctx.db, [a.alert_key], key);
  return out;
}

/**
 * Delivery decision for new P0 alerts, in detection order: the first goes out at once when no P0
 * email was sent inside the window; any later one inside the window stays pending and the flush
 * is scheduled for the window end (decision 40).
 */
export async function deliverP0(ctx: AlertCtx, keys: readonly string[]): Promise<P0Result[]> {
  const results: P0Result[] = [];
  for (const key of keys) {
    const a = await readAlert(ctx.db, key);
    if (a === null || a.tier !== "P0" || a.email_key !== null) {
      results.push({ key, action: "skipped" });
      continue;
    }
    const other = await emailedElsewhere(ctx.db, a);
    if (other !== null) {
      await markEmailed(ctx.db, [key], other);
      results.push({ key, action: "skipped", status: "duplicate" });
      continue;
    }
    const end = await openWindowEnd(ctx);
    if (end === null) {
      const out = await sendSingleP0(ctx, a);
      // V1-S9 (D-693): a first-of-window P0 left `pending` is retried by the flush (claimed singles).
      if (out.status === "pending") {
        await scheduleFlush(ctx, new Date(nowOf(ctx).getTime() + RETRY_DUE_MS));
      }
      results.push({ key, action: "sent", status: out.status });
    } else {
      await scheduleFlush(ctx, end);
      results.push({ key, action: "batched" });
    }
  }
  return results;
}

// ---- R1 wording (in-app only) -------------------------------------------------------------------

export const R1_TEMPLATE = "alert-text-v1";
const R1_TASK =
  "Write one plain sentence (at most 40 words) for an investor's alert inbox saying what happened " +
  'and why it matters. Reply as JSON {"text": "..."}. Use only facts given.';

export type R1Text = { text: string; llm: boolean };

/**
 * Alert wording through the single router (LLM-030). In rules-only/off mode, or with no router, the
 * answer is the rules text (never stored as model text). A mock/live answer is grounded by the
 * router (LLM-034) and stored once in `alert.text_llm`. Never throws; changes nothing else.
 */
export async function r1AlertText(
  router: LlmRouter | null | undefined,
  a: Pick<AlertRow, "alert_key" | "code" | "tier" | "kind" | "market" | "weight_ppm">,
  facts: AlertFacts,
  d: string,
): Promise<R1Text> {
  const rules = rulesText(a.tier, a.kind as AlertKind, a.code, facts);
  if (!router) return { text: rules, llm: false };
  try {
    const r = await router.route<{ text: string }>({
      role: "R1",
      market: a.market,
      d,
      templateVersion: R1_TEMPLATE,
      task: R1_TASK,
      facts: {
        code: a.code,
        tier: a.tier,
        kind: a.kind,
        rule: facts.rule,
        why: facts.why,
        executions: facts.executions,
      },
      untrusted: facts.title ? [facts.title] : [],
      parse: (v) =>
        v !== null &&
        typeof v === "object" &&
        typeof (v as { text?: unknown }).text === "string" &&
        (v as { text: string }).text.trim().length > 0 &&
        (v as { text: string }).text.length <= 400
          ? { text: (v as { text: string }).text.trim() }
          : null,
      rules: { text: rules },
      maxOutputTokens: 120,
    });
    return { text: r.value.text, llm: r.llmUsed };
  } catch {
    return { text: rules, llm: false };
  }
}

/** Stores R1 text for the given alerts once (NULL -> value). Failures are ignored. */
export async function attachR1Text(ctx: AlertCtx, keys: readonly string[]): Promise<number> {
  if (!ctx.router) return 0;
  let stored = 0;
  const d = melbourneDate(nowOf(ctx));
  for (const key of keys) {
    try {
      const a = await readAlert(ctx.db, key);
      if (a === null || a.text_llm !== null) continue;
      const t = await r1AlertText(ctx.router, a, parseFacts(a.facts_json), d);
      if (!t.llm) continue;
      const w = await ctx.db.execute({
        sql: "UPDATE alert SET text_llm = ? WHERE alert_key = ? AND text_llm IS NULL",
        args: [t.text, key],
      });
      stored += w.rowsAffected;
    } catch {
      // wording is optional
    }
  }
  return stored;
}

// ---- the full step run by the ingest route and by the flush ------------------------------------

export type ProcessResult = RaiseResult & { p0: P0Result[]; r1: number };

/** Raise alerts for fresh assessments, send P0 (immediate or batched), then optional R1 text. */
export async function processAssessments(ctx: AlertCtx): Promise<ProcessResult> {
  const raised = await raiseAnnouncementAlerts(ctx);
  const p0 = await deliverP0(ctx, raised.p0Keys);
  const r1 = await attachR1Text(ctx, raised.wordKeys);
  return { ...raised, p0, r1 };
}
