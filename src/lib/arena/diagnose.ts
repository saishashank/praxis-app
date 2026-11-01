// Read-only diagnosis of batch 2b (live defect: production records signals=0 every night). It runs
// the same inputs path as signalsDay (loadAgentParams -> loadVersionSet -> liveParams ->
// loadDayInputs -> runVersions) for the given sessions and prints counts only, then the same day
// inputs once more with the default parameters, so "the data" and "the live parameters" can be told
// apart. Bundled and run by scripts/arena/diagnose.mjs (.github/workflows/diagnose-signals.yml).
//
//   diagnose --dates YYYY-MM-DD[,YYYY-MM-DD...]
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

export async function diagnoseMain(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  out: (line: string) => void = (line) => console.log(line),
): Promise<number> {
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
  db.close();
  return code;
}
