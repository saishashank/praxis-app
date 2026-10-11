// ASIC short-position fetch step of the history backfill (M2 T9, DAT-125a). Runs in a workflow
// step with NO secrets and NO database access: it reads plan.json (written by `run.mjs plan`) and
// writes chunks.json for `run.mjs commit`. Both files stay on the runner (SEC-110: never uploaded
// as artifacts or cached). Output: counts and statuses only. Exit 1 when the source stopped the
// run (403, 429, error); months finished before that are still written.
//   node scripts/backfill/fetch-asic.mjs --plan plan.json --output chunks.json
// env (optional): BACKFILL_USER_AGENT (identifying; a default is used otherwise)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fetchAsicMonths } from "../../src/lib/data/backfill/asicFetch.mjs";
import { isMonth, isRealDate } from "../../src/lib/data/backfill/rules.mjs";

export const DEFAULT_USER_AGENT = "praxis-history-backfill (personal research client)";
const has = (v) => typeof v === "string" && v.trim() !== "";

/** @param {string[]} args @param {string} name */
const flag = (args, name) => {
  const i = args.indexOf(name);
  return i >= 0 && has(args[i + 1]) ? args[i + 1] : null;
};

/**
 * @param {string[]} argv @param {Record<string, string | undefined>} env
 * @param {{ fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void>,
 *   out?: (s: string) => void }} [deps]
 */
export async function run(argv, env, deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const planPath = flag(argv, "--plan");
  const outPath = flag(argv, "--output");
  if (planPath === null || outPath === null) {
    out("backfill fetch: failed (usage: --plan <file> --output <file>)");
    return 1;
  }
  let months;
  try {
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    months = plan.months;
    const ok =
      Array.isArray(months) &&
      months.length <= 12 &&
      months.every(
        (m) =>
          isMonth(m?.month) &&
          Array.isArray(m.dates) &&
          m.dates.length <= 31 &&
          m.dates.every((d) => isRealDate(d) && d.startsWith(m.month)),
      );
    if (!ok) throw new Error("bad plan");
  } catch {
    out("backfill fetch: failed (unreadable plan)");
    return 1;
  }
  const res = await fetchAsicMonths({
    months,
    userAgent: has(env.BACKFILL_USER_AGENT) ? env.BACKFILL_USER_AGENT : DEFAULT_USER_AGENT,
    fetchImpl: deps.fetchImpl,
    sleep: deps.sleep,
  });
  writeFileSync(outPath, JSON.stringify(res));
  const rows = res.months.reduce((a, m) => a + m.rows.length, 0);
  const done = res.months.filter((m) => m.complete).length;
  out(
    `backfill fetch: ${res.stopped === null ? "ok" : `stopped (${res.stopped})`} months=${done}/${months.length} rows=${rows}`,
  );
  return res.stopped === null ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await run(process.argv.slice(2), process.env));
}
