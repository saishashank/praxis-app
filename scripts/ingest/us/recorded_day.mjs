// The recorded-day source for the US (M20 US1; D-1119, D-1188): replaces the fetch step in development mode and in the
// `recorded-day-dev` job. It reads one SYNTHETIC session folder of the private fixtures repo
// (`<fixtures>/recorded/<CODE>/<date>/`, written by scripts/ingest/us/synthetic.mjs, see its README) and writes the two files
// the database step reads, `bars.json` and `feeds.json`.
//   node scripts/ingest/us/recorded_day.mjs --fixtures fixtures --market <CODE> --date 2026-11-02 --bars-output bars.json --feeds-output feeds.json
// Like `scripts/ingest/recorded_day.mjs` it needs PRAXIS_ENV=recorded (or staging), installs the host guard first (any
// request throws) and makes no request, uses no secret and touches no database. Output: counts only.
import { readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installHostGuard } from "../../../src/lib/data/recorded/hostGuard.mjs";
import { buildFeeds } from "./feeds.mjs";

const flag = (args, name) => {
  const i = args.indexOf(name);
  return i >= 0 && typeof args[i + 1] === "string" && args[i + 1] !== "" ? args[i + 1] : null;
};
const writeJson = (file, value) => {
  writeFileSync(`${file}.tmp`, JSON.stringify(value));
  renameSync(`${file}.tmp`, file);
};
const readIf = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

/** Read a session folder into the files of the night. @param {string} dir the session folder */
export function readSession(dir) {
  const bars = JSON.parse(readFileSync(path.join(dir, "bars.json"), "utf8"));
  const submissions = {};
  const documents = {};
  const edgar = path.join(dir, "edgar");
  let names = [];
  try {
    names = readdirSync(edgar);
  } catch {
    names = [];
  }
  for (const n of names) {
    const sub = /^submissions-([A-Z0-9.\-]+)\.json$/.exec(n);
    if (sub) submissions[sub[1]] = JSON.parse(readFileSync(path.join(edgar, n), "utf8"));
    const doc = /^(?:form4|schedule13)-(\d{10}-\d{2}-\d{6})\.xml$/.exec(n);
    if (doc) documents[doc[1]] = readFileSync(path.join(edgar, n), "utf8");
  }
  let finraDaily = null;
  try {
    const f = readdirSync(path.join(dir, "finra")).find((x) => /^CNMSshvol\d{8}\.txt$/.test(x));
    if (f) finraDaily = readFileSync(path.join(dir, "finra", f), "utf8");
  } catch {
    finraDaily = null;
  }
  const indexCsv = {};
  try {
    for (const f of readdirSync(path.join(dir, "index"))) {
      const m = /^([A-Z0-9]+)\.csv$/.exec(f);
      if (m) indexCsv[m[1]] = readFileSync(path.join(dir, "index", f), "utf8");
    }
  } catch {
    /* no index files */
  }
  const feeds = buildFeeds({
    submissions,
    documents,
    finraDaily,
    halts: readIf(path.join(dir, "halts", "halts.xml")),
    suspensions: readIf(path.join(dir, "halts", "suspensions.xml")),
    indexCsv,
  });
  return { bars, feeds };
}

/** @param {string[]} argv @param {Record<string, string | undefined>} env @param {{ out?: (s: string) => void }} [deps] */
export async function run(argv, env, deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  if (env.PRAXIS_ENV !== "staging" && env.PRAXIS_ENV !== "recorded") {
    out(
      "us_recorded_day: failed (runs on recorded days only, PRAXIS_ENV must be recorded or staging)",
    );
    return 2;
  }
  const uninstall = installHostGuard(env);
  try {
    const fixtures = flag(argv, "--fixtures");
    const market = flag(argv, "--market");
    const date = flag(argv, "--date");
    const barsOut = flag(argv, "--bars-output");
    const feedsOut = flag(argv, "--feeds-output");
    if (
      [fixtures, market, date, barsOut, feedsOut].includes(null) ||
      !/^[A-Z][A-Z0-9]{1,7}$/.test(market)
    ) {
      out(
        "us_recorded_day: failed (--fixtures, --market, --date, --bars-output and --feeds-output are required)",
      );
      return 2;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      out("us_recorded_day: failed (--date must be YYYY-MM-DD)");
      return 2;
    }
    let session;
    try {
      session = readSession(path.join(fixtures, "recorded", market.toLowerCase(), date));
    } catch {
      out("us_recorded_day: failed (the recorded session is unreadable)");
      return 2;
    }
    writeJson(barsOut, session.bars);
    writeJson(feedsOut, session.feeds);
    out(
      `us_recorded_day: ok bars=${session.bars.length} submissions=${session.feeds.submissions.length} form4=${session.feeds.form4.length}`,
    );
    return 0;
  } finally {
    uninstall();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await run(process.argv.slice(2), process.env));
}
