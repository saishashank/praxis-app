// M17 WP6 (AGT-144, D-386, D-399): the Cortex hand-over is a READ-AFTER-RUN. Each intraday candidate of
// session `d` gets the outcome the evening's run gave its code:
//   code in `pick` rows of d                         -> night_pick
//   else every Cortex decision of d for it was blocked -> rejected:<first failing gate> (shadow arm first, D-457)
//   else a decision exists, or the code is in a universe tier the families use -> rejected:rank
//   else (no universe_snapshot row in a family tier)  -> not_in_universe
// Writes only `intraday_candidate.decision_outcome` (the 0020 guard trigger aborts any other change).
// Idempotent: a second run writes nothing. Nothing is injected into the Cortex run (night.ts is
// unchanged), so the replay hash cannot move.
import { DEFAULT_FAMILY_TIERS } from "@/lib/cortex/stage";
import type { Exec } from "@/lib/cortex/store/common";

const familyTiers = (): ReadonlySet<string> =>
  new Set(Object.values(DEFAULT_FAMILY_TIERS).flatMap((t) => [...t]));

/** The two columns of a `cortex_decision` row the mapping needs (read directly: the import guard keeps
 * `store/decisions` out of `src/lib/intraday`). */
export type NightDecision = {
  readonly code: string;
  readonly arm: string;
  readonly firstFailGate: string | null;
};

/** The outcome of one code given its night rows (pure; exported for the tests). */
export function outcomeOf(
  code: string,
  picks: ReadonlySet<string>,
  decisions: readonly NightDecision[],
  inUniverse: boolean,
): string {
  if (picks.has(code)) return "night_pick";
  // D-457: the shadow arm is the Cortex's own evaluation (the live arm of a shadow family is blocked by
  // the family-status gate whatever the code); use it when present, else the live rows.
  const all = decisions.filter((x) => x.code === code);
  const shadow = all.filter((x) => x.arm === "shadow");
  const mine = shadow.length > 0 ? shadow : all;
  if (mine.length > 0 && mine.every((x) => x.firstFailGate !== null)) {
    return `rejected:${mine[0]!.firstFailGate}`;
  }
  if (mine.length > 0 || inUniverse) return "rejected:rank";
  return "not_in_universe";
}

export async function recordOutcomes(
  db: Exec,
  market: string,
  d: string,
): Promise<{ written: number }> {
  const cands = await db.execute({
    sql: "SELECT code FROM intraday_candidate WHERE market = ? AND session_d = ? ORDER BY code",
    args: [market, d],
  });
  if (cands.rows.length === 0) return { written: 0 };
  const picks = new Set(
    (
      await db.execute({
        sql: "SELECT code FROM pick WHERE market = ? AND d = ?",
        args: [market, d],
      })
    ).rows.map((r) => String(r.code)),
  );
  const decisions: NightDecision[] = (
    await db.execute({
      sql: "SELECT code, arm, first_fail_gate FROM cortex_decision WHERE market = ? AND d = ? ORDER BY book_id, code, arm",
      args: [market, d],
    })
  ).rows.map((r) => ({
    code: String(r.code),
    arm: String(r.arm),
    firstFailGate: r.first_fail_gate === null ? null : String(r.first_fail_gate),
  }));
  const tiers = familyTiers();
  const snap = await db.execute({
    sql:
      "SELECT code, tier FROM universe_snapshot WHERE market = ? AND status = 'active' " +
      "AND d = (SELECT MAX(d) FROM universe_snapshot WHERE market = ? AND d <= ?)",
    args: [market, market, d],
  });
  const universe = new Set(
    snap.rows.filter((r) => tiers.has(String(r.tier))).map((r) => String(r.code)),
  );
  let written = 0;
  for (const row of cands.rows) {
    const code = String(row.code);
    const outcome = outcomeOf(code, picks, decisions, universe.has(code));
    const r = await db.execute({
      sql:
        "UPDATE intraday_candidate SET decision_outcome = ? WHERE market = ? AND session_d = ? " +
        "AND code = ? AND decision_outcome IS NOT ?",
      args: [outcome, market, d, code, outcome],
    });
    written += r.rowsAffected;
  }
  return { written };
}
