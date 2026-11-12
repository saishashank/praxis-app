// Recorded-day source for STAGING ingest (M8 T9, decision 31, NFR-040). Replaces the Yahoo and ASIC
// fetch steps of batch 1 on staging: it reads one recorded AU trading day from the private fixtures
// repo checkout, re-dates it onto the run's trading dates (src/lib/data/recorded/redate.mjs) and
// writes the same files the live fetch steps write, so `batch1.mjs run` is unchanged.
//   node scripts/ingest/recorded_day.mjs --request request.json --fixtures fixtures \
//        --output bars.json --index-output index.json --short-output short.json \
//        [--announcements-output a.json] [--actions-output c.json] [--date YYYY-MM-DD]
//        [--market CODE]   another market (D-1180): reads recorded/<code lower>/<date>/ and copies its day files into the
//                          --output DIRECTORY unchanged; without it the AU recording is read exactly as before
// It needs PRAXIS_ENV=staging or recorded (M18 D-965: the CI recorded day; it refuses to run anywhere else, so recorded data never reaches
// production) and installs the host guard first: any request to ASX or Yahoo throws. It makes no
// network request itself and needs no secret and no database. Only bars whose code the request
// asked for are kept. Output: counts only, never a code, row, path or URL (SEC-110).
// Exit 0 ok, 2 usage / environment / unreadable recording.
import fs, { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installHostGuard } from "../../src/lib/data/recorded/hostGuard.mjs";
import {
  MARKET_DAY_FILES,
  readRecordedDay,
  RecordedDayError,
} from "../../src/lib/data/recorded/reader.mjs";
import { HOME_MARKET } from "../../src/lib/market/profileCore.mjs";
import { isIsoDate, redateDay, weekdaysBetween } from "../../src/lib/data/recorded/redate.mjs";

const flag = (args, name) => {
  const i = args.indexOf(name);
  return i >= 0 && typeof args[i + 1] === "string" && args[i + 1] !== "" ? args[i + 1] : null;
};

const writeJson = (file, value) => {
  writeFileSync(`${file}.tmp`, JSON.stringify(value));
  renameSync(`${file}.tmp`, file);
};

/**
 * @param {string[]} argv @param {Record<string, string | undefined>} env
 * @param {{ out?: (s: string) => void }} [deps]
 */
export async function run(argv, env, deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  if (env.PRAXIS_ENV !== "staging" && env.PRAXIS_ENV !== "recorded") {
    out("recorded_day: failed (runs on staging only, PRAXIS_ENV must be staging or recorded)");
    return 2;
  }
  const uninstall = installHostGuard(env);
  try {
    const market = flag(argv, "--market");
    const reqPath = flag(argv, "--request");
    const fixtures = flag(argv, "--fixtures");
    const barsOut = flag(argv, "--output");
    if (reqPath === null || fixtures === null || barsOut === null) {
      out("recorded_day: failed (--request, --fixtures and --output are required)");
      return 2;
    }
    let request;
    try {
      request = JSON.parse(readFileSync(reqPath, "utf8"));
    } catch {
      out("recorded_day: failed (request file unreadable)");
      return 2;
    }
    const shortDates = Array.isArray(request.short_dates) ? request.short_dates : [];
    let sessionDates;
    try {
      if (!shortDates.every(isIsoDate)) throw new Error("short_dates");
      sessionDates = weekdaysBetween(request.start, request.end);
    } catch {
      out("recorded_day: failed (request dates invalid)");
      return 2;
    }
    let day;
    try {
      day = readRecordedDay(fixtures, {
        date: flag(argv, "--date") ?? undefined,
        market: market ?? undefined,
      });
    } catch (e) {
      out(
        `recorded_day: failed (recording unreadable: ${e instanceof RecordedDayError ? e.code : "error"})`,
      );
      return 2;
    }
    if (market !== null && market !== HOME_MARKET) {
      // another market (D-1180): the day files are copied unchanged into the --output DIRECTORY; the market's own
      // batch 1 reads them (a recorded day is replayed under the simulated clock of the job, not re-dated)
      fs.mkdirSync(barsOut, { recursive: true });
      for (const [k, text] of Object.entries(day.files))
        fs.writeFileSync(path.join(barsOut, MARKET_DAY_FILES[k]), text);
      out(`recorded_day: market=${market} files=${Object.keys(day.files).length} date=${day.date}`);
      return 0;
    }
    const res = redateDay(day, { sessionDates, shortDates });
    const want = Array.isArray(request.codes) ? new Set(request.codes) : null;
    const bars = want === null ? res.bars : res.bars.filter((b) => want.has(String(b.code)));

    writeJson(barsOut, bars);
    const indexOut = flag(argv, "--index-output");
    if (indexOut !== null) writeJson(indexOut, res.index);
    const shortOut = flag(argv, "--short-output");
    if (shortOut !== null) {
      writeJson(
        shortOut,
        res.short ?? { stopped: null, dates: shortDates.length, absent: 0, skipped: 0, rows: [] },
      );
    }
    const annOut = flag(argv, "--announcements-output");
    if (annOut !== null) writeJson(annOut, res.announcements);
    const actOut = flag(argv, "--actions-output");
    if (actOut !== null) writeJson(actOut, res.corporateActions);

    out(
      `recorded_day: bars=${bars.length} index=${res.index.length} short=${res.short?.rows.length ?? 0} announcements=${res.announcements.length} actions=${res.corporateActions.length} sessions=${res.report.sessionsKept}/${res.report.sessionsRecorded} rows_dropped=${res.report.rowsDropped} not_requested=${res.bars.length - bars.length}`,
    );
    return 0;
  } finally {
    uninstall();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await run(process.argv.slice(2), process.env));
}
