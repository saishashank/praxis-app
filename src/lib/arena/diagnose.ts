// Read-only diagnosis of batch 2b (live defect: production records signals=0 every night). It runs
// the same inputs path as signalsDay (loadAgentParams -> loadVersionSet -> liveParams ->
// loadDayInputs -> runVersions) for the given sessions and prints counts only, then the same day
// inputs once more with the default parameters, so "the data" and "the live parameters" can be told
// apart. Bundled and run by scripts/arena/diagnose.mjs (.github/workflows/diagnose-signals.yml).
//
//   diagnose --dates YYYY-MM-DD[,YYYY-MM-DD...]
//   diagnose --scenario splitFrequency [--window N]   (DAT-252 (3), D-974: split-day frequency, AT-45)
//
// env: TURSO_MAIN_URL, TURSO_MAIN_TOKEN. The client is wrapped so that any statement other than a
// plain SELECT throws before it reaches the database: this module never writes a row.
// Output: statuses and counts only (SEC-110). Never a row, a code, a URL, a token or a driver error.
import { createClient, type Client, type InStatement } from "@libsql/client";
import { loadCalendar } from "./closeBooks";
import { loadExecutions } from "./cohortWriter";
import { loadConfirmedActions } from "./corpActionWriter";
import { INDEX_CODE, loadDayInputs } from "@/lib/agents/candidates";
import { runFamilies, type FamilyOutput } from "@/lib/agents/families";
import { defaultAgentParams, loadAgentParams } from "@/lib/agents/params";
import { regimeWarmupCloses } from "@/lib/agents/regime";
import { liveParams, loadVersionSet, runVersions } from "@/lib/agents/versionRuns";
import { computeTiers } from "@/lib/data/pipeline/batch1-core.mjs";
import { addDays, previousTradingDay } from "@/lib/data/pipeline/rules.mjs";
import { TIER_RULES } from "@/lib/data/universe/tiers.mjs";
import { measure as measureSplits } from "@/lib/data/splitFrequency";

const MARKET = "AU";
const READ = /^\s*(SELECT|WITH)\b/i; // money-float-ok: a regular expression, not money
const WRITE = /\b(INSERT|UPDATE|DELETE|REPLACE|UPSERT|CREATE|DROP|ALTER|ATTACH|PRAGMA|VACUUM)\b/i; // money-float-ok: a regular expression, not money

const DATE = /^\d{4}-\d{2}-\d{2}$/; // money-float-ok: a regular expression, not money
export class WriteRefused extends Error {}

function check(stmt: InStatement): void {
  const sql = typeof stmt === "string" ? stmt : stmt.sql;
  if (!READ.test(sql) || WRITE.test(sql)) throw new WriteRefused("diagnose: write refused");
}

/** A client that runs plain SELECT statements only; everything else throws before the network. */
export function readOnly(db: Client): Client {
  return new Proxy(db, {
    get(target, key) {
      if (key === "execute") {
        return (stmt: InStatement, args?: unknown) => {
          check(stmt);
          return args === undefined
            ? target.execute(stmt)
            : target.execute(stmt as string, args as never);
        };
      }
      if (key === "batch") {
        return (stmts: InStatement[]) => {
          for (const s of stmts) check(s);
          return target.batch(stmts, "read");
        };
      }
      if (
        key === "transaction" ||
        key === "executeMultiple" ||
        key === "migrate" ||
        key === "sync"
      ) {
        return () => {
          throw new WriteRefused(`diagnose: ${String(key)} refused`);
        };
      }
      const v = Reflect.get(target, key);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

const tally = (xs: readonly string[]): string => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return JSON.stringify(Object.fromEntries([...m].sort((a, b) => b[1] - a[1])));
};

function outLines(label: string, o: FamilyOutput): string[] {
  return [
    `  ${label}: candidates=${o.candidates.length} by=${tally(o.candidates.map((c) => `${c.family}|${c.ruleVersion}`))}`,
    `  ${label}: blocked=${o.blocked.length} by=${tally(o.blocked.map((c) => c.family))}` +
      ` reasons=${tally(o.blocked.flatMap((c) => c.reasons))}`,
    `  ${label}: blockedData=${tally(o.blockedData.map((b) => b.family))}`,
  ];
}

async function count(db: Client, sql: string, args: (string | number)[]): Promise<string> {
  const rs = await db.execute({ sql, args });
  return String(rs.rows[0]!.n);
}

/**
 * D-861: the night's tiers recomputed from the bars stored now (the stored snapshot may predate a
 * history fill), the stored-bar counts of the codes whose ADV meets U1, and the thin sessions of the
 * window (fewer than half the busiest session's bars).
 */
async function recomputedTiers(db: Client, d: string, out: (line: string) => void): Promise<void> {
  const calRows = (
    await db.execute({
      sql: "SELECT d, kind FROM trading_calendar WHERE market = ? AND d >= ? AND d <= ?",
      args: [MARKET, addDays(d, -150), d],
    })
  ).rows.map((r) => ({ d: String(r.d), kind: String(r.kind) }));
  const uni = await db.execute({
    sql: `SELECT code FROM universe_snapshot WHERE market = ?
          AND d = (SELECT MAX(d) FROM universe_snapshot WHERE market = ? AND d <= ?)`,
    args: [MARKET, MARKET, d],
  });
  const tiers = await computeTiers(
    { db, market: MARKET, calRows },
    { read: 0, written: 0 },
    d,
    uni.rows.map((r) => String(r.code)),
  );
  let from = d;
  for (let i = 0; i < TIER_RULES.windowSessions; i += 1) from = previousTradingDay(from, calRows);
  const u1Adv = Number(TIER_RULES.u1.advMicro / 1_000_000n); // money-float-ok: A$ threshold
  // Number(null) is 0: a code without bars is never in the pool
  const big = [...tiers].filter(([, t]) => Number(t.adv) >= u1Adv).map(([code]) => code); // money-float-ok: A$ compare
  const perCode = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM price_bar WHERE market = ? AND d >= ? AND d < ?
          AND code IN (SELECT value FROM json_each(?)) GROUP BY code`,
    args: [MARKET, from, d, JSON.stringify(big)],
  });
  const pool = perCode.rows.map((r) => Number(r.n)); // money-float-ok: row counts
  const perSession = await db.execute({
    sql: "SELECT d, COUNT(*) AS n FROM price_bar WHERE market = ? AND d >= ? AND d < ? GROUP BY d ORDER BY d",
    args: [MARKET, from, d],
  });
  const counts = perSession.rows.map((r) => Number(r.n)); // money-float-ok: row counts
  const busiest = Math.max(0, ...counts); // money-float-ok: a row count
  const thin = perSession.rows
    .filter((r) => Number(r.n) * 2 < busiest) // money-float-ok: row counts
    .map((r) => `${String(r.d)}:${String(r.n)}`);
  out(
    `  tiers now: ${tally([...tiers.values()].map((t) => `${t.tier}|${t.status}`))}` +
      ` window=${from}..${d} sessionsWithBars=${counts.length} busiest=${busiest} thin=${JSON.stringify(thin)}` +
      ` u1AdvPool=${pool.length} poolBars: 60=${pool.filter((n) => n >= 60).length}` +
      ` 54-59=${pool.filter((n) => n >= 54 && n < 60).length} under54=${pool.filter((n) => n < 54).length}`,
  );
}

export async function diagnoseDay(
  db: Client,
  d: string,
  out: (line: string) => void,
): Promise<void> {
  const market = await db.execute({
    sql: "SELECT mode, tz, open_time, close_time FROM market WHERE code = ?",
    args: [MARKET],
  });
  if (market.rows.length === 0) {
    out(`diagnose ${d}: market row missing`);
    return;
  }
  const m = market.rows[0]!;
  const hours = {
    tz: String(m.tz),
    open_time: String(m.open_time),
    close_time: String(m.close_time),
  };

  const tiers = await db.execute({
    sql: `SELECT tier, status, COUNT(*) AS n FROM universe_snapshot WHERE market = ? AND d = ?
          GROUP BY tier, status ORDER BY tier, status`,
    args: [MARKET, d],
  });
  const lastUni = await db.execute({
    sql: "SELECT MAX(d) AS d FROM universe_snapshot WHERE market = ? AND d <= ?",
    args: [MARKET, d],
  });
  const barsOnD = await count(
    db,
    "SELECT COUNT(*) AS n FROM price_bar WHERE market = ? AND d = ?",
    [MARKET, d],
  );
  const uniWithBar = await count(
    db,
    `SELECT COUNT(*) AS n FROM universe_snapshot u JOIN price_bar b
       ON b.market = u.market AND b.code = u.code AND b.d = u.d
     WHERE u.market = ? AND u.d = ? AND u.status = 'active'`,
    [MARKET, d],
  );
  const signalRows = await count(
    db,
    "SELECT COUNT(*) AS n FROM signal WHERE market = ? AND d = ?",
    [MARKET, d],
  );
  out(
    `diagnose ${d}: mode=${String(m.mode)} universe=${JSON.stringify(
      tiers.rows.map((r) => `${String(r.tier)}|${String(r.status)}=${String(r.n)}`),
    )} lastUniverseD=${String(lastUni.rows[0]!.d ?? "none")} barsOnD=${barsOnD}` +
      ` activeUniverseWithBar=${uniWithBar} signalRowsStored=${signalRows}`,
  );
  await recomputedTiers(db, d, out);

  const base = await loadAgentParams(db);
  const executions = await loadExecutions(db);
  const versionSet = await loadVersionSet(db, MARKET, executions);
  const params = liveParams(base, versionSet);
  out(
    `  versions: ${
      versionSet === null
        ? "none (single v1 run)"
        : `live=${JSON.stringify([...versionSet.live.values()].map((v) => `${v.id}:${Object.keys(v.params).length}keys`))}` +
          ` extra=${JSON.stringify(versionSet.extra.map((v) => `${v.id}:${v.role}`))}`
    }`,
  );
  const overrides = await db.execute(
    "SELECT key, scope, COUNT(*) AS n FROM config_version GROUP BY key, scope ORDER BY key, scope",
  );
  out(
    `  config_version keys=${JSON.stringify(overrides.rows.map((r) => `${String(r.key)}@${String(r.scope)}`))}`,
  );

  const calendar = await loadCalendar(db, MARKET);
  const day = await loadDayInputs(db, {
    market: MARKET,
    d,
    calendar,
    hours,
    params,
    replay: false,
    heldCodes: [],
    actions: await loadConfirmedActions(db, MARKET, d),
  });
  const facts = [...day.facts.values()];
  out(
    `  inputs: regime=${day.inputs.regime} regimeD=${day.regime?.d ?? "none"} partial=${JSON.stringify(day.partialReasons)}` +
      ` sources=${JSON.stringify(day.inputs.sources)} sessions=${day.inputs.sessions.length}` +
      ` facts=${facts.length} byTier=${tally(facts.map((f) => f.tier))} halted=${facts.filter((f) => f.halted).length}` +
      ` events=${day.inputs.events.length}`,
  );
  // A short index history gives regime "unknown" with no partial reason (the run still succeeds)
  const r = day.regime?.result;
  const ix = await db.execute({
    sql: `SELECT COUNT(*) AS n, SUM(CASE WHEN published_at < ? THEN 1 ELSE 0 END) AS visible,
            MIN(d) AS first FROM index_bar WHERE market = ? AND index_code = ? AND d <= ?`,
    args: [day.cutoff, MARKET, INDEX_CODE, d],
  });
  const stored = await db.execute({
    sql: `SELECT d, raw_state, state FROM regime_daily WHERE market = ? AND d <= ?
          ORDER BY d DESC, version DESC LIMIT 5`,
    args: [MARKET, d],
  });
  out(
    `  index: rows=${String(ix.rows[0]!.n)} visibleAtCutoff=${String(ix.rows[0]!.visible ?? 0)}` +
      ` first=${String(ix.rows[0]!.first ?? "none")} needed=${regimeWarmupCloses(params)}` +
      ` raw=${r?.raw_state ?? "none"} smaNull=${r === undefined || r.sma_micro === null}` +
      ` volPctNull=${r === undefined || r.vol_pct === null} fall5Null=${r === undefined || r.fall5_ppm === null}` +
      ` stored=${JSON.stringify(stored.rows.map((s) => `${String(s.d)}:${String(s.raw_state)}|${String(s.state)}`))}`,
  );
  const bars = facts.map((f) => f.rawBars.length).sort((a, b) => a - b);
  out(
    `  bars per code: min=${bars[0] ?? 0} median=${bars[Math.floor(bars.length / 2)] ?? 0} max=${bars[bars.length - 1] ?? 0}` +
      ` atrNotWarm=${facts.filter((f) => !f.ind.atrWarm).length}` +
      ` isHigh=${facts.filter((f) => f.ind.isHigh === true).length}` +
      ` smaLongNull=${facts.filter((f) => f.ind.closeAboveSmaLong === null).length}` +
      ` volRatioNull=${facts.filter((f) => f.ind.volumeRatio === null).length}` +
      ` rsiShortNull=${facts.filter((f) => f.ind.rsiShort === null).length}`,
  );

  const live = runVersions(day.inputs, params, versionSet);
  for (const l of outLines("live params", live.out)) out(l);
  for (const l of outLines("default params", runFamilies(day.inputs, defaultAgentParams()))) out(l);
}

/**
 * D-883: whether tonight's pick candidates can carry the three cases. A pick needs a scenario, read
 * from closed `ledger_row` rows of the family that entered and exited by the split's `dev_end_d`
 * (cards.ts loadScenarioInput), at least `scenario_min_n` of them. Per lineage: the latest split's
 * version and dates and that closed-row count by rule version and variant; then the ledger by kind.
 */
export async function picksReadiness(db: Client, out: (line: string) => void): Promise<void> {
  const splits = await db.execute({
    sql: `SELECT s.lineage_id, s.version, s.dev_end_d, s.data_end_d, s.deferred_until_d FROM lineage_split s
          WHERE s.lineage_id LIKE ? AND s.version =
            (SELECT MAX(x.version) FROM lineage_split x WHERE x.lineage_id = s.lineage_id)
          ORDER BY s.lineage_id`,
    args: [`${MARKET}:%`],
  });
  out(`diagnose picks: splits=${splits.rows.length}`);
  for (const r of splits.rows) {
    const lineage = String(r.lineage_id);
    const family = lineage.slice(MARKET.length + 1);
    const devEnd = r.dev_end_d === null ? null : String(r.dev_end_d);
    let byVersion = "{}";
    if (devEnd !== null) {
      const rs = await db.execute({
        sql: `SELECT s.rule_version || '|' || s.variant AS k, COUNT(*) AS n
              FROM ledger_row l JOIN signal s ON s.id = l.signal_id
              WHERE s.market = ? AND s.family = ? AND l.exit_d IS NOT NULL
                AND l.entry_d <= ? AND l.exit_d <= ?
              GROUP BY k ORDER BY k`,
        args: [MARKET, family, devEnd, devEnd],
      });
      byVersion = JSON.stringify(
        Object.fromEntries(rs.rows.map((x) => [String(x.k), String(x.n)])),
      );
    }
    out(
      `  ${lineage}: v=${String(r.version)} devEnd=${devEnd ?? "none"} dataEnd=${String(r.data_end_d)}` +
        ` deferredUntil=${r.deferred_until_d === null ? "none" : String(r.deferred_until_d)}` +
        ` devClosed=${byVersion}`,
    );
  }
  const ledger = await db.execute({
    sql: `SELECT l.forward AS f, COUNT(*) AS n, SUM(CASE WHEN l.exit_d IS NULL THEN 0 ELSE 1 END) AS closed,
            MIN(l.entry_d) AS first, MAX(l.entry_d) AS last
          FROM ledger_row l JOIN signal s ON s.id = l.signal_id WHERE s.market = ?
          GROUP BY l.forward ORDER BY l.forward`,
    args: [MARKET],
  });
  for (const r of ledger.rows) {
    out(
      `  ledger forward=${String(r.f)}: rows=${String(r.n)} closed=${String(r.closed ?? 0)}` +
        ` entries=${String(r.first)}..${String(r.last)}`,
    );
  }
  if (ledger.rows.length === 0) out("  ledger: rows=0");
}

/**
 * D-898: the main books' trades by family over the last `sessions` sessions with fills — closed
 * trades (count, wins, mean and total net after both fees, by exit type) and open trades marked at
 * the latest close. Counts and percentages only (SEC-110): no code or price is printed.
 */
export async function tradesReadout(
  db: Client,
  out: (line: string) => void,
  sessions = 10,
): Promise<void> {
  const days = await db.execute({
    sql: "SELECT DISTINCT d FROM fill ORDER BY d DESC LIMIT ?",
    args: [sessions],
  });
  const ds = days.rows.map((r) => String(r.d)).sort();
  if (ds.length === 0) {
    out("diagnose trades: no fills");
    return;
  }
  const from = ds[0]!;
  const closed = await db.execute({
    sql: `SELECT e.family AS family, t.exit_type AS exit_type,
                 COUNT(*) AS n,
                 SUM(CASE WHEN (x.value_micro - x.brokerage_micro) - (b.value_micro + b.brokerage_micro) > 0
                          THEN 1 ELSE 0 END) AS wins,
                 SUM((x.value_micro - x.brokerage_micro) - (b.value_micro + b.brokerage_micro)) AS net,
                 SUM(b.value_micro + b.brokerage_micro) AS cost
          FROM trade t
          JOIN fill b ON b.id = t.entry_fill_id
          JOIN fill x ON x.id = t.exit_fill_id
          JOIN cohort c ON c.id = t.cohort_id
          JOIN execution e ON e.id = c.execution_id
          WHERE c.control_idx IS NULL AND e.kind = 'E' AND x.d >= ?
          GROUP BY e.family, t.exit_type ORDER BY e.family, t.exit_type`,
    args: [from],
  });
  out(`diagnose trades: closed since ${from} (${ds.length} fill sessions), main E books`);
  for (const r of closed.rows) {
    const n = Number(r.n); // money-float-ok: a trade count
    const cost = Number(r.cost); // money-float-ok: a display percentage, never stored
    const net = Number(r.net); // money-float-ok: a display percentage, never stored
    out(
      `  ${String(r.family)} ${String(r.exit_type)}: trades=${n} wins=${Number(r.wins)} ` +
        `net=${cost > 0 ? ((net / cost) * 100).toFixed(2) : "0.00"}% of cost (A$${(net / 1e6).toFixed(2)})`,
    );
  }
  const open = await db.execute({
    sql: `SELECT e.family AS family, COUNT(*) AS n,
                 SUM(b.qty * 1000000.0 * COALESCE((SELECT p.c FROM price_bar p WHERE p.market = e.market
                       AND p.code = t.code ORDER BY p.d DESC LIMIT 1), 0)) AS mark,
                 SUM(b.value_micro + b.brokerage_micro) AS cost
          FROM trade t
          JOIN fill b ON b.id = t.entry_fill_id
          JOIN cohort c ON c.id = t.cohort_id
          JOIN execution e ON e.id = c.execution_id
          WHERE c.control_idx IS NULL AND e.kind = 'E' AND t.exit_type IS NULL
          GROUP BY e.family ORDER BY e.family`,
    args: [],
  });
  for (const r of open.rows) {
    const cost = Number(r.cost); // money-float-ok: a display percentage, never stored
    const mark = Number(r.mark); // money-float-ok: a display percentage, never stored
    out(
      `  ${String(r.family)} open: trades=${Number(r.n)} marked=${cost > 0 ? (((mark - cost) / cost) * 100).toFixed(2) : "0.00"}% vs cost`,
    );
  }
}

/** Named read-only scenarios that are not a batch-2b night. Counts and shares only. */
export const SCENARIOS = ["splitFrequency"] as const;

async function scenarioMain(
  argv: readonly string[],
  name: string,
  env: Readonly<Record<string, string | undefined>>,
  out: (line: string) => void,
): Promise<number> {
  if (!(SCENARIOS as readonly string[]).includes(name)) {
    out(`diagnose: unknown scenario (${SCENARIOS.join(", ")})`);
    return 2;
  }
  const w = argv.indexOf("--window");
  const window = w >= 0 ? Number(argv[w + 1]) : 20; // money-float-ok: a session-count CLI flag, not money
  if (!Number.isInteger(window) || window < 2) {
    out("diagnose: usage --scenario splitFrequency [--window N>=2]");
    return 2;
  }
  const url = env.TURSO_MAIN_URL;
  if (url === undefined || url.trim() === "") {
    out("diagnose: failed (database not configured)");
    return 1;
  }
  const db = readOnly(createClient({ url, authToken: env.TURSO_MAIN_TOKEN }));
  try {
    const s = await measureSplits(db, window);
    out(`diagnose splitFrequency: ${JSON.stringify(s)}`);
    return 0;
  } catch (error) {
    out(
      `diagnose splitFrequency: failed (${error instanceof WriteRefused ? error.message : (error as Error).name})`,
    );
    return 1;
  } finally {
    db.close();
  }
}

export async function diagnoseMain(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  out: (line: string) => void = (line) => console.log(line),
): Promise<number> {
  const sc = argv.indexOf("--scenario");
  if (sc >= 0) return scenarioMain(argv, argv[sc + 1] ?? "", env, out);
  const i = argv.indexOf("--dates");
  const dates = (i >= 0 ? (argv[i + 1] ?? "") : "").split(",").filter((x) => DATE.test(x));
  if (dates.length === 0) {
    out("diagnose: usage --dates YYYY-MM-DD[,YYYY-MM-DD...]");
    return 2;
  }
  const url = env.TURSO_MAIN_URL;
  if (url === undefined || url.trim() === "") {
    out("diagnose: failed (database not configured)");
    return 1;
  }
  let db: Client;
  try {
    db = readOnly(createClient({ url, authToken: env.TURSO_MAIN_TOKEN, intMode: "bigint" }));
  } catch (error) {
    out(`diagnose: failed (${(error as Error).name})`);
    return 1;
  }
  let code = 0;
  for (const d of dates) {
    try {
      await diagnoseDay(db, d, out);
    } catch (error) {
      out(
        `diagnose ${d}: failed (${error instanceof WriteRefused ? error.message : (error as Error).name})`,
      );
      code = 1;
    }
  }
  try {
    await picksReadiness(db, out);
  } catch (error) {
    out(
      `diagnose picks: failed (${error instanceof WriteRefused ? error.message : (error as Error).name})`,
    );
    code = 1;
  }
  try {
    await tradesReadout(db, out);
  } catch (error) {
    out(
      `diagnose trades: failed (${error instanceof WriteRefused ? error.message : (error as Error).name})`,
    );
    code = 1;
  }
  db.close();
  return code;
}
