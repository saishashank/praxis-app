// Staging E2E day deadline check (M8 T12; docs/M8_design.md 2.2, decision 45; TST-106, AT-28).
// Run by .github/workflows/staging-e2e-day.yml after the 20:45 email window. Reads the run records
// of one Melbourne date from the staging main database (read-only) and prints, per PLT-073 step,
// on time / late / missing / not due. Exit 0 when no step is late or missing, 1 otherwise, 2 on a
// usage or connection problem.
//   env: TURSO_MAIN_URL, TURSO_MAIN_TOKEN (staging, read), PRAXIS_ENV (default staging),
//        GITHUB_STEP_SUMMARY (set by Actions).
//   args: --date YYYY-MM-DD (default: today in Melbourne)
// Output is step names and HH:MM times only (SEC-110): no URL, token, row or data value. A
// connection error prints a fixed sentence, never the driver's message (it can hold the URL).
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const has = (v) => typeof v === "string" && v.trim() !== "";

/** Today's date in Australia/Melbourne as YYYY-MM-DD. */
export function melbourneDate(now) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function parseArgs(argv) {
  const out = { date: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--date" && i + 1 < argv.length) out.date = argv[++i];
    else return { error: "usage: check.mjs [--date YYYY-MM-DD]" };
  }
  if (out.date !== null && !DATE.test(out.date)) return { error: "the date must be YYYY-MM-DD" };
  return out;
}

/**
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} env
 * @param {{ lib?: any, openDb?: (env: any) => Promise<any>, now?: () => Date,
 *   out?: (s: string) => void, summary?: (s: string) => void }} deps
 * @returns {Promise<number>} exit code
 */
export async function main(argv, env, deps = {}) {
  const out = deps.out ?? ((s) => process.stdout.write(`${s}\n`));
  const args = parseArgs(argv);
  if (args.error) {
    out(args.error);
    return 2;
  }
  if (!has(env.TURSO_MAIN_URL) || !has(env.TURSO_MAIN_TOKEN)) {
    out("the staging database is not configured");
    return 2;
  }
  const summary =
    deps.summary ??
    ((s) => {
      if (has(env.GITHUB_STEP_SUMMARY)) appendFileSync(env.GITHUB_STEP_SUMMARY, `${s}\n`);
    });
  const now = (deps.now ?? (() => new Date()))();
  const date = args.date ?? melbourneDate(now);
  const lib = deps.lib ?? (await (await import("./lib.mjs")).loadDeadlines());
  const openDb =
    deps.openDb ??
    (async (e) => {
      const { createClient } = await import("@libsql/client");
      return createClient({ url: e.TURSO_MAIN_URL, authToken: e.TURSO_MAIN_TOKEN });
    });
  let db;
  let rows;
  try {
    db = await openDb(env);
    rows = await lib.checkDay(db, date, now, has(env.PRAXIS_ENV) ? env.PRAXIS_ENV : "staging");
  } catch {
    out("the deadline check could not read the staging database");
    return 2;
  } finally {
    try {
      db?.close?.();
    } catch {
      /* nothing to report */
    }
  }
  const pass = lib.dayPasses(rows);
  const bad = rows.filter((r) => r.status === "late" || r.status === "missing").length;
  const table = lib.renderTable(rows);
  const head = `Day timeline check for ${date}: ${pass ? "PASS" : `FAIL (${bad} step${bad === 1 ? "" : "s"} late or missing)`}`;
  out(`${head}\n${table}`);
  summary(`### ${head}\n\n${table}\n`);
  return pass ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    () => {
      process.stdout.write("the deadline check stopped unexpectedly\n");
      process.exit(2);
    },
  );
}
