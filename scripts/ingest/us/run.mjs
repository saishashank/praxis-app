// The US batch-1 database step (M20 US1; D-1127, D-1180). The home CLI (`scripts/ingest/batch1.mjs`) does not pass a
// feeds file to a market's day module, so the US has its own thin step; it reaches the same dispatcher
// (`runBatch1` -> `sources/us/day.mjs`), so the guard, the run record and the exit codes are the home pipeline's.
//   node scripts/ingest/us/run.mjs prepare --market <CODE> --request request.json
//   node scripts/ingest/us/run.mjs run     --market <CODE> --bars bars.json [--feeds feeds.json]
// env: TURSO_MAIN_URL, TURSO_MAIN_TOKEN, COMMIT_SHA (optional). `--now <ISO>` simulates the clock on a recorded day
// (refused unless PRAXIS_ENV=recorded, as the home CLI). Output: statuses and counts only. A market that is not
// enabled exits 2 with "refused: market not enabled" before anything is read or written (AT-70, MKT-110 a).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { scriptDb } from "../../../src/lib/db/scriptClient.mjs";
import { prepareBatch1, runBatch1 } from "../../../src/lib/data/pipeline/batch1-core.mjs";
import { resolveScriptMarket, takeMarketFlag } from "../../../src/lib/market/scriptMarket.mjs";
import { parseNow } from "../../e2e-day/now.mjs";

const has = (v) => typeof v === "string" && v.trim() !== "";
const flag = (args, name) => {
  const i = args.indexOf(name);
  return i >= 0 && has(args[i + 1]) ? args[i + 1] : null;
};
const readOptional = (p) => {
  if (p === null) return null;
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null; // the day records a visible failure if it needed the file
  }
};

/**
 * @param {string[]} argv @param {Record<string, string | undefined>} env
 * @param {{ openDb?: (url: string, token: string | undefined) => any, nowMs?: () => number, out?: (s: string) => void, dayLoader?: Function }} [deps]
 */
export async function run(argv, env, deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const sim = parseNow(argv, env);
  if (sim.error) {
    out(`us-batch1: failed (${sim.error})`);
    return 2;
  }
  const nowMs = sim.nowMs ?? deps.nowMs ?? (() => Date.now());
  const mk = takeMarketFlag(sim.argv);
  if (mk.error) {
    out(`us-batch1: failed (${mk.error})`);
    return 2;
  }
  const [cmd, ...rest] = mk.argv;
  if (cmd !== "prepare" && cmd !== "run") {
    out("us-batch1: failed (usage: prepare --request <file> | run --bars <file> [--feeds <file>])");
    return 1;
  }
  const url = env.TURSO_MAIN_URL;
  const token = env.TURSO_MAIN_TOKEN;
  if (!has(url) || (!has(token) && !String(url).startsWith("file:"))) {
    out(`us-batch1 ${cmd}: failed (database not configured)`);
    return 1;
  }
  let db;
  try {
    db = (deps.openDb ?? ((u, t) => scriptDb({ url: u, token: t })))(
      url,
      has(token) ? token : undefined,
    );
  } catch {
    out(`us-batch1 ${cmd}: failed (cannot open database)`);
    return 1;
  }
  try {
    const m = await resolveScriptMarket(db, mk.market);
    if (!m.ok) {
      out(`us-batch1 ${cmd}: ${m.line}`);
      return m.exit;
    }
    if (cmd === "prepare") {
      const reqPath = flag(rest, "--request");
      if (reqPath === null) {
        out("us-batch1 prepare: failed (--request <file> is required)");
        return 1;
      }
      const r = await prepareBatch1(db, {
        nowMs: nowMs(),
        market: m.market,
        dayLoader: deps.dayLoader,
      });
      if (r.action === "fetch") {
        writeFileSync(reqPath, JSON.stringify(r.request));
        out(`us-batch1 prepare: fetch dates=${r.dates} codes=${r.codes} excluded=${r.excluded}`);
      } else {
        out(`us-batch1 prepare: no fetch (${r.reason ?? "nothing to fetch"})`);
      }
      return 0;
    }
    const res = await runBatch1(db, {
      nowMs,
      market: m.market,
      barsText: readOptional(flag(rest, "--bars")),
      feedsText: readOptional(flag(rest, "--feeds")),
      commitSha: has(env.COMMIT_SHA) ? env.COMMIT_SHA : undefined,
      dayLoader: deps.dayLoader,
    });
    const sum = (k) => res.dates.reduce((a, d) => a + (d[k] ?? 0), 0);
    out(
      `us-batch1: ${res.status}${res.reason ? ` (${res.reason})` : ""} target=${res.target} dates=${res.dates.length} read=${sum("rowsRead")} written=${sum("rowsWritten")} bars=${sum("bars")} rejected=${sum("rejected")}`,
    );
    return res.exit;
  } catch {
    out(`us-batch1 ${cmd}: failed (unexpected error)`);
    return 1;
  } finally {
    db.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await run(process.argv.slice(2), process.env));
}
