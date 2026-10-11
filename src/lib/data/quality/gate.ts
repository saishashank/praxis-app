// U1 data-quality gate for later milestones (M2 T7). Read-only: it only answers whether a NEW
// ENTRY on a code is allowed for a decision date. Exits are never blocked.
//
// Verbatim (spec/06_data_layer.md:88 DAT-210, :12 DAT-004, :74 DAT-127):
//   "Suspect/missing bars block new entries on those codes (exits still process, flagged). If U1
//   score < 95% the market makes **no new entries** that night (open positions still marked; exits
//   processed); the review says why."
//   "Missing/suspect inputs create a quality record and block affected decisions (DAT-210); never
//   silently filled."
//   "*Yahoo off:* no new bars → DAT-210 blocks all new entries"
// A date with no stored U1 score means the quality stage has not run for it (no data): entries are
// blocked, because a missing input is never treated as good (DAT-004, DAT-127).
import type { Client } from "@libsql/client";

export type EntryReason = "ok" | "no_quality_score" | "u1_gate_failed" | "code_blocked";
export type EntryDecision = { allowed: boolean; reason: EntryReason };

export async function entriesAllowed(
  db: Client,
  code: string,
  date: string,
  market = "AU",
): Promise<EntryDecision> {
  const score = await db.execute({
    sql: "SELECT gate_pass FROM quality_score WHERE market = ? AND d = ? AND tier = 'U1'",
    args: [market, date],
  });
  if (score.rows.length === 0) return { allowed: false, reason: "no_quality_score" };
  if (Number(score.rows[0].gate_pass) !== 1) return { allowed: false, reason: "u1_gate_failed" };
  const open = await db.execute({
    sql: `SELECT 1 FROM data_quality_flag
          WHERE market = ? AND d = ? AND code = ? AND blocks_entries = 1 AND cleared_at IS NULL
          LIMIT 1`,
    args: [market, date, code],
  });
  return open.rows.length > 0
    ? { allowed: false, reason: "code_blocked" }
    : { allowed: true, reason: "ok" };
}

/** DAT-210: exits still process. There is no condition under which this is false. */
export function exitsAllowed(): true {
  return true;
}
