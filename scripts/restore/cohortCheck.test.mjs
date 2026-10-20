// M8 T7: the check-cohort replay (NAV identical on the restored bars). Local in-memory libSQL only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import {
  barsFromValues,
  checkCohort,
  CHECK_SEED,
  replayNav,
  splitmix64,
  WINDOW,
} from "./cohortCheck.mjs";

function makeBars() {
  const bars = [];
  const codes = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG"];
  codes.forEach((code, ci) => {
    for (let i = 0; i < 70; i++) {
      const d = new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
      bars.push({
        market: "AU",
        code,
        d,
        c: Math.round((10 + ci * 3 + Math.sin(i / 5 + ci) * 2) * 100) / 100,
      });
    }
  });
  return bars;
}

async function dbWith(bars) {
  const db = createClient({ url: ":memory:" });
  await db.execute("CREATE TABLE price_bar (market TEXT, code TEXT, d TEXT, c REAL)");
  for (const b of bars) {
    await db.execute({
      sql: "INSERT INTO price_bar (market, code, d, c) VALUES (?, ?, ?, ?)",
      args: [b.market, b.code, b.d, b.c],
    });
  }
  return db;
}

test("splitmix64 matches the reference first outputs for seed 0", () => {
  const next = splitmix64(0n);
  assert.equal(next(), 0xe220a8397b1dcdafn);
  assert.equal(next(), 0x6e789e6aa1b965f4n);
});

test("replay is deterministic and covers the whole window", () => {
  const a = replayNav(makeBars());
  const b = replayNav([...makeBars()].reverse());
  assert.equal(a.length, WINDOW);
  assert.deepEqual(a, b, "input order does not matter");
  assert.deepEqual(a, replayNav(makeBars(), { seed: CHECK_SEED }));
  assert.notDeepEqual(a, replayNav(makeBars(), { seed: 1n }), "the seed picks the codes");
  assert.ok(a.every((r) => /^\d+$/.test(r.nav)));
});

test("NAV is identical when the restored database holds the same bars", async () => {
  const bars = makeBars();
  const db = await dbWith(bars);
  const res = await checkCohort({ expectedBars: bars, db });
  assert.deepEqual(res, { ok: true, days: WINDOW, reason: "" });
  db.close();
});

test("one changed, missing or extra-date bar makes the NAV differ", async () => {
  const bars = makeBars();
  // The seeded cohort holds some of the codes; change a close of EVERY code on the last window day
  // so the test does not depend on which codes were chosen.
  const start = replayNav(bars)[WINDOW - 1].d;
  const changed = bars.map((b) => (b.d === start ? { ...b, c: b.c + 0.01 } : b));
  const db = await dbWith(changed);
  const res = await checkCohort({ expectedBars: bars, db });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "NAV differs");
  db.close();

  const fewer = await dbWith(bars.filter((b) => b.d <= replayNav(bars)[10].d));
  const res2 = await checkCohort({ expectedBars: bars, db: fewer });
  assert.equal(res2.ok, false);
  fewer.close();
});

test("no bars is a failure, never a pass", async () => {
  const db = await dbWith([]);
  assert.deepEqual(await checkCohort({ expectedBars: [], db }), {
    ok: false,
    days: 0,
    reason: "no bars to replay",
  });
  const broken = createClient({ url: ":memory:" });
  const res = await checkCohort({ expectedBars: makeBars(), db: broken });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "restored bars unreadable");
});

test("barsFromValues reads the price_bar dump column order and drops unusable rows", () => {
  const rows = [
    ["AU", "AAA", "2025-01-01", 1, 2, 0.5, 1.5, 100],
    ["AU", "BBB", "2025-01-01", 1, 2, 0.5, "x", 100],
    ["AU", "CCC", "2025-01-01", 1, 2, 0.5, -1, 100],
  ];
  assert.deepEqual(barsFromValues(rows, 6), [
    { market: "AU", code: "AAA", d: "2025-01-01", c: 1.5 },
  ]);
});

test("the results carry no row content", async () => {
  const bars = makeBars();
  const db = await dbWith(bars);
  const res = await checkCohort({ expectedBars: bars, db });
  assert.doesNotMatch(JSON.stringify(res), /AAA|BBB|2025/);
  db.close();
});
