// Tests for the Owner-run day recorder. Fake fetch only, synthetic numbers, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { run, defaultDate, isInsideRepo, DEFAULT_CODES } from "./record-day.mjs";
import { readRecordedDay } from "../../src/lib/data/recorded/reader.mjs";
import { redateDay, weekdaysBetween } from "../../src/lib/data/recorded/redate.mjs";

const DATE = "2026-10-20"; // a Tuesday
const days = ["2026-10-15", "2026-10-16", "2026-10-19", "2026-10-20", "2026-10-21"];
const secs = (d) => Date.parse(`${d}T00:00:00Z`) / 1000 - 8 * 3600; // 16:00 the day before UTC = 03:00 Sydney same date
const chart = (base) => ({
  chart: {
    result: [
      {
        timestamp: days.map(secs),
        indicators: {
          quote: [
            {
              open: days.map((_, i) => base + i),
              high: days.map((_, i) => base + i + 1),
              low: days.map((_, i) => base + i - 1),
              close: days.map((_, i) => base + i + 0.5),
              volume: days.map(() => 1000),
            },
          ],
          adjclose: [{ adjclose: days.map((_, i) => base + i + 0.4) }],
        },
      },
    ],
  },
});
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const limited = () => ({ ok: false, status: 429, json: async () => ({}) });
const NOW = () => new Date("2026-10-21T03:00:00Z"); // 14:00 Sydney on the 21st
const noSleep = async () => {};

function harness(fetchImpl, sleep = noSleep) {
  const dir = mkdtempSync(path.join(tmpdir(), "praxis-recday-"));
  const lines = [];
  const errs = [];
  const call = (args, env = {}) =>
    run(["--out", dir, ...args], env, {
      fetch: fetchImpl,
      sleep,
      now: NOW,
      out: (s) => lines.push(s),
      err: (s) => errs.push(s),
    });
  return { dir, lines, errs, call, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("writes bars.json and index.json the real reader and redate accept", async () => {
  const urls = [];
  const h = harness(async (url) => {
    urls.push(url);
    return ok(chart(url.includes("%5EAXJO") ? 8000 : 10));
  });
  try {
    assert.equal(await h.call(["--date", DATE, "--codes", "ZZB,ZZA"]), 0);
    const day = readRecordedDay(h.dir, { date: DATE });
    assert.equal(day.date, DATE);
    assert.equal(day.bars.length, 8); // 2 codes x 4 sessions up to DATE (the 21st is dropped)
    assert.equal(day.index.length, 4);
    assert.deepEqual(Object.keys(day.bars[0]), [
      "code",
      "date",
      "open",
      "high",
      "low",
      "close",
      "volume",
      "adj_close",
      "source",
      "published_at",
      "fetched_at",
    ]);
    assert.deepEqual(Object.keys(day.index[0]), [
      "code",
      "date",
      "open",
      "high",
      "low",
      "close",
      "source",
      "published_at",
      "fetched_at",
    ]);
    assert.equal(day.index[0].code, "AXJO");
    assert.ok(
      day.bars.every((b) => b.date <= DATE && b.source === "yahoo" && b.published_at === null),
    );
    assert.ok(urls[0].includes("ZZA.AX") && urls[1].includes("ZZB.AX"));
    const res = redateDay(day, {
      sessionDates: weekdaysBetween("2026-11-02", "2026-11-05"),
      shortDates: [],
    });
    assert.equal(res.bars.length, 8);
    assert.ok(h.lines.every((l) => !/ZZ|8000/.test(l)));
    assert.match(h.lines[0], /^record-day: bars=8 index=4 codes=2 missing_codes=0 sessions=4 /);
  } finally {
    h.done();
  }
});

test("output is deterministic and ordered by code then date", async () => {
  const mk = async (codes) => {
    const h = harness(async (u) => ok(chart(u.includes("ZZA") ? 10 : 20)));
    try {
      await h.call(["--date", DATE, "--codes", codes]);
      const f = path.join(h.dir, "recorded", "au", DATE, "bars.json");
      return JSON.parse(readFileSync(f, "utf8")).map((r) => [r.code, r.date, r.close]);
    } finally {
      h.done();
    }
  };
  const a = await mk("ZZB,ZZA");
  assert.deepEqual(a, await mk("ZZA,ZZB"));
  assert.deepEqual(
    a,
    [...a].sort((x, y) => (x[0] + x[1] < y[0] + y[1] ? -1 : 1)),
  );
});

test("--sessions limits the window", async () => {
  const h = harness(async () => ok(chart(10)));
  try {
    await h.call(["--date", DATE, "--codes", "ZZA", "--sessions", "2"]);
    assert.equal(readRecordedDay(h.dir, { date: DATE }).bars.length, 2);
  } finally {
    h.done();
  }
});

test("refuses --out inside the repo and writes nothing", async () => {
  let called = false;
  const errs = [];
  const inside = path.resolve(import.meta.dirname, "..", "..", "tmp-fixtures-should-not-exist");
  const code = await run(
    ["--out", inside, "--date", DATE],
    {},
    {
      fetch: async () => {
        called = true;
        return ok(chart(1));
      },
      sleep: noSleep,
      now: NOW,
      err: (s) => errs.push(s),
    },
  );
  assert.equal(code, 2);
  assert.equal(called, false);
  assert.match(errs[0], /outside the praxis-app repo/);
  assert.equal(existsSync(inside), false);
  assert.equal(isInsideRepo(path.join(inside, "a", "b")), true);
  assert.equal(isInsideRepo(path.join(tmpdir(), "elsewhere")), false);
});

test("rate limited: backs off, then exits 3 with a plain message and writes nothing", async () => {
  const sleeps = [];
  let calls = 0;
  const h = harness(
    async () => {
      calls++;
      return limited();
    },
    async (ms) => sleeps.push(ms),
  );
  try {
    assert.equal(await h.call(["--date", DATE, "--codes", "ZZA"]), 3);
    assert.equal(calls, 3);
    assert.equal(sleeps.length, 2);
    assert.ok(sleeps[0] >= 20000 && sleeps[1] >= 80000);
    assert.match(h.errs[0], /Yahoo refused the request \(HTTP 429\)/);
    assert.equal(existsSync(path.join(h.dir, "recorded")), false);
  } finally {
    h.done();
  }
});

test("recovers after one 429", async () => {
  let n = 0;
  const h = harness(async () => (n++ === 0 ? limited() : ok(chart(5))));
  try {
    assert.equal(await h.call(["--date", DATE, "--codes", "ZZA"]), 0);
    assert.match(h.lines[0], /retries=1/);
  } finally {
    h.done();
  }
});

test("no bar for the date: plain error, nothing written", async () => {
  const h = harness(async () => ok(chart(5)));
  try {
    assert.equal(await h.call(["--date", "2026-10-17", "--codes", "ZZA"]), 2); // a Saturday
    assert.match(h.errs[0], /no bars for 2026-10-17/);
    assert.equal(existsSync(path.join(h.dir, "recorded")), false);
  } finally {
    h.done();
  }
});

test("usage errors", async () => {
  const h = harness(async () => ok(chart(5)));
  try {
    assert.equal(await h.call(["--date", "2026-13-40"]), 2);
    assert.equal(await h.call(["--codes", "bad code"]), 2);
    assert.equal(await h.call(["--date", DATE, "--codes", "ZZA"], { YAHOO_MIN_GAP_S: "0" }), 2);
    assert.equal(await run([], {}, { err: () => {} }), 2);
    assert.equal(readdirSync(h.dir).length, 0);
  } finally {
    h.done();
  }
});

test("default date skips weekends and holidays; default codes are a fixed sample", () => {
  const hol = new Set(["2026-10-19"]);
  assert.equal(defaultDate(new Date("2026-10-20T03:00:00Z"), new Set()), "2026-10-19");
  assert.equal(defaultDate(new Date("2026-10-20T03:00:00Z"), hol), "2026-10-16");
  assert.equal(defaultDate(new Date("2026-10-20T09:00:00Z"), hol), "2026-10-20");
  assert.equal(defaultDate(new Date("2026-10-18T09:00:00Z"), new Set()), "2026-10-16");
  assert.equal(DEFAULT_CODES.length, 30);
  assert.deepEqual([...DEFAULT_CODES], [...DEFAULT_CODES].sort());
});
