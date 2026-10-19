// Production email switch (M5 T2, docs/M5_design.md 4.12, D-096 decision 1; BLD-024).
//
// BLD-024 (spec 12 l.62): "From M2 the production deployment runs ... with the Arena, emails and
// decision agents (A2–A8) disabled". M5 puts the emails behind one Owner control, `email_mode`:
//   off        (default) nothing is sent; every send path records `suppressed_off`;
//   incidents  incident, tokens-due, unread-7-days, DB-down and watchdog-fallback emails only;
//   full       everything. Refused while any market is data-only, i.e. until go-live.
// plus a one-off `email_review_test_date` (a Melbourne date d, only with `incidents`): the review
// check and the email `review:<d>` run for that one date, and the setting expires after d. This is
// the forced watchdog run of TST-115.
//
// Both live in `worker_state` (like dispatch_enabled): one small read for the Worker and the routes.
// A missing, unreadable or unknown value is `off` (fail closed). The env flag
// EMAIL_PROVIDER=resend must also be set for a real send (design 4.12); that is T3.
import type { Client } from "@libsql/client";
import type { EmailKind } from "@/lib/sentinel/schema";

export const EMAIL_MODE_KEY = "email_mode";
export const EMAIL_REVIEW_TEST_DATE_KEY = "email_review_test_date";

export const EMAIL_MODES = ["off", "incidents", "full"] as const;
export type EmailMode = (typeof EMAIL_MODES)[number];

export const isEmailMode = (v: unknown): v is EmailMode =>
  typeof v === "string" && (EMAIL_MODES as readonly string[]).includes(v);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date written YYYY-MM-DD. */
export function isRealDate(v: unknown): v is string {
  if (typeof v !== "string" || !DATE_RE.test(v)) return false;
  const t = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === v;
}

/** The stored value is a JSON string; anything else reads as absent. */
function parseText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

export type EmailSwitch = {
  mode: EmailMode;
  /** The one-off date, only while the mode is `incidents` and the date has not passed. */
  reviewTestDate: string | null;
};

/**
 * Reads the switch. `today` is the Melbourne date; a test date before today has expired and reads
 * as null. A test date with any mode but `incidents` is ignored. Throws on a database error (the
 * caller decides; senders treat a throw as `off`).
 */
export async function readEmailSwitch(
  db: Pick<Client, "execute">,
  today: string,
): Promise<EmailSwitch> {
  const r = await db.execute({
    sql: "SELECT key, value_json FROM worker_state WHERE key IN (?, ?)",
    args: [EMAIL_MODE_KEY, EMAIL_REVIEW_TEST_DATE_KEY],
  });
  const byKey = new Map(r.rows.map((x) => [String(x.key), x.value_json]));
  const rawMode = parseText(byKey.get(EMAIL_MODE_KEY));
  const mode: EmailMode = isEmailMode(rawMode) ? rawMode : "off";
  const rawDate = parseText(byKey.get(EMAIL_REVIEW_TEST_DATE_KEY));
  const reviewTestDate =
    mode === "incidents" && isRealDate(rawDate) && rawDate >= today ? rawDate : null;
  return { mode, reviewTestDate };
}

/** The kinds that count as incident-class mail (NFR-006): allowed in `incidents` mode. */
const INCIDENT_KINDS: readonly EmailKind[] = [
  "incident_open",
  "incident_s1",
  "tokens",
  "unread7",
  "dbdown",
];

/**
 * Whether a kind may be sent under the switch (design 4.12). `d` is the email's local date.
 * In `incidents` mode a review goes out only on the one-off test date, or as the watchdog's
 * fallback; P0 alerts, batches, the reminder, the Morning Brief and test emails do not.
 */
export function emailKindAllowed(
  sw: EmailSwitch,
  kind: EmailKind,
  opts: { d: string; watchdogFallback?: boolean },
): boolean {
  if (sw.mode === "off") return false;
  if (sw.mode === "full") return true;
  if (INCIDENT_KINDS.includes(kind)) return true;
  if (kind === "review") {
    return (
      opts.watchdogFallback === true || (sw.reviewTestDate !== null && opts.d === sw.reviewTestDate)
    );
  }
  return false;
}

/** The evening-heartbeat review check runs in data-only mode only on the test date (design 4.8). */
export function reviewCheckForced(sw: EmailSwitch, d: string): boolean {
  return sw.reviewTestDate !== null && sw.reviewTestDate === d;
}
