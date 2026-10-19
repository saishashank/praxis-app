// Shared builders for the A6 orchestration tests (M6 T11): a migrated main DB in `full` mode with the
// v1 rule seed and an AU:F1 lineage (no market data: the `learn` and `words` phases read run records and
// learning tables), run-record seeds for the earlier phases, and seeds for lessons, critiques and plans.
// Synthetic only (SEC-110).
import type { Client } from "@libsql/client";
import { defaultAgentParams } from "@/lib/agents/params";
import { transitionChallenger } from "@/lib/learning/challengerLifecycle";
import {
  D0,
  LEARNING,
  MARKET,
  ownerChallenger,
  world as challengerWorld,
} from "./challengerFixtures";

export { MARKET, D0 };

export const PARAMS = defaultAgentParams();
/** Tuesday 20 Oct 2026, a session; Saturday 17 Oct is not. */
export const D = "2026-10-20";
export const SAT = "2026-10-17";
export const nowFor = (d: string) => (): string => `${d}T08:50:00.000Z`;

/** The seeded main DB (rule versions, F1 lineage) switched to market mode `full`. */
export async function lightWorld(mode: "full" | "data_only" = "full"): Promise<Client> {
  const { db } = await challengerWorld();
  await db.execute({ sql: "UPDATE market SET mode = ? WHERE code = ?", args: [mode, MARKET] });
  return db;
}

export async function addRun(
  db: Client,
  key: string,
  job: string,
  d: string,
  status: "success" | "degraded" | "failed" | "skipped" = "success",
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO run_record (job, market, concurrency_key, scheduled_for, started_at, ended_at, status)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [job, MARKET, key, d, `${d}T08:00:00.000Z`, `${d}T08:05:00.000Z`, status],
  });
}

/** Batch 2b and batch 3 of a session as finished runs. */
export async function addNight(db: Client, d: string, ok = true): Promise<void> {
  const status = ok ? "success" : "failed";
  await addRun(db, `arena-2b:${MARKET}:${d}`, "arena-signals", d, status);
  await addRun(db, `arena-3:${MARKET}:${d}`, "arena-review", d, status);
}

export const WEEKDAYS: readonly string[] = [
  "2026-10-06",
  "2026-10-07",
  "2026-10-08",
  "2026-10-09",
  "2026-10-12",
  "2026-10-13",
  "2026-10-14",
  "2026-10-15",
  "2026-10-16",
  "2026-10-19",
  "2026-10-20",
  "2026-10-21",
  "2026-10-22",
];

export async function seedLesson(
  db: Client,
  id: string,
  grade: "L0" | "L1" | "L2" | "L3",
  over: {
    critic?: boolean | null;
    metric?: string;
    d?: string;
    reachableD?: string | null;
    checks?: string;
  } = {},
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO lesson (id, market, scope, lineage_id, template_id, template_version, subject_json,
            rule_version, metric, direction, param_hint, created_d, created_run)
          VALUES (?, ?, 'market', NULL, 'LT-REGIME', 1, ?, 'F2.v1', ?, 1, NULL, ?, 'run-1')`,
    args: [
      id,
      MARKET,
      JSON.stringify({ regime: "R3" }),
      over.metric ?? "net_excess_pct",
      "2026-10-01",
    ],
  });
  await db.execute({
    sql: `INSERT INTO lesson_grade (lesson_id, seq, grade, split_version, window, n, blocks, estimate, lower,
            upper, B, state_text, reachable_d, run_id, d) VALUES (?, 1, ?, 1, NULL, 120, 18, 0.5, 0.1, 0.9, 0, '', ?, 'run-1', ?)`,
    args: [id, grade, over.reachableD ?? null, over.d ?? "2026-10-19"],
  });
  if (over.critic !== undefined && over.critic !== null) {
    await db.execute({
      sql: `INSERT INTO critique (subject_kind, subject_id, run_id, checks_json, passed, d)
            VALUES ('lesson', ?, 'crit-1', ?, ?, ?)`,
      args: [id, over.checks ?? "[]", over.critic ? 1 : 0, over.d ?? "2026-10-19"],
    });
  }
}

type Cell = { n: number; state: string; detail: string; values: Record<string, unknown> };

/** Stored checks of a challenger evaluation; `flagged` rows of `rows` carry a quality flag (check 4). */
export function challengerChecks(
  flagged = 0,
  rows = 120,
  over: Partial<Record<number, string>> = {},
) {
  const st = (n: number): string => over[n] ?? "pass";
  const cells: Cell[] = [
    { n: 1, state: st(1), detail: "120 rows, 20 blocks", values: { rows: 120, blocks: 20 } },
    { n: 2, state: st(2), detail: "regimes ok", values: { regimes: 2 } },
    { n: 3, state: st(3), detail: "stress positive", values: { stress: 1 } },
    {
      n: 4,
      state: st(4),
      detail: `${flagged} of ${rows} rows flagged (cap 0.05), 0 rows outside the input bound`,
      values: {
        rows,
        flagged,
        flagShareCap: 0.05,
        outsideInputBound: 0,
        survivorshipExposed: false,
      },
    },
    { n: 5, state: st(5), detail: "VAL-110 (i) is pass", values: { val110I: "pass" } },
    {
      n: 6,
      state: st(6),
      detail: "x parameters within bounds",
      values: { parameters: 1, outOfBounds: 0 },
    },
  ];
  return JSON.stringify(cells);
}

export async function addCritique(
  db: Client,
  kind: "challenger" | "lesson",
  id: string,
  checksJson: string,
  passed: boolean,
  d: string,
  runId = "crit-seed",
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO critique (subject_kind, subject_id, run_id, checks_json, passed, d)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [kind, id, runId, checksJson, passed ? 1 : 0, d],
  });
}

/** An Owner challenger moved to `shakedown` on `enteredD` (the F1 incumbent with a changed trail ATR). */
export async function shakedownChallenger(
  db: Client,
  i = 0,
  enteredD = "2026-10-06",
): Promise<string> {
  const r = await ownerChallenger(db, i, D0);
  if (r.status !== "created") throw new Error(`not created: ${JSON.stringify(r)}`);
  for (const to of ["replay", "shakedown"] as const) {
    await transitionChallenger(
      db,
      { id: r.id, to, d: enteredD, actor: "A6", reason: "test" },
      LEARNING,
    );
  }
  return r.id;
}

export const rows = async (
  db: Client,
  sql: string,
  args: (string | number | null)[] = [],
): Promise<Record<string, unknown>[]> =>
  (await db.execute({ sql, args })).rows.map((r) => ({ ...r }));

/** Every table the phases write, as text (idempotency and look-ahead comparisons). */
export async function dumpLearning(db: Client): Promise<string> {
  const parts: string[] = [];
  for (const sql of [
    "SELECT * FROM plan_item ORDER BY market, d, rank",
    "SELECT * FROM plan_review ORDER BY market, plan_d, rank",
    "SELECT * FROM comparison_result ORDER BY market, kind, pair_id, d",
    "SELECT * FROM critique ORDER BY subject_kind, subject_id, run_id",
    "SELECT * FROM critique_note ORDER BY subject_kind, subject_id, run_id, kind",
    "SELECT * FROM change_ledger ORDER BY id",
    "SELECT * FROM playbook_version ORDER BY market, agent, n",
    "SELECT * FROM lesson_grade ORDER BY lesson_id, seq",
    "SELECT id, state, state_d, ready, shakedown_ok_sessions FROM challenger ORDER BY id",
    "SELECT * FROM challenger_event ORDER BY challenger_id, seq",
    "SELECT * FROM attribution ORDER BY subject_kind, subject_id, version",
    "SELECT * FROM replay_stat WHERE run_id LIKE 'arena-words%' ORDER BY run_id, scope, metric",
  ]) {
    parts.push(
      JSON.stringify(
        (await rows(db, sql)).map((r) =>
          Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v)])),
        ),
      ),
    );
  }
  return parts.join("\n");
}
