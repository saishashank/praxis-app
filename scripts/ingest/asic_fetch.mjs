// ASIC short-position fetch for Batch 1 (M4 T3, design decision 13). Runs in a workflow step that
// has NO secrets and no database: it reads the `short_dates` of request.json (written by
// `batch1.mjs prepare`), downloads those daily files with the polite backfill fetcher
// (src/lib/data/backfill/asicFetch.mjs: one request at a time, identifying User-Agent, GET only,
// no redirects, stops at once on 403/429/challenge/error) and writes short.json.
//   node scripts/ingest/asic_fetch.mjs --request request.json --output short.json
// Output: { stopped, dates, absent, skipped, rows } (rows as the shared ASIC parser makes them).
// A stop is recorded in the file and the exit code stays 0: the writer reports it in the run
// record. Logs carry counts and statuses only.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fetchAsicMonths } from "../../src/lib/data/backfill/asicFetch.mjs";
import { isRealDate } from "../../src/lib/data/pipeline/rules.mjs";

export const DEFAULT_USER_AGENT = "praxis-ingest (personal research client)";
const MAX_DATES = 12;
const flag = (args, name) => {
  const i = args.indexOf(name);
  return i >= 0 && typeof args[i + 1] === "string" && args[i + 1] !== "" ? args[i + 1] : null;
};

/**
 * @param {string[]} argv @param {Record<string, string | undefined>} env
 * @param {{ out?: (s: string) => void, fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void> }} [deps]
 */
export async function run(argv, env, deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const reqPath = flag(argv, "--request");
  const outPath = flag(argv, "--output");
  if (reqPath === null || outPath === null) {
    out("asic_fetch: failed (--request <file> --output <file> are required)");
    return 2;
  }
  let dates;
  try {
    const raw = JSON.parse(readFileSync(reqPath, "utf8"));
    dates = Array.isArray(raw.short_dates) ? raw.short_dates : [];
  } catch {
    out("asic_fetch: failed (request file unreadable)");
    return 2;
  }
  if (!dates.every(isRealDate) || dates.length > MAX_DATES) {
    out("asic_fetch: failed (short_dates invalid)");
    return 2;
  }
  const ua =
    env.ASIC_USER_AGENT && env.ASIC_USER_AGENT.trim() ? env.ASIC_USER_AGENT : DEFAULT_USER_AGENT;
  const res =
    dates.length === 0
      ? { months: [], stopped: null }
      : await fetchAsicMonths({
          months: [{ month: "batch1", dates }],
          userAgent: ua,
          fetchImpl: deps.fetchImpl,
          sleep: deps.sleep,
        });
  const m = res.months[0];
  const file = {
    stopped: res.stopped,
    dates: dates.length,
    absent: m?.absent ?? 0,
    skipped: m?.skipped ?? 0,
    rows: m?.rows ?? [],
  };
  writeFileSync(`${outPath}.tmp`, JSON.stringify(file));
  renameSync(`${outPath}.tmp`, outPath);
  out(
    `asic_fetch: dates=${file.dates} absent=${file.absent} rows=${file.rows.length} skipped=${file.skipped} stopped=${file.stopped ?? "none"}`,
  );
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await run(process.argv.slice(2), process.env));
}
