// The AT-M report of one market (M20 IN1; D-1120, AT-M1...M5, MKT-111): `docs/test-reports/AT-M-<CODE>.md` from the
// evidence the build produced, and, in a development database only, the `evidence_recorded_at` stamp of the profile.
//
//   node scripts/market/at-m-report.mjs --market IN|US --evidence <dir> [--out <dir>] [--stamp <file: db url>]
//        [--now <ISO instant>] [--check]
//
// Evidence directory (every file is optional; a missing one makes its row "missing", never a pass):
//   source-report-<CODE>.json   the DAT-101 report of the market (scripts/market/source-report.mjs)      -> M1
//   vitest*.json                `vitest run --reporter=json` over the test files named in ROWS below       -> M2 M3 M5
//                               (the root suite and the worker suite are two runs; every vitest*.json is merged)
//   recorded-days-<CODE>.json   the five recorded `data_only` days and the rolling-start replay           -> M4 (+ M2 review)
//        { days: [{ d, status, outcome, quality }], review: boolean,
//          replay: { status, sessions, labels: [{ label, status, reason? }] } }
//
// The rows (D-1120):
//   M1  the source report lists every register row of the market, and the profile is `complete` or its unverified
//       fields are named (completeness is computed from the seed, D-999)
//   M2  the calendar-rule and DST test files passed, and the recorded-day review step was taken
//   M3  the cost-formula test file passed (hand-computed totals)
//   M4  five consecutive recorded days ran green (status ok, outcome complete or partial with its coverage) and the
//       rolling-start replay completed without error with every label computed or "not reachable" with its reason
//   M5  the isolation test passed (AU and the market side by side, hashes equal)
// `--check` exits 1 unless every row passes. The stamp is written only when all five pass, only into a `file:`
// database (never a Turso URL), and only after `assertMarketEnabled`. Counts and test names only: no row, no secret.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { completeness } from "../../src/lib/market/profileCore.mjs";
import { staticProfile } from "../../src/lib/market/staticProfile.mjs";
import { marketSourcesOf } from "../../src/lib/market/seed/sourceSites.mjs";
import { assertMarketEnabled } from "../../src/lib/market/scriptMarket.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MARKET_RE = /^[A-Z]{2}$/;

/** The test files each row needs, per market (lower-case code in the folder names). */
export const ROWS = Object.freeze({
  IN: {
    m2: ["tests/data/calendarRules.in.test.ts", "worker/test/localtime.test.ts"],
    m3: ["tests/markets/in/costs.test.ts"],
    m5: ["tests/market/isolation.test.ts"],
  },
  US: {
    m2: ["tests/data/calendarRules.us.test.ts", "worker/test/localtime.test.ts"],
    m3: ["tests/markets/us/costs.test.ts"],
    m5: ["tests/market/isolation.test.ts"],
  },
});
export const MIN_DAYS = 5;

const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null);

/** Every `vitest*.json` of the evidence folder merged (the root suite and the worker suite are separate runs). */
function readVitest(dir) {
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => /^vitest.*.json$/.test(f))
        .sort()
    : [];
  if (files.length === 0) return null;
  return { testResults: files.flatMap((f) => readJson(path.join(dir, f))?.testResults ?? []) };
}

/** The files of a vitest JSON report with their status and test count, keyed by repo-relative posix path. */
export function vitestFiles(report) {
  /** @type {Map<string, { passed: boolean, tests: number }>} */
  const out = new Map();
  for (const f of report?.testResults ?? []) {
    const rel = String(f.name ?? "")
      .replace(/\\/g, "/")
      .replace(/^.*?\/((?:tests|worker)\/)/, "$1");
    const tests = (f.assertionResults ?? []).length;
    const failed = (f.assertionResults ?? []).some((a) => a.status === "failed");
    out.set(rel, { passed: f.status === "passed" && !failed && tests > 0, tests });
  }
  return out;
}

function fileRow(files, wanted) {
  const missing = wanted.filter((w) => !files.has(w));
  const failed = wanted.filter((w) => files.has(w) && !files.get(w).passed);
  const tests = wanted.reduce((n, w) => n + (files.get(w)?.tests ?? 0), 0);
  if (missing.length > 0) return { pass: false, reason: `missing: ${missing.join(", ")}`, tests };
  if (failed.length > 0) return { pass: false, reason: `failed: ${failed.join(", ")}`, tests };
  return { pass: true, reason: `${wanted.length} files, ${tests} tests passed`, tests };
}

/**
 * @param {{ market: string, evidence: string, now?: Date }} p
 * @returns {{ market: string, rows: { id: string, title: string, pass: boolean, reason: string, lines?: string[] }[], allPass: boolean, unverified: string[] }}
 */
export function buildReport(p) {
  const wanted = ROWS[p.market];
  if (wanted === undefined) throw new RangeError(`no AT-M rows are defined for market ${p.market}`);
  const profile = staticProfile(p.market);
  const comp = completeness(profile);
  const sources = marketSourcesOf(p.market);
  const files = vitestFiles(readVitest(p.evidence));
  const report = readJson(path.join(p.evidence, `source-report-${p.market}.json`));
  const days = readJson(path.join(p.evidence, `recorded-days-${p.market}.json`));
  // every evidence file and its hash, so a reader can tell which run a report rests on
  const names = existsSync(p.evidence)
    ? readdirSync(p.evidence)
        .filter((f) => f.endsWith(".json"))
        .sort()
    : [];
  const evidenceFiles = names.map((f) => ({
    name: f,
    sha12: createHash("sha256")
      .update(readFileSync(path.join(p.evidence, f)))
      .digest("hex")
      .slice(0, 12),
  }));
  const unverified = comp.complete ? [] : [...comp.missing, ...comp.unverified].sort();
  const rows = [];

  // M1
  const listed = new Set((report?.sources ?? []).map((s) => s.id));
  const m1ok = report !== null && sources.every((s) => listed.has(s.id));
  rows.push({
    id: "M1",
    title: "Source report and profile completeness",
    pass: m1ok,
    reason:
      report === null
        ? "missing: source-report-" + p.market + ".json"
        : m1ok
          ? `${listed.size} sources reported (the report's own date, UTC: ${report.checked_at}); profile ${comp.complete ? "complete" : "incomplete, unverified fields named below"}`
          : "the report does not list every register row",
    lines: (report?.sources ?? []).map(
      (s) => `${s.id}: ${s.seeded_status}; terms ${s.terms?.status}; probe ${s.probe?.result}`,
    ),
  });

  // M2
  const m2 = fileRow(files, wanted.m2);
  const review = days?.review === true;
  rows.push({
    id: "M2",
    title: "Calendar rules, DST and the recorded-day review step",
    pass: m2.pass && review,
    reason: m2.pass
      ? review
        ? m2.reason + "; review step taken"
        : "the review step was not recorded"
      : m2.reason,
  });

  // M3
  const m3 = fileRow(files, wanted.m3);
  rows.push({ id: "M3", title: "Cost formula known answers", pass: m3.pass, reason: m3.reason });

  // M4
  const dayList = days?.days ?? [];
  const green = dayList.filter(
    (x) => x.status === "ok" && /^(complete|partial:)/.test(String(x.outcome)),
  );
  const consecutive = dayList.every((x, i) => i === 0 || String(dayList[i - 1].d) < String(x.d));
  const rep = days?.replay;
  const labelsOk =
    Array.isArray(rep?.labels) &&
    rep.labels.length > 0 &&
    rep.labels.every((l) => l.status === "computed" || (l.status === "not_reachable" && l.reason));
  const m4ok = green.length >= MIN_DAYS && consecutive && rep?.status === "completed" && labelsOk;
  rows.push({
    id: "M4",
    title: "Five recorded data_only days and the rolling-start replay",
    pass: m4ok,
    reason:
      days === null
        ? "missing: recorded-days-" + p.market + ".json"
        : `${green.length} of ${dayList.length} days green; replay ${rep?.status ?? "not run"}${rep ? ` over ${rep.sessions} sessions` : ""}; labels ${labelsOk ? "computed or not reachable with a reason" : "not all accounted for"}`,
    lines: [
      ...dayList.map(
        (x) => `${x.d}: ${x.status}, ${x.outcome}${x.quality ? `, quality ${x.quality}` : ""}`,
      ),
      ...(rep?.labels ?? []).map(
        (l) => `label ${l.label}: ${l.status}${l.reason ? ` (${l.reason})` : ""}`,
      ),
    ],
  });

  // M5
  const m5 = fileRow(files, wanted.m5);
  rows.push({ id: "M5", title: "Market isolation", pass: m5.pass, reason: m5.reason });

  return {
    market: p.market,
    rows,
    allPass: rows.every((r) => r.pass),
    unverified,
    evidenceDir: path.resolve(p.evidence),
    evidenceFiles,
  };
}

/** @param {ReturnType<typeof buildReport>} r @param {string} date */
export function renderMarkdown(r, date) {
  const out = [
    `# AT-M-${r.market}: market acceptance in development mode`,
    "",
    `Generated ${date} by \`scripts/market/at-m-report.mjs --market ${r.market}\` from the build's evidence files. Counts, test names and dates only.`,
    "",
    `Result: **${
      r.allPass
        ? "all five rows pass"
        : "not complete: " +
          r.rows
            .filter((x) => !x.pass)
            .map((x) => x.id)
            .join(", ")
    }**`,
    "",
    `Evidence folder: \`${r.evidenceDir.split(path.sep).join("/")}\``,
    "",
    ...(r.evidenceFiles.length === 0
      ? ["No evidence files."]
      : r.evidenceFiles.map((f) => `- \`${f.name}\` sha256 ${f.sha12}`)),
    "",
    "| Row | What | Result | Evidence |",
    "|---|---|---|---|",
    ...r.rows.map((x) => `| ${x.id} | ${x.title} | ${x.pass ? "pass" : "NOT YET"} | ${x.reason} |`),
    "",
  ];
  if (r.unverified.length > 0) {
    out.push(
      "Unverified profile fields (named, PRD-039):",
      "",
      ...r.unverified.map((f) => `- ${f}`),
      "",
    );
  }
  for (const x of r.rows) {
    if (x.lines && x.lines.length > 0)
      out.push(`## ${x.id} detail`, "", ...x.lines.map((l) => `- ${l}`), "");
  }
  return out.join("\n");
}

/**
 * Stamp `market_profile.evidence_recorded_at` in a DEVELOPMENT database. Refuses a URL that is not `file:`, a market
 * that is not enabled in that database, and a report that is not fully green.
 * @param {{ execute: Function }} db @param {string} url @param {ReturnType<typeof buildReport>} r @param {string} at
 */
export async function stampEvidence(db, url, r, at) {
  if (!url.startsWith("file:"))
    throw new Error("refused: the stamp is written into a development database only");
  if (!r.allPass) throw new Error("refused: every AT-M row must pass first");
  await assertMarketEnabled(db, r.market);
  await db.execute({
    sql: "UPDATE market_profile SET evidence_recorded_at = ? WHERE code = ?",
    args: [at, r.market],
  });
}

/** @param {string[]} argv */
export async function run(argv, deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const a = {};
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === "--check") a.check = true;
    else if (["--market", "--evidence", "--out", "--stamp", "--now"].includes(k) && argv[i + 1])
      a[k.slice(2)] = argv[++i];
    else {
      out(
        "at-m-report: usage: --market IN|US --evidence <dir> [--out <dir>] [--stamp <file: db url>] [--check]",
      );
      return 2;
    }
  }
  if (!MARKET_RE.test(a.market ?? "") || !a.evidence) {
    out("at-m-report: --market and --evidence are required");
    return 2;
  }
  const now = a.now ? new Date(a.now) : (deps.now ?? (() => new Date()))();
  let r;
  try {
    r = buildReport({ market: a.market, evidence: path.resolve(a.evidence), now });
  } catch (e) {
    out(`at-m-report: ${e instanceof RangeError ? e.message : "failed"}`);
    return 2;
  }
  const dir = path.resolve(a.out ?? path.join(REPO, "docs", "test-reports"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `AT-M-${a.market}.md`),
    renderMarkdown(r, now.toISOString().slice(0, 10)),
  );
  out(
    `at-m-report: ${a.market} ${r.rows.map((x) => `${x.id}=${x.pass ? "pass" : "no"}`).join(" ")}`,
  );
  if (a.stamp) {
    try {
      const open = deps.openDb;
      if (!open) throw new Error("refused: no database opener");
      const db = open(a.stamp);
      await stampEvidence(db, a.stamp, r, now.toISOString());
      out("at-m-report: evidence_recorded_at stamped");
    } catch (e) {
      out(
        `at-m-report: ${e instanceof Error ? e.message.split("\n")[0].slice(0, 120) : "stamp failed"}`,
      );
      return 1;
    }
  }
  return a.check && !r.allPass ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { scriptDb } = await import("../../src/lib/db/scriptClient.mjs");
  process.exit(await run(process.argv.slice(2), { openDb: (url) => scriptDb({ url }) }));
}
