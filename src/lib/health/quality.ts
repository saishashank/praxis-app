// System Health "Data quality" section (DAT-211, UX-010, UX-090). Counts of open flags by rule and
// severity for the latest quality date are visible to every role; the codes behind each rule are
// Owner-only and ABSENT (not null) for other roles (ROL-102a).
//
// Verbatim (spec/06_data_layer.md:89 DAT-211): "Every check is stored and summarised on System
// Health and in review section 9."
import type { Client } from "@libsql/client";
import type { Role } from "@/lib/auth/permissions";

export const TOP_CODES_PER_RULE = 5;

export type QualityRuleCount = {
  checkId: string;
  severity: string;
  count: number;
  blocksEntries: boolean;
  topCodes?: string[]; // Owner only
};
export type QualityTier = {
  tier: string;
  valid: number;
  expected: number;
  score: number;
  gatePass: boolean;
};
export type QualitySummary = {
  date: string | null; // latest date with a stored score
  tiers: QualityTier[];
  rules: QualityRuleCount[];
  openTotal: number;
};

export async function getQualitySummary(
  db: Client,
  role: Role,
  market = "AU",
): Promise<QualitySummary> {
  const latest = await db.execute({
    sql: "SELECT MAX(d) AS d FROM quality_score WHERE market = ?",
    args: [market],
  });
  const date = latest.rows[0]?.d == null ? null : String(latest.rows[0].d);
  if (date === null) return { date: null, tiers: [], rules: [], openTotal: 0 };

  const tierRows = await db.execute({
    sql: `SELECT tier, valid, expected, score, gate_pass FROM quality_score
          WHERE market = ? AND d = ? ORDER BY tier`,
    args: [market, date],
  });
  const tiers = tierRows.rows.map((r) => ({
    tier: String(r.tier),
    valid: Number(r.valid),
    expected: Number(r.expected),
    score: Number(r.score),
    gatePass: Number(r.gate_pass) === 1,
  }));

  const grouped = await db.execute({
    sql: `SELECT check_id, severity, MAX(blocks_entries) AS blocks, COUNT(*) AS n
          FROM data_quality_flag WHERE market = ? AND d = ? AND cleared_at IS NULL
          GROUP BY check_id, severity ORDER BY check_id, severity`,
    args: [market, date],
  });
  const rules: QualityRuleCount[] = [];
  for (const g of grouped.rows) {
    const rule: QualityRuleCount = {
      checkId: String(g.check_id),
      severity: String(g.severity),
      count: Number(g.n),
      blocksEntries: Number(g.blocks) === 1,
    };
    if (role === "owner") {
      const top = await db.execute({
        sql: `SELECT code FROM data_quality_flag
              WHERE market = ? AND d = ? AND cleared_at IS NULL AND check_id = ? AND severity = ?
                AND code IS NOT NULL
              ORDER BY code LIMIT ?`,
        args: [market, date, rule.checkId, rule.severity, TOP_CODES_PER_RULE],
      });
      rule.topCodes = top.rows.map((r) => String(r.code));
    }
    rules.push(rule);
  }
  return { date, tiers, rules, openTotal: rules.reduce((a, r) => a + r.count, 0) };
}
