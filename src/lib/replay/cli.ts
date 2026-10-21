// Command-line entry of the replay workflow (M4 T16; D-095 draft). Bundled and run by
// scripts/replay/run.mjs (the GitHub Actions job `replay.yml`, `production` environment, approved
// commit). All logic lives here so the tests can call it with fakes.
//
//   replay --mode light|full|null|injected|evidence|learning [--date YYYY-MM-DD] [--since YYYY-MM-DD]
//          [--runs N] [--synthetic] [--budget-minutes N]
//
// env: TURSO_MAIN_URL, TURSO_MAIN_TOKEN, DATA_REPO, DATA_REPO_TOKEN, COMMIT_SHA (optional)
// Output: statuses, counts and minutes only (SEC-110). Never a row, a code, a URL, a token or a driver
// error. Exit codes: 0 success, expected skip or a clean `paused_budget` stop (recorded), 1 failed,
// 2 usage. The run is idempotent: a run id that already exists is a no-op.
import { createClient, type Client, type InStatement } from "@libsql/client";
import { defaultAgentParams, loadAgentParams, type AgentParams } from "@/lib/agents/params";
import { marketDate } from "@/lib/data/calendar";
import type { TrialLedgerRow } from "@/lib/stats/splits";
import { learningDone, learningWeek, runLearning } from "./learningMode";
import {
  RUN_MODES,
  budgetFor,
  runIdOf,
  runReplay,
  type ReplayOutput,
  type RunMode,
} from "./runner";

const MARKET = "AU";
const MARKET_TZ = "Australia/Sydney";
const BATCH = 400; // threshold-ok: statements per DB batch

const has = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const flagOf = (args: readonly string[], name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 && has(args[i + 1]) ? args[i + 1]! : null;
};

export type HistoryPut = (
  location: { tag: string; asset: string },
  bytes: Uint8Array,
) => Promise<{ result: "uploaded" | "skipped"; sha256: string }>;

export type CliDeps = {
  readonly openDb?: (url: string, token: string | undefined) => Client;
  readonly nowMs?: () => number;
  readonly out?: (line: string) => void;
  /** Download the history files and build the snapshot for [from, to]; the bytes of snapshot.jsonl.gz. */
  readonly prepareSnapshot?: (range: { from: string; to: string }) => Promise<Uint8Array>;
  /** Write-once data-repo writer (D-065 pattern); absent: files are not stored (local checks). */
  readonly makeStore?: (repo: string, token: string) => { put: HistoryPut };
  readonly params?: AgentParams;
  readonly nodeVersion?: string;
};

const isRealDate = (s: unknown): s is string =>
  typeof s === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(s) && // threshold-ok: ISO date string width
  !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

function addYears(d: string, n: number): string {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCFullYear(t.getUTCFullYear() + n);
  return t.toISOString().slice(0, 10); // threshold-ok: ISO date prefix length
}

const NEEDS_SNAPSHOT = (mode: RunMode, synthetic: boolean): boolean =>
  !(mode === "injected" || (mode === "null" && synthetic));

// ---- persistence ---------------------------------------------------------------------------------------------

function inserts(out: ReplayOutput): InStatement[] {
  const s: InStatement[] = [];
  const ins = (table: string, cols: readonly string[], rows: readonly (readonly unknown[])[]) => {
    const sql = `INSERT OR IGNORE INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
    for (const args of rows) s.push({ sql, args: args as never });
  };
  ins(
    "lineage",
    ["id", "created_d", "parent"],
    out.lineages.map((l) => [l.id, l.created_d, l.parent]),
  );
  ins(
    "lineage_split",
    [
      "lineage_id",
      "version",
      "block_sessions",
      "holdout_len",
      "validation_len",
      "purge",
      "data_end_d",
      "holdout_start_d",
      "holdout_end_d",
      "validation_start_d",
      "validation_end_d",
      "dev_end_d",
      "deferred_until_d",
      "reason",
      "measured_on_run",
    ],
    out.splits.map((x) => [
      x.lineage_id,
      x.version,
      x.block_sessions,
      x.holdout_len,
      x.validation_len,
      x.purge,
      x.data_end_d,
      x.holdout_start_d,
      x.holdout_end_d,
      x.validation_start_d,
      x.validation_end_d,
      x.dev_end_d,
      x.deferred_until_d,
      x.reason,
      x.measured_on_run,
    ]),
  );
  ins(
    "trial_ledger",
    [
      "id",
      "market",
      "lineage_id",
      "split_version",
      "kind",
      "rule_version",
      "variant",
      "run_id",
      "d",
    ],
    out.trials.map((t) => [
      t.id,
      t.market,
      t.lineage_id,
      t.split_version,
      t.kind,
      t.rule_version,
      t.variant,
      t.run_id,
      t.d,
    ]),
  );
  const r = out.run;
  ins(
    "replay_run",
    [
      "id",
      "kind",
      "market",
      "snapshot_sha",
      "commit_sha",
      "params_sha",
      "seed",
      "node_version",
      "files_json",
      "minutes",
    ],
    [
      [
        r.id,
        r.kind,
        r.market,
        r.snapshot_sha,
        r.commit_sha,
        r.params_sha,
        r.seed,
        r.node_version,
        r.files_json,
        r.minutes,
      ],
    ],
  );
  ins(
    "replay_stat",
    ["run_id", "scope", "metric", "d", "value_json"],
    out.stats.map((x) => [x.run_id, x.scope, x.metric, x.d, x.value_json]),
  );
  ins(
    "validation_result",
    [
      "id",
      "run_id",
      "lineage_id",
      "rule_version",
      "variant",
      "split_version",
      "test",
      "level",
      "B",
      "n",
      "blocks",
      "stat",
      "p",
      "mde",
      "lower",
      "upper",
      "L_used",
      "m_used",
      "outcome",
      "reachable_d",
    ],
    out.validation.map((v) => [
      v.id,
      v.run_id,
      v.lineage_id,
      v.rule_version,
      v.variant,
      v.split_version,
      v.test,
      v.level,
      v.B,
      v.n,
      v.blocks,
      v.stat,
      v.p,
      v.mde,
      v.lower,
      v.upper,
      v.L_used,
      v.m_used,
      v.outcome,
      v.reachable_d,
    ]),
  );
  ins(
    "label",
    [
      "id",
      "execution_id",
      "rule_version",
      "variant",
      "label",
      "qualifiers_json",
      "cost_infeasible",
      "n",
      "mde",
      "d",
      "result_ids",
    ],
    out.labels.map((l) => [
      l.id,
      l.execution_id,
      l.rule_version,
      l.variant,
      l.label,
      l.qualifiers_json,
      l.cost_infeasible,
      l.n,
      l.mde,
      l.d,
      l.result_ids,
    ]),
  );
  return s;
}

/** Write every row of a run (idempotent: INSERT OR IGNORE; the run row is last-but-data in one chunk series). */
export async function persistOutput(db: Client, out: ReplayOutput): Promise<number> {
  const stmts = inserts(out);
  for (let i = 0; i < stmts.length; i += BATCH) {
    await db.batch(stmts.slice(i, i + BATCH), "write");
  }
  return stmts.length;
}

async function existingTrials(db: Client): Promise<TrialLedgerRow[]> {
  const rs = await db.execute({
    sql: "SELECT * FROM trial_ledger WHERE market = ?",
    args: [MARKET],
  });
  const t = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
  return rs.rows.map((r) => ({
    id: String(r.id),
    market: String(r.market),
    lineage_id: String(r.lineage_id),
    split_version: Number(r.split_version),
    kind: String(r.kind) as TrialLedgerRow["kind"],
    rule_version: t(r.rule_version),
    variant: t(r.variant),
    run_id: t(r.run_id),
    d: String(r.d),
  }));
}

// ---- main ------------------------------------------------------------------------------------------------------

export async function replayMain(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  deps: CliDeps = {},
): Promise<number> {
  const out = deps.out ?? ((s: string) => console.log(s));
  const nowMs = deps.nowMs ?? (() => Date.now());
  const mode = flagOf(argv, "--mode");
  if (mode === null || !RUN_MODES.includes(mode as RunMode)) {
    out(`replay: failed (usage: --mode ${RUN_MODES.join("|")})`);
    return 2;
  }
  const m = mode as RunMode;
  const date = flagOf(argv, "--date") ?? marketDate(new Date(nowMs()), MARKET_TZ);
  const since = flagOf(argv, "--since") ?? undefined;
  const runsText = flagOf(argv, "--runs");
  const runs = runsText === null ? undefined : Number(runsText);
  const budgetText = flagOf(argv, "--budget-minutes");
  const synthetic = argv.includes("--synthetic");
  if (
    !isRealDate(date) ||
    (since !== undefined && !isRealDate(since)) ||
    (runs !== undefined && !(Number.isInteger(runs) && runs >= 1)) ||
    (budgetText !== null && !(Number(budgetText) > 0))
  ) {
    out("replay: failed (bad argument)");
    return 2;
  }
  const url = env.TURSO_MAIN_URL;
  const token = env.TURSO_MAIN_TOKEN;
  if (!has(url) || (!has(token) && !url.startsWith("file:"))) {
    out("replay: failed (database not configured)");
    return 1;
  }
  const open = deps.openDb ?? ((u, t) => createClient({ url: u, authToken: t }));
  const db = open(url, has(token) ? token : undefined);
  try {
    const params = deps.params ?? (await loadAgentParams(db).catch(() => defaultAgentParams()));
    if (m === "learning" && (await learningDone(db, MARKET, learningWeek(date)))) {
      out("replay learning: already recorded");
      return 0;
    }
    const commitSha = has(env.COMMIT_SHA)
      ? env.COMMIT_SHA
      : "0000000000000000000000000000000000000000";
    let bytes: Uint8Array | null = null;
    if (NEEDS_SNAPSHOT(m, synthetic)) {
      if (deps.prepareSnapshot === undefined) {
        out("replay: failed (no snapshot source)");
        return 1;
      }
      const to = date;
      const from = addYears(to, -(params.replay.eventBackfillYears + 1));
      bytes = await deps.prepareSnapshot({ from, to });
    }
    const o =
      m === "learning"
        ? await runLearning({
            db,
            market: MARKET,
            d: date,
            params,
            commitSha,
            nodeVersion: deps.nodeVersion ?? process.version,
            snapshotBytes: bytes!,
            now: nowMs,
            budgetMinutes: budgetText === null ? undefined : Number(budgetText),
          })
        : runReplay({
            mode: m,
            d: date,
            params,
            commitSha,
            nodeVersion: deps.nodeVersion ?? process.version,
            snapshotBytes: bytes,
            since,
            existingTrials: m === "evidence" ? await existingTrials(db) : [],
            nullRuns: runs,
            synthetic,
            now: nowMs,
            budgetMinutes: budgetText === null ? undefined : Number(budgetText),
          });
    if (o === null) {
      out("replay learning: already recorded");
      return 0;
    }
    // a paused learning run resumes under the same run id: its rows are INSERT OR IGNORE
    const seen =
      m === "learning"
        ? { rows: [] }
        : await db.execute({ sql: "SELECT 1 FROM replay_run WHERE id = ?", args: [o.run.id] });
    if (seen.rows.length > 0) {
      out(`replay ${m}: already recorded`);
      return 0;
    }
    let stored = 0;
    if (o.files.length > 0 && has(env.DATA_REPO) && has(env.DATA_REPO_TOKEN) && deps.makeStore) {
      const store = deps.makeStore(env.DATA_REPO, env.DATA_REPO_TOKEN);
      const tag = `replay-${date.slice(0, 7)}`;
      for (const f of o.files) {
        await store.put({ tag, asset: f.name }, f.bytes);
        stored += 1;
      }
    }
    const rows = await persistOutput(db, o);
    const r = o.report;
    out(
      `replay ${m}: ${r.status}${r.pausedAt === null ? "" : ` at ${r.pausedAt}`} minutes=${r.totalMinutes.toFixed(2)} budget=${r.budgetMinutes} within=${r.within} stages=${r.stages
        .map((s) => `${s.stage}:${s.minutes.toFixed(2)}`)
        .join(
          ",",
        )} ledger_rows=${r.ledgerRows} cohorts=${r.cohorts} files=${stored}/${o.files.length} rows=${rows}`,
    );
    return 0;
  } catch (e) {
    // Never print a driver or store error: it can carry the database URL or the repository name.
    const name = e instanceof Error ? e.name : "Error";
    out(`replay ${m}: failed (${name})`);
    return 1;
  } finally {
    db.close();
  }
}

export { budgetFor, runIdOf };

// ---- local null / injected checks (no database, no data repo) -----------------------------------------------------

/**
 * `nullRuns --kind null|injected [--runs N] [--snapshot <file>]`: prints the AT-17 size or detection
 * report as aggregates (B = bootstrap_size_check_replications). Without --snapshot the rows are
 * synthetic and public. Exit 0 when the check passes, 1 when not, 2 usage.
 */
export async function nullRunsMain(
  argv: readonly string[],
  deps: {
    out?: (line: string) => void;
    nowMs?: () => number;
    readFile?: (p: string) => Uint8Array;
  } = {},
): Promise<number> {
  const out = deps.out ?? ((s: string) => console.log(s));
  const nowMs = deps.nowMs ?? (() => Date.now());
  const kind = flagOf(argv, "--kind");
  if (kind !== "null" && kind !== "injected") {
    out("nullRuns: failed (usage: --kind null|injected [--runs N] [--snapshot FILE])");
    return 2;
  }
  const runs = Number(flagOf(argv, "--runs") ?? (kind === "null" ? 2000 : 30)); // threshold-ok: default replay run counts, design 4.9 / AT-17 (null 2000, injected 30)
  if (!Number.isInteger(runs) || runs < 1) {
    out("nullRuns: failed (bad argument)");
    return 2;
  }
  const snap = flagOf(argv, "--snapshot");
  const t0 = nowMs();
  const bytes = snap !== null && deps.readFile !== undefined ? deps.readFile(snap) : null;
  const o = runReplay({
    mode: kind,
    d: marketDate(new Date(nowMs()), MARKET_TZ),
    params: defaultAgentParams(),
    commitSha: "0000000000000000000000000000000000000000",
    nodeVersion: process.version,
    snapshotBytes: bytes,
    nullRuns: runs,
    synthetic: bytes === null,
    now: nowMs,
    budgetMinutes: Number.MAX_SAFE_INTEGER,
  });
  const minutes = (nowMs() - t0) / 60_000; // threshold-ok: ms per minute
  const s = o.size;
  if (kind === "null" && s !== null) {
    const lv = s.levels
      .map((l) => `${l.level}:${l.rejections}/${s.n}[${l.lo},${l.hi}]${l.within ? "" : "!"}`)
      .join(" ");
    const ex = s.extrapolated.map((e) => `${e.level.toFixed(6)}:${e.rate.toFixed(5)}`).join(" ");
    out(
      `nullRuns null: n=${s.n} rejections ${lv} ks_p=${s.uniformity.p.toFixed(4)} extrapolated ${ex} pass=${s.pass} minutes=${minutes.toFixed(2)}`,
    );
    return s.pass ? 0 : 1;
  }
  const det = o.stats.find((x) => x.scope === "injected" && x.metric === "detection");
  const com = o.stats.find((x) => x.scope === "injected" && x.metric === "committed_seed");
  const d =
    det === undefined
      ? null
      : (JSON.parse(det.value_json) as { rate: number; pass: boolean; n: number });
  const c = com === undefined ? null : (JSON.parse(com.value_json) as { p: number; level: number });
  out(
    `nullRuns injected: detection_rate=${d?.rate} n=${d?.n} committed_p=${c?.p} level=${c?.level} minutes=${minutes.toFixed(2)}`,
  );
  return d?.pass === true && c !== null && c.p <= c.level ? 0 : 1;
}
