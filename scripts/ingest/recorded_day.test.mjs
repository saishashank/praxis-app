// M8 T9: the recorded-day source script (staging only, NFR-040). Synthetic data, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "./recorded_day.mjs";
import { parseShortText } from "../../src/lib/data/shortInterest.mjs";

const STAGING = { PRAXIS_ENV: "staging" };

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "praxis-recday-"));
  const folder = path.join(dir, "fixtures", "recorded", "au", "2025-05-02");
  mkdirSync(folder, { recursive: true });
  const bar = (code, date, close) => ({
    code,
    date,
    open: close,
    high: close,
    low: close,
    close,
    volume: 100,
    adj_close: close,
    source: "yahoo",
    published_at: null,
    fetched_at: `${date}T07:30:00.000Z`,
  });
  const write = (n, v) => writeFileSync(path.join(folder, n), JSON.stringify(v));
  write("bars.json", [
    bar("ZZA", "2025-05-01", 1),
    bar("ZZB", "2025-05-01", 2),
    bar("ZZA", "2025-05-02", 1.5),
    bar("ZZB", "2025-05-02", 2.5),
  ]);
  write("index.json", [
    { code: "AXJO", date: "2025-05-02", close: 8000, fetched_at: "2025-05-02T08:00:00Z" },
  ]);
  write("short.json", {
    stopped: null,
    dates: 1,
    absent: 0,
    skipped: 0,
    rows: [{ code: "ZZA", as_of: "2025-04-30", short_positions: 10, total_in_issue: 1000 }],
  });
  writeFileSync(
    path.join(dir, "request.json"),
    JSON.stringify({
      codes: ["ZZA"],
      start: "2026-10-20",
      end: "2026-10-21",
      indices: ["^AXJO", "^GSPC", "^VIX"],
      short_dates: ["2026-10-19"],
    }),
  );
  return dir;
}
const args = (dir) => [
  "--request",
  path.join(dir, "request.json"),
  "--fixtures",
  path.join(dir, "fixtures"),
  "--output",
  path.join(dir, "bars.json"),
  "--index-output",
  path.join(dir, "index.json"),
  "--short-output",
  path.join(dir, "short.json"),
];
const json = (f) => JSON.parse(readFileSync(f, "utf8"));

test("refuses to run outside staging and writes nothing", async () => {
  const dir = setup();
  try {
    const lines = [];
    for (const env of [{}, { PRAXIS_ENV: "production" }]) {
      assert.equal(await run(args(dir), env, { out: (s) => lines.push(s) }), 2);
    }
    assert.ok(lines.every((l) => /staging only/.test(l)));
    assert.throws(() => readFileSync(path.join(dir, "bars.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("re-dates the recorded day onto the request, keeps only requested codes, prints counts only", async () => {
  const dir = setup();
  try {
    const lines = [];
    assert.equal(await run(args(dir), STAGING, { out: (s) => lines.push(s) }), 0);
    const bars = json(path.join(dir, "bars.json"));
    assert.deepEqual(
      bars.map((b) => [b.code, b.date, b.close, b.fetched_at]),
      [
        ["ZZA", "2026-10-20", 1, "2026-10-20T07:30:00.000Z"],
        ["ZZA", "2026-10-21", 1.5, "2026-10-21T07:30:00.000Z"],
      ],
    );
    assert.equal(json(path.join(dir, "index.json"))[0].date, "2026-10-21");
    const short = parseShortText(readFileSync(path.join(dir, "short.json"), "utf8"));
    assert.equal(short.status, "ok");
    assert.deepEqual(
      short.rows.map((r) => [r.code, r.as_of]),
      [["ZZA", "2026-10-19"]],
    );
    assert.equal(lines.length, 1);
    assert.match(
      lines[0],
      /^recorded_day: bars=2 index=1 short=1 announcements=0 actions=0 sessions=2\/2 rows_dropped=0 not_requested=2$/,
    );
    assert.doesNotMatch(lines[0], /ZZ|2025|2026/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing short.json gives an empty short file; no short dates is fine", async () => {
  const dir = setup();
  try {
    rmSync(path.join(dir, "fixtures", "recorded", "au", "2025-05-02", "short.json"));
    assert.equal(await run(args(dir), STAGING, { out: () => {} }), 0);
    assert.deepEqual(json(path.join(dir, "short.json")).rows, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unreadable recording or request fails with exit 2 and a fixed message", async () => {
  const dir = setup();
  try {
    const lines = [];
    const out = (s) => lines.push(s);
    rmSync(path.join(dir, "fixtures", "recorded"), { recursive: true });
    assert.equal(await run(args(dir), STAGING, { out }), 2);
    writeFileSync(path.join(dir, "request.json"), "{not json");
    assert.equal(await run(args(dir), STAGING, { out }), 2);
    writeFileSync(
      path.join(dir, "request.json"),
      JSON.stringify({ start: "2026-10-22", end: "2026-10-21" }),
    );
    assert.equal(await run(args(dir), STAGING, { out }), 2);
    assert.equal(await run(["--request", "x"], STAGING, { out }), 2);
    assert.deepEqual(lines, [
      "recorded_day: failed (recording unreadable: no_recorded_root)",
      "recorded_day: failed (request file unreadable)",
      "recorded_day: failed (request dates invalid)",
      "recorded_day: failed (--request, --fixtures and --output are required)",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("while it runs, fetch to ASX or Yahoo throws; afterwards fetch is restored", async () => {
  const dir = setup();
  const original = globalThis.fetch;
  let probe = null;
  try {
    // A request step that tries a blocked host during the run (the reader is sync, so use the out hook).
    const out = () => {
      probe ??= globalThis.fetch("https://query1.finance.yahoo.com/x").then(
        () => "reached",
        (e) => e.name,
      );
    };
    assert.equal(await run(args(dir), STAGING, { out }), 0);
    assert.equal(await probe, "BlockedHostError");
    assert.equal(globalThis.fetch, original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
