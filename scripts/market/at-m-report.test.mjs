// M20 IN1 (D-1120, AT-M1...M5): the AT-M report from evidence files. No network. A row passes only on evidence;
// a missing file is "missing", never a pass; the stamp is written into a development database only, after all five pass.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { marketSourcesOf } from "../../src/lib/market/seed/sourceSites.mjs";
import {
  MIN_DAYS,
  ROWS,
  buildReport,
  renderMarkdown,
  run,
  stampEvidence,
  vitestFiles,
} from "./at-m-report.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "atm-"));
const write = (dir, name, v) =>
  fs.writeFileSync(path.join(dir, name), typeof v === "string" ? v : JSON.stringify(v));

const vitestJson = (names, status = "passed") => ({
  testResults: names.map((n) => ({
    name: path.resolve("D:/x/repo", n),
    status,
    assertionResults: [{ status: status === "passed" ? "passed" : "failed" }, { status: "passed" }],
  })),
});
const allNames = () => Object.values(ROWS.IN).flat();
const report = () => ({
  market: "IN",
  checked_at: "2026-11-13",
  sources: marketSourcesOf("IN").map((s) => ({
    id: s.id,
    seeded_status: s.status,
    terms: { status: "ok" },
    probe: { result: "ok" },
  })),
});
const days = (n = 5, over = {}) => ({
  review: true,
  days: Array.from({ length: n }, (_, i) => ({
    d: `2026-11-0${i + 2}`,
    status: "ok",
    outcome: "complete",
  })),
  replay: {
    status: "completed",
    sessions: 5,
    labels: [
      { label: "L1", status: "computed" },
      { label: "L2", status: "not_reachable", reason: "5 sessions" },
    ],
  },
  ...over,
});

function evidence({ vitest = vitestJson(allNames()), rep = report(), rd = days() } = {}) {
  const dir = tmp();
  if (vitest) write(dir, "vitest.json", vitest);
  if (rep) write(dir, "source-report-IN.json", rep);
  if (rd) write(dir, "recorded-days-IN.json", rd);
  return dir;
}
const byId = (r) => Object.fromEntries(r.rows.map((x) => [x.id, x]));

test("vitest paths are reduced to repo-relative posix paths", () => {
  const m = vitestFiles(vitestJson(["tests/markets/in/costs.test.ts"]));
  assert.equal(m.get("tests/markets/in/costs.test.ts").passed, true);
});

test("all evidence present: five rows pass", () => {
  const r = buildReport({ market: "IN", evidence: evidence() });
  assert.deepEqual(
    r.rows.map((x) => [x.id, x.pass]),
    [
      ["M1", true],
      ["M2", true],
      ["M3", true],
      ["M4", true],
      ["M5", true],
    ],
  );
  assert.equal(r.allPass, true);
});

test("no evidence: every row is 'not yet', none is a pass", () => {
  const r = buildReport({
    market: "IN",
    evidence: evidence({ vitest: null, rep: null, rd: null }),
  });
  assert.equal(r.allPass, false);
  assert.ok(r.rows.every((x) => x.pass === false));
  assert.match(byId(r).M1.reason, /^missing/);
});

test("a failing cost test file fails M3 only; a missing review step fails M2", () => {
  const failing = vitestJson(allNames());
  failing.testResults.find((f) => f.name.endsWith("costs.test.ts")).status = "failed";
  const r = buildReport({
    market: "IN",
    evidence: evidence({ vitest: failing, rd: days(5, { review: false }) }),
  });
  assert.equal(byId(r).M3.pass, false);
  assert.equal(byId(r).M2.pass, false);
  assert.equal(byId(r).M5.pass, true);
});

test("M4 needs five green days, a completed replay and every label accounted for", () => {
  assert.equal(MIN_DAYS, 5);
  const four = buildReport({ market: "IN", evidence: evidence({ rd: days(4) }) });
  assert.equal(byId(four).M4.pass, false);
  const noReason = buildReport({
    market: "IN",
    evidence: evidence({
      rd: days(5, {
        replay: {
          status: "completed",
          sessions: 5,
          labels: [{ label: "L2", status: "not_reachable" }],
        },
      }),
    }),
  });
  assert.equal(byId(noReason).M4.pass, false);
  const failedDay = days(5);
  failedDay.days[2].status = "failed";
  assert.equal(
    byId(buildReport({ market: "IN", evidence: evidence({ rd: failedDay }) })).M4.pass,
    false,
  );
});

test("M1: a report that omits a register row is not complete", () => {
  const rep = report();
  rep.sources.pop();
  assert.equal(byId(buildReport({ market: "IN", evidence: evidence({ rep }) })).M1.pass, false);
});

test("the Markdown names unverified profile fields and every row", () => {
  const r = buildReport({ market: "IN", evidence: evidence() });
  const md = renderMarkdown(r, "2026-11-13");
  assert.match(md, /^# AT-M-IN/);
  for (const id of ["M1", "M2", "M3", "M4", "M5"]) assert.match(md, new RegExp(`\\| ${id} \\|`));
  if (r.unverified.length > 0) assert.match(md, /Unverified profile fields/);
});

test("an unknown market has no rows", () => {
  assert.throws(() => buildReport({ market: "ZZ", evidence: tmp() }), RangeError);
});

test("run writes AT-M-IN.md and --check exits 1 while a row is missing", async () => {
  const out = tmp();
  const lines = [];
  const bad = await run(
    ["--market", "IN", "--evidence", evidence({ rd: null }), "--out", out, "--check"],
    { out: (s) => lines.push(s) },
  );
  assert.equal(bad, 1);
  assert.ok(fs.existsSync(path.join(out, "AT-M-IN.md")));
  const good = await run(["--market", "IN", "--evidence", evidence(), "--out", out, "--check"], {
    out: (s) => lines.push(s),
  });
  assert.equal(good, 0);
  assert.match(lines.join("\n"), /M1=pass M2=pass M3=pass M4=pass M5=pass/);
});

test("run refuses a bad flag", async () => {
  assert.equal(await run(["--bogus"], { out: () => {} }), 2);
  assert.equal(await run(["--market", "in", "--evidence", "x"], { out: () => {} }), 2);
});

async function devDb(enabled) {
  const db = createClient({ url: ":memory:" });
  await db.execute("CREATE TABLE market (code TEXT PRIMARY KEY, enabled INTEGER NOT NULL)");
  await db.execute(
    "CREATE TABLE market_profile (code TEXT PRIMARY KEY, evidence_recorded_at TEXT)",
  );
  await db.execute({ sql: "INSERT INTO market VALUES ('IN', ?)", args: [enabled ? 1 : 0] });
  await db.execute("INSERT INTO market_profile VALUES ('IN', NULL)");
  return db;
}

test("the stamp is written into a development database after all rows pass", async () => {
  const r = buildReport({ market: "IN", evidence: evidence() });
  const db = await devDb(true);
  await stampEvidence(db, "file:dev.db", r, "2026-11-13T00:00:00.000Z");
  const v = (await db.execute("SELECT evidence_recorded_at AS e FROM market_profile")).rows[0].e;
  assert.equal(v, "2026-11-13T00:00:00.000Z");
});

test("the stamp is refused: a Turso URL, a red report, a market that is not enabled", async () => {
  const green = buildReport({ market: "IN", evidence: evidence() });
  const red = buildReport({ market: "IN", evidence: evidence({ rd: null }) });
  await assert.rejects(
    stampEvidence(await devDb(true), "libsql://prod.turso.io", green, "x"),
    /development database only/,
  );
  await assert.rejects(stampEvidence(await devDb(true), "file:dev.db", red, "x"), /every AT-M row/);
  await assert.rejects(
    stampEvidence(await devDb(false), "file:dev.db", green, "x"),
    (e) => e.name === "MarketNotEnabled",
  );
});

test("the root and the worker vitest runs are merged (vitest.json + vitest-worker.json)", () => {
  const dir = tmp();
  const [root, worker] = [
    ROWS.IN.m2.filter((n) => !n.startsWith("worker/")).concat(ROWS.IN.m3, ROWS.IN.m5),
    ROWS.IN.m2.filter((n) => n.startsWith("worker/")),
  ];
  write(dir, "vitest.json", vitestJson(root));
  write(dir, "vitest-worker.json", vitestJson(worker));
  write(dir, "source-report-IN.json", report());
  write(dir, "recorded-days-IN.json", days());
  assert.equal(buildReport({ market: "IN", evidence: dir }).allPass, true);
});
