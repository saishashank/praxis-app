// Evening Review send loop (M5 T10; docs/M5_design.md 4.6 item 3; EML-010/011/036, NFR-006, AT-20;
// D-096 decisions 5, 12, 33; D-104, D-099). One call per Worker slot tick or watchdog run, for one
// Melbourne review date d. The call is idempotent: the email key `review:<d>` is shared by every
// path (slot, partial, late, the watchdog's route call and its direct minimal fallback), so the
// Owner gets at most one review email per date.
//
// States (the route answers with one of them):
//   waiting         inputs incomplete and the time is before `partial_at` (or before the send time):
//                   nothing is stored, nothing is sent; the next tick looks again;
//   sent            the email went out (full, or partial with the missing-sections box; after
//                   `send_by` it is late: counted for NFR-003 in section 9, never an incident);
//   already_sent    the key was already sent: the newest version is stored again if the facts
//                   changed, no email;
//   complete_later  a partial was sent earlier and the complete version is stored now (no email);
//   paused / no_recipient / suppressed_off / suppressed_cap   stored in-app, the email core records why;
//   failed / pending   the provider failed (retried by a later tick) - answered with ok false.
// A review stored in-app is never lost: every state except `waiting` leaves a version row.
//
// Unread tracking (EML-036): three unread earlier days put "UNREAD 3 DAYS" in the subject (the facts
// carry `unreadDays`); at seven the one `review_unread_7` incident opens (S3, in-app) and the single
// `unread7:<d>` email goes out when that incident is newly opened. Only a review that was actually
// sent counts, so a switched-off mailbox opens no incident. The incident closes once the streak falls
// below seven.
import type { Client } from "@libsql/client";
import { getConfig } from "@/lib/config/store";
import { emailKeys, melbourneDate } from "@/lib/email/keys";
import { LiveSendBlockedError, type EmailEnvVars, type EmailProvider } from "@/lib/email/provider";
import { emailEnvName, sendEmail, type SendOutcome } from "@/lib/email/send";
import type { EnvName } from "@/lib/email/templates/core";
import { notifyIncident } from "@/lib/incidents/notify";
import {
  assembleReview,
  buildFacts,
  loadReview,
  type BuiltFacts,
  type StoredReview,
} from "./assemble";
import type { StoredKind } from "./facts";

export const UNREAD_INCIDENT_KIND = "review_unread_7";
export const UNREAD_INCIDENT_DAYS = 7;
export const MARKET = "AU";

export type ReviewSendStatus =
  | "waiting"
  | "sent"
  | "already_sent"
  | "complete_later"
  | "paused"
  | "no_recipient"
  | "suppressed_off"
  | "suppressed_cap"
  | "failed"
  | "pending";

export interface ReviewSendCtx {
  db: Client;
  env: EmailEnvVars;
  now?: () => Date;
  provider?: EmailProvider;
  sleep?: (ms: number) => Promise<void>;
}

export interface ReviewSendResult {
  /** False only for `failed` and `pending` (the provider did not take the mail). */
  ok: boolean;
  status: ReviewSendStatus;
  d: string;
  kind: StoredKind | null;
  version: number | null;
  /** The email (sent now or earlier) is the partial one with the missing-sections box. */
  partial: boolean;
  /** Sent after `send_by` (NFR-003 lateness; not an incident, decision 33). */
  late: boolean;
  attempts: number;
  reason?: string;
  unread: { days: number; incident: "opened" | "open" | "closed" | "none" };
}

type Hm = { start: number; partial: number; by: number };

const HM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
function minutesOf(v: unknown, fallback: number): number {
  const m = typeof v === "string" ? HM_RE.exec(v) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : fallback;
}

const minuteFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Australia/Melbourne",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Minutes since local midnight in Melbourne (DST follows the zone, never a fixed offset). */
export function melbourneMinute(at: Date): number {
  const p = Object.fromEntries(minuteFmt.formatToParts(at).map((x) => [x.type, x.value]));
  return Number(p.hour) * 60 + Number(p.minute);
}

async function readTimes(db: Client): Promise<Hm> {
  const get = async (k: "evening_review_time" | "partial_at" | "send_by", fb: number) => {
    try {
      return minutesOf(await getConfig(db, k), fb);
    } catch {
      return fb;
    }
  };
  return {
    start: await get("evening_review_time", 20 * 60),
    partial: await get("partial_at", 20 * 60 + 30),
    by: await get("send_by", 20 * 60 + 45),
  };
}

const FINAL = new Set(["sent", "failed", "suppressed_cap"]);

async function keyStatus(db: Client, key: string): Promise<string | null> {
  const r = await db.execute({
    sql: "SELECT status FROM email_message WHERE email_key = ?",
    args: [key],
  });
  return r.rows.length ? String(r.rows[0]!.status) : null;
}

/** True when the sent email of the key was the partial one (the newest version at send time). */
async function sentWasPartial(db: Client, d: string): Promise<boolean> {
  const r = await db.execute({
    sql: `SELECT e.kind FROM evening_review e
          WHERE e.d = ? AND e.created_at <= COALESCE(
            (SELECT sent_at FROM email_message WHERE email_key = ?), e.created_at)
          ORDER BY e.version DESC LIMIT 1`,
    args: [d, emailKeys.review(d)],
  });
  return r.rows.length > 0 && String(r.rows[0]!.kind) === "partial";
}

function mapOutcome(o: SendOutcome): ReviewSendStatus {
  switch (o.status) {
    case "sent":
      return "sent";
    case "duplicate":
      return o.reason === "claimed" ? "pending" : "already_sent";
    case "suppressed_paused":
      return "paused";
    case "no_recipient":
      return "no_recipient";
    case "suppressed_cap":
      return "suppressed_cap";
    case "suppressed_off":
      return "suppressed_off";
    case "pending":
      return "pending";
    case "failed":
      return "failed";
    default:
      throw new Error("review send: invalid key");
  }
}

async function unreadDates(db: Client, d: string, days: number): Promise<string[]> {
  const r = await db.execute({
    sql: `SELECT DISTINCT e.d AS d FROM evening_review e
          WHERE e.d < ? AND NOT EXISTS (SELECT 1 FROM review_read rr WHERE rr.d = e.d)
          ORDER BY e.d DESC LIMIT ?`,
    args: [d, Math.max(days, 1)],
  });
  return r.rows.map((x) => String(x.d));
}

async function unreadStep(
  ctx: ReviewSendCtx,
  d: string,
  days: number,
): Promise<ReviewSendResult["unread"]> {
  if (days < UNREAD_INCIDENT_DAYS) {
    const r = await ctx.db.execute({
      sql: "UPDATE incident SET resolved_at = ? WHERE kind = ? AND resolved_at IS NULL",
      args: [(ctx.now ?? (() => new Date()))().toISOString(), UNREAD_INCIDENT_KIND],
    });
    return { days, incident: r.rowsAffected > 0 ? "closed" : "none" };
  }
  const note = await notifyIncident({ db: ctx.db, now: ctx.now }, UNREAD_INCIDENT_KIND, "S3", {
    summary: `No Evening Review marked read for ${days} days`,
    detail: { days, d },
  });
  if (!note.opened) return { days, incident: "open" };
  const dates = await unreadDates(ctx.db, d, days);
  try {
    await sendEmail(
      { db: ctx.db, env: ctx.env, now: ctx.now, provider: ctx.provider, sleep: ctx.sleep },
      "unread7",
      emailKeys.unread7(d),
      { date: d, days, unreadDates: dates },
    );
  } catch (e) {
    // a blocked live send in a test run must surface; any other failure leaves the incident row
    if (e instanceof LiveSendBlockedError) throw e;
  }
  return { days, incident: "opened" };
}

/** Every expected input is there (a non-trading day also needs its marker, decision 5). */
const isComplete = (b: BuiltFacts): boolean =>
  b.missing.length === 0 && !(b.variant === "nonTrading" && !b.markerPresent);

const templateEnv = (e: ReturnType<typeof emailEnvName>): EnvName =>
  e === "staging" ? "staging" : "production";

/**
 * Runs the send loop once for review date `d`. Throws only on a database error (the route answers
 * 503 and the next tick or the watchdog tries again).
 */
export async function runReviewSend(ctx: ReviewSendCtx, d: string): Promise<ReviewSendResult> {
  const { db, env } = ctx;
  const now = (ctx.now ?? (() => new Date()))();
  const key = emailKeys.review(d);
  const base: ReviewSendResult = {
    ok: true,
    status: "waiting",
    d,
    kind: null,
    version: null,
    partial: false,
    late: false,
    attempts: 0,
    unread: { days: 0, incident: "none" },
  };

  const appUrl = (env.APP_BASE_URL ?? "").trim();
  if (!/^https?:\/\//.test(appUrl)) {
    return { ...base, status: "suppressed_off", reason: "no_app_url" };
  }
  const today = melbourneDate(now);
  const minute = melbourneMinute(now);
  const lateDay = d < today; // a send that finishes after midnight keeps its date
  const t = await readTimes(db);
  const prior = await keyStatus(db, key);
  const final = prior !== null && FINAL.has(prior);

  if (!final && !lateDay && minute < t.start) return { ...base, reason: "early" };

  const o = {
    market: MARKET,
    d,
    env: templateEnv(emailEnvName(env)),
    appUrl,
    now,
  };
  if (final) {
    // The email is decided. Later calls only keep the complete version in the app (EML-011) when
    // the sent one was the partial; otherwise nothing more is built or stored.
    const newest = await loadReview(db, d);
    const wasPartial = prior === "sent" ? await sentWasPartial(db, d) : false;
    const have = newest !== null && (newest.kind === "full" || newest.kind === "non_trading");
    let latest: StoredReview | null = newest;
    let created = false;
    if (prior === "sent" && !have) {
      // Only a partial or the watchdog's minimal mail went out: keep the best version in the app.
      const again = await buildFacts(db, o);
      if (isComplete(again) || newest === null) {
        latest = await assembleReview(db, { ...o, built: again });
        created = latest.created && (latest.kind === "full" || latest.kind === "non_trading");
      }
    }
    const shown = { ...base, kind: latest?.kind ?? null, version: latest?.version ?? null };
    if (prior === "sent") {
      return { ...shown, status: created ? "complete_later" : "already_sent", partial: wasPartial };
    }
    return {
      ...shown,
      ok: false,
      status: prior === "failed" ? "failed" : "suppressed_cap",
      reason: "key_consumed",
    };
  }

  const built: BuiltFacts = await buildFacts(db, o);
  if (!isComplete(built) && !lateDay && minute < t.partial) {
    return { ...base, reason: "inputs_missing" };
  }

  const stored: StoredReview & { facts: BuiltFacts["facts"] } = await assembleReview(db, {
    ...o,
    built,
  });
  const late = lateDay || minute >= t.by;
  const common = { ...base, kind: stored.kind, version: stored.version };

  const out = await sendEmail(
    { db, env, now: ctx.now, provider: ctx.provider, sleep: ctx.sleep },
    "review",
    key,
    stored.facts,
  );
  const status = mapOutcome(out);
  if (out.authFailure) {
    // 401/403 from the provider: one in-app incident (NFR-006); its own mail may fail again.
    await notifyIncident(
      { db, env, now: ctx.now, provider: ctx.provider, sleep: ctx.sleep },
      "provider_auth",
      "S2",
      { summary: "The email provider refused our key (401/403)" },
      false,
    );
  }
  const res: ReviewSendResult = {
    ...common,
    ok: status !== "failed" && status !== "pending",
    status,
    partial: stored.kind === "partial",
    late: status === "sent" && late,
    attempts: out.attempts,
    ...(out.reason !== undefined ? { reason: out.reason } : {}),
  };
  if (status === "sent") {
    res.unread = await unreadStep(ctx, d, built.facts.unreadDays ?? 0);
  }
  return res;
}
