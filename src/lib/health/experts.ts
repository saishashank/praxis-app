// D-518 / D-624 (M13-lite WP7): the expert pipeline's line for System Health. Read-only; one line, no LLM,
// no code or name, so it needs no masking. It reports what waits for a person (claims at `extracted`), the
// date of the last screening run, the clusters parked (a person parked them, or the fit needs a build
// change), and, from the latest `experts` stage stat of the market, any `degraded:*` step and a fired F7
// gate as a warning. Nothing here can change a claim, a rule or an order.
import type { Client } from "@libsql/client";

type Exec = Pick<Client, "execute">;

export type ExpertsHealth = {
  /** "attention" when a stage step degraded, the F7 gate fired, or a table could not be read. */
  state: "ok" | "attention";
  claimsToCheck: number;
  lastScreening: string | null;
  clustersParked: number;
  warnings: string[];
  text: string;
};

export type ExpertsStat = { degraded: string[]; f7Fires: boolean };

/** Pure: the warnings carried by one stored `experts` stat value (unknown shapes read as none). */
export function statWarnings(value: unknown): ExpertsStat {
  if (typeof value !== "object" || value === null) return { degraded: [], f7Fires: false };
  const v = value as { degraded?: unknown; f7?: unknown };
  const degraded = Array.isArray(v.degraded)
    ? v.degraded.filter((x): x is string => typeof x === "string" && x.startsWith("degraded:"))
    : [];
  const f7 = v.f7;
  const f7Fires =
    typeof f7 === "object" && f7 !== null && (f7 as { fires?: unknown }).fires === true;
  return { degraded, f7Fires };
}

/** Pure: the line from its counts and the latest stage stat. */
export function expertsHealthOf(x: {
  claimsToCheck: number;
  lastScreening: string | null;
  clustersParked: number;
  stat: ExpertsStat;
}): ExpertsHealth {
  const warnings = [
    ...x.stat.degraded,
    ...(x.stat.f7Fires ? ["F7 gate fired: needs an Owner decision"] : []),
  ];
  const base =
    `Experts: ${x.claimsToCheck} ${x.claimsToCheck === 1 ? "claim" : "claims"} to check; ` +
    `last screening ${x.lastScreening ?? "none yet"}; ` +
    `${x.clustersParked} ${x.clustersParked === 1 ? "cluster" : "clusters"} parked.`;
  return {
    state: warnings.length > 0 ? "attention" : "ok",
    claimsToCheck: x.claimsToCheck,
    lastScreening: x.lastScreening,
    clustersParked: x.clustersParked,
    warnings,
    text: warnings.length === 0 ? base : `${base} Attention: ${warnings.join("; ")}.`,
  };
}

const count = async (db: Exec, sql: string, args: string[] = []): Promise<number> =>
  Number((await db.execute({ sql, args })).rows[0]?.n ?? 0);

/** The line for a market; a failed read says so instead of throwing. */
export async function loadExpertsHealth(db: Exec, market: string): Promise<ExpertsHealth> {
  try {
    const claimsToCheck = await count(
      db,
      `SELECT COUNT(*) AS n FROM claim_status s WHERE s.status = 'extracted'
          AND s.seq = (SELECT MAX(seq) FROM claim_status WHERE claim_id = s.claim_id)`,
    );
    const last = await db.execute({
      sql: "SELECT MAX(d) AS d FROM screening_run WHERE market = ?",
      args: [market],
    });
    const clustersParked = await count(
      db,
      `SELECT COUNT(*) AS n FROM (
         SELECT cluster_id FROM expert_proposal WHERE market = ? AND status = 'parked_build_change'
          UNION
         SELECT s.cluster_id FROM cluster_state s WHERE s.state = 'parked'
          AND s.seq = (SELECT MAX(seq) FROM cluster_state WHERE cluster_id = s.cluster_id))`,
      [market],
    );
    const row = (
      await db.execute({
        sql: `SELECT s.value_json FROM replay_stat s JOIN replay_run r ON r.id = s.run_id
               WHERE r.market = ? AND s.scope = ? AND s.metric = 'experts'
               ORDER BY s.d DESC, s.run_id DESC LIMIT 1`,
        args: [market, market],
      })
    ).rows[0];
    let stat: ExpertsStat = { degraded: [], f7Fires: false };
    if (row !== undefined) {
      try {
        stat = statWarnings(JSON.parse(String(row.value_json)));
      } catch {
        stat = { degraded: [], f7Fires: false };
      }
    }
    const d = last.rows[0]?.d;
    return expertsHealthOf({
      claimsToCheck,
      lastScreening: d === null || d === undefined ? null : String(d),
      clustersParked,
      stat,
    });
  } catch {
    return {
      state: "attention",
      claimsToCheck: 0,
      lastScreening: null,
      clustersParked: 0,
      warnings: [],
      text: "Experts: the expert counters could not be read.",
    };
  }
}
