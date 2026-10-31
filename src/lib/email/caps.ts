// Caps, reserved slots and the atomic claim (M5 T3, design 2.3 and 2.4, EML-004, EML-020, NFR-006).
//
// Per Melbourne date and environment: `email_daily_cap` (20) = `email_reserved_slots` (3: review,
// first new incident, attention reminder) + a pool of 17. P0 alerts take pool slots, at most
// `p0_email_daily_cap` (10) of them, and never a reserved slot. Monthly: `email_monthly_cap` (300);
// once reached only reserved-slot kinds and S1 incidents send. Counting = rows `claimed`, `sent`, or
// `failed` after an accepted attempt. The count and the claim are ONE conditional INSERT, so two
// racing senders cannot both take the last slot; the primary key makes a second claim of the same
// key fail (one email per key).
import type { Client } from "@libsql/client";
import { getConfig } from "@/lib/config/store";
import type { EmailEnv, EmailKind, EmailSlot, EmailStatus } from "@/lib/sentinel/schema";
import { monthlyCapExempt, slotCandidates } from "./keys";

export interface Caps {
  dailyCap: number;
  monthlyCap: number;
  reservedSlots: number;
  p0DailyCap: number;
  testIntervalMin: number;
  testDailyMax: number;
}

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

export async function loadCaps(db: Pick<Client, "execute">): Promise<Caps> {
  const c = db as Client;
  return {
    dailyCap: num(await getConfig(c, "email_daily_cap"), 20),
    monthlyCap: num(await getConfig(c, "email_monthly_cap"), 300),
    reservedSlots: num(await getConfig(c, "email_reserved_slots"), 3),
    p0DailyCap: num(await getConfig(c, "p0_email_daily_cap"), 10),
    testIntervalMin: num(await getConfig(c, "test_email_min_interval_min"), 10),
    testDailyMax: num(await getConfig(c, "test_email_daily_max"), 3),
  };
}

/** Rows that use up a slot (design 2.3). `m` is the email_message alias. */
export const COUNTED = `(m.status IN ('claimed','sent') OR (m.status = 'failed' AND EXISTS
  (SELECT 1 FROM email_attempt a WHERE a.email_key = m.email_key AND a.outcome = 'accepted')))`;

export type ClaimOutcome =
  { kind: "claimed"; slot: EmailSlot } | { kind: "exists" } | { kind: "capped"; slot: EmailSlot };

export interface ClaimParams {
  key: string;
  kind: EmailKind;
  env: EmailEnv;
  /** Local (Melbourne) date the email counts against. */
  d: string;
  nowIso: string;
  recipientSha: string | null;
  caps: Caps;
}

function slotCondition(
  p: ClaimParams,
  slot: EmailSlot,
): { sql: string; args: (string | number)[] } {
  const poolSize = Math.max(0, p.caps.dailyCap - p.caps.reservedSlots);
  const month = p.d.slice(0, 7);
  if (slot.startsWith("reserved_")) {
    return {
      sql: `NOT EXISTS (SELECT 1 FROM email_message m WHERE m.env = ? AND m.d = ? AND m.slot = ? AND ${COUNTED})`,
      args: [p.env, p.d, slot],
    };
  }
  const parts: string[] = [
    `(SELECT COUNT(*) FROM email_message m WHERE m.env = ? AND m.d = ? AND m.slot IN ('pool','p0') AND ${COUNTED}) < ?`,
  ];
  const args: (string | number)[] = [p.env, p.d, poolSize];
  if (slot === "p0") {
    parts.push(
      `(SELECT COUNT(*) FROM email_message m WHERE m.env = ? AND m.d = ? AND m.slot = 'p0' AND ${COUNTED}) < ?`,
    );
    args.push(p.env, p.d, p.caps.p0DailyCap);
  }
  if (!monthlyCapExempt(p.kind, slot)) {
    parts.push(
      `(SELECT COUNT(*) FROM email_message m WHERE m.env = ? AND substr(m.d, 1, 7) = ? AND ${COUNTED}) < ?`,
    );
    args.push(p.env, month, p.caps.monthlyCap);
  }
  return { sql: parts.join(" AND "), args };
}

/**
 * Claims `key` in the first slot that has room. `exists` = the key was already claimed or decided
 * (stop); `capped` = no slot has room. The caller records the cap suppression with `recordRow`.
 */
export async function claimKey(db: Pick<Client, "execute">, p: ClaimParams): Promise<ClaimOutcome> {
  const refJson = JSON.stringify({ claim_at: p.nowIso, claim_n: 0 });
  const candidates = slotCandidates(p.kind);
  for (const slot of candidates) {
    const cond = slotCondition(p, slot);
    const r = await db.execute({
      sql: `INSERT INTO email_message
              (email_key, env, kind, d, slot, status, recipient_sha, created_at, ref_json)
            SELECT ?, ?, ?, ?, ?, 'claimed', ?, ?, ?
            WHERE ${cond.sql}
            ON CONFLICT (email_key) DO NOTHING`,
      args: [p.key, p.env, p.kind, p.d, slot, p.recipientSha, p.nowIso, refJson, ...cond.args],
    });
    if (r.rowsAffected === 1) return { kind: "claimed", slot };
    const there = await db.execute({
      sql: "SELECT 1 FROM email_message WHERE email_key = ?",
      args: [p.key],
    });
    if (there.rows.length > 0) return { kind: "exists" };
  }
  return { kind: "capped", slot: candidates[candidates.length - 1] };
}

/** Writes a decided row (suppressed_*, no_recipient) once; a repeat is ignored. */
export async function recordRow(
  db: Pick<Client, "execute">,
  p: {
    key: string;
    kind: EmailKind;
    env: EmailEnv;
    d: string;
    slot: EmailSlot;
    status: Extract<
      EmailStatus,
      "suppressed_cap" | "suppressed_off" | "suppressed_paused" | "no_recipient"
    >;
    nowIso: string;
    ref?: Record<string, unknown>;
  },
): Promise<void> {
  await db.execute({
    sql: `INSERT OR IGNORE INTO email_message
            (email_key, env, kind, d, slot, status, created_at, ref_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [p.key, p.env, p.kind, p.d, p.slot, p.status, p.nowIso, JSON.stringify(p.ref ?? {})],
  });
}

export interface EmailUsage {
  today: number;
  month: number;
  poolToday: number;
  p0Today: number;
  suppressedCapToday: number;
}

/** Counts for the review's section 9 and the Control Room (estimate: our own rows, PLT-050). */
export async function emailUsage(
  db: Pick<Client, "execute">,
  env: EmailEnv,
  d: string,
): Promise<EmailUsage> {
  const r = await db.execute({
    sql: `SELECT
            (SELECT COUNT(*) FROM email_message m WHERE m.env = ? AND m.d = ? AND ${COUNTED}) AS today,
            (SELECT COUNT(*) FROM email_message m WHERE m.env = ? AND substr(m.d,1,7) = ? AND ${COUNTED}) AS month,
            (SELECT COUNT(*) FROM email_message m WHERE m.env = ? AND m.d = ? AND m.slot IN ('pool','p0') AND ${COUNTED}) AS pool,
            (SELECT COUNT(*) FROM email_message m WHERE m.env = ? AND m.d = ? AND m.slot = 'p0' AND ${COUNTED}) AS p0,
            (SELECT COUNT(*) FROM email_message m WHERE m.env = ? AND m.d = ? AND m.status = 'suppressed_cap') AS sup`,
    args: [env, d, env, d.slice(0, 7), env, d, env, d, env, d],
  });
  const row = r.rows[0];
  return {
    today: Number(row.today),
    month: Number(row.month),
    poolToday: Number(row.pool),
    p0Today: Number(row.p0),
    suppressedCapToday: Number(row.sup),
  };
}

/**
 * Test-email limits (EML-034, decision 23): at most `testDailyMax` a day and one per
 * `testIntervalMin` minutes. Returns the next fixed key number, or null when limited. Two racing
 * requests get the same number and only one wins the claim.
 */
export async function nextTestNumber(
  db: Pick<Client, "execute">,
  env: EmailEnv,
  d: string,
  now: Date,
  caps: Caps,
): Promise<number | null> {
  const r = await db.execute({
    sql: `SELECT COUNT(*) AS n, MAX(created_at) AS last FROM email_message
          WHERE env = ? AND d = ? AND kind = 'test' AND status NOT IN ('suppressed_off','suppressed_paused','no_recipient')`,
    args: [env, d],
  });
  const n = Number(r.rows[0].n);
  if (n >= caps.testDailyMax) return null;
  const last = r.rows[0].last;
  if (typeof last === "string") {
    const gap = now.getTime() - new Date(last).getTime();
    if (gap < caps.testIntervalMin * 60_000) return null;
  }
  return n + 1;
}
