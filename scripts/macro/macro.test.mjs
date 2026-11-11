// DAT-251 c (D-973): RBA and ABS fixtures -> macro_series rows. Fixture files and a fake fetch only: no
// network. Micro conversion is exact string arithmetic.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import { loadMigrations, migrateUp } from "../../src/lib/db/migrate-core.mjs";
import { ABS_CPI, RBA_F1 } from "./fixtures.mjs";
import { absDate, rbaDate, toMicro } from "./lib.mjs";
import { parseRba, RBA_URL } from "./rba.mjs";
import { absUrl, ABS_SERIES, parseAbs, run as runAbs } from "./abs.mjs";
import { run as runRba } from "./rba.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

test("toMicro is exact: no float, six decimals, junk is null", () => {
  assert.equal(toMicro("4.35"), 4_350_000);
  assert.equal(toMicro("0.1"), 100_000);
  assert.equal(toMicro("-0.5"), -500_000);
  assert.equal(toMicro("103.64"), 103_640_000);
  assert.equal(toMicro("1.1234567"), 1_123_456);
  assert.equal(toMicro(""), null);
  assert.equal(toMicro("1e3"), null);
  assert.equal(toMicro("n/a"), null);
});

test("dates: RBA DD-Mon-YYYY, ABS quarter / month / year / day", () => {
  assert.equal(rbaDate("04-Jan-2011"), "2011-01-04");
  assert.equal(rbaDate("31-Feb-2011"), null);
  assert.equal(rbaDate("2011-01-04"), null);
  assert.equal(absDate("2025-Q1"), "2025-03-31");
  assert.equal(absDate("2026-Q4"), "2026-12-31");
  assert.equal(absDate("2024-02"), "2024-02-29");
  assert.equal(absDate("2024-M06"), "2024-06-30");
  assert.equal(absDate("2023"), "2023-12-31");
  assert.equal(absDate("2023-13"), null);
  assert.equal(absDate("bad"), null);
});

test("the RBA F1 fixture: only the allowlisted series, empty cells skipped, 400-day window", () => {
  const rows = parseRba(RBA_F1);
  const key = (r) => `${r.series_id} ${r.d} ${r.value_micro}`;
  assert.deepEqual(rows.map(key).sort(), [
    "FIRMMCCRT 2025-11-05 3580000",
    "FIRMMCCRT 2025-11-06 3570000",
    "FIRMMCCRT 2026-11-10 4340000",
    "FIRMMCRTD 2025-11-05 3600000",
    "FIRMMCRTD 2025-11-06 3600000",
    "FIRMMCRTD 2026-11-10 4350000",
    "FIRMMCRTD 2026-11-11 4350000",
  ]); // 2011 row is outside the window; the other series ids are not kept
  assert.ok(rows.every((r) => r.source === "rba"));
  assert.equal(parseRba("not,the,table\n1,2,3"), null);
});

test("the ABS fixture: SDMX-CSV rows in any order, bad periods dropped, sorted by day", () => {
  const rows = parseAbs(ABS_CPI, "CPI_ALL_GROUPS_AUS_Q");
  assert.deepEqual(
    rows.map((r) => [r.d, r.value_micro]),
    [
      ["2025-03-31", 97_700_000],
      ["2025-12-31", 100_320_000],
      ["2026-06-30", 102_310_000],
      ["2026-09-30", 103_640_000],
    ],
  );
  assert.equal(parseAbs("a,b\n1,2", "x"), null);
  assert.match(
    absUrl(ABS_SERIES[0]),
    /^https:\/\/data\.api\.abs\.gov\.au\/rest\/data\/ABS,CPI,2\.0\.0\/1\.10001\.10\.50\.Q\?startPeriod=/,
  );
});

async function withDb(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "praxis-macro-"));
  const url = pathToFileURL(path.join(dir, "main.db")).href;
  const db = createClient({ url });
  await migrateUp(db, await loadMigrations(path.join(root, "db", "migrations", "main")));
  try {
    await fn(db, url);
  } finally {
    db.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may still hold the file; it is in the OS temp folder
    }
  }
}
const reply = (status, body = "", headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  text: async () => body,
});

test("the RBA run writes rows once, sends If-Modified-Since next time, and a repeat writes nothing", async () => {
  await withDb(async (db, url) => {
    const calls = [];
    const lines = [];
    const deps = {
      nowMs: () => Date.parse("2026-11-13T00:00:00Z"),
      out: (s) => lines.push(s),
      fetchImpl: async (u, init) => {
        calls.push({ u, h: init.headers });
        return init.headers["if-modified-since"]
          ? reply(304)
          : reply(200, RBA_F1, { "last-modified": "Thu, 12 Nov 2026 04:30:00 GMT" });
      },
    };
    const env = { TURSO_MAIN_URL: url, MACRO_USER_AGENT: "test-agent" };
    assert.equal(await runRba(env, deps), 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].u, RBA_URL);
    assert.equal(calls[0].h["user-agent"], "test-agent");
    const n = Number((await db.execute("SELECT COUNT(*) AS n FROM macro_series")).rows[0].n);
    assert.equal(n, 7);
    assert.match(lines[0], /macro-rba: ok rows=7 changed=7/);
    // second run: conditional, 304, nothing written
    assert.equal(await runRba(env, deps), 0);
    assert.equal(calls[1].h["if-modified-since"], "Thu, 12 Nov 2026 04:30:00 GMT");
    assert.match(lines[1], /not modified/);
    // an unconditional re-parse of identical data changes no row
    const again = { ...deps, fetchImpl: async () => reply(200, RBA_F1) };
    await db.execute("DELETE FROM worker_state");
    assert.equal(await runRba(env, again), 0);
    assert.match(lines[2], /rows=7 changed=0/);
    assert.ok(!lines.join("\n").includes("file:"), "no URL or secret in the log");
  });
});

test("the ABS run stores the quarter-end days; a refusal or a bad table fails with a count-free line", async () => {
  await withDb(async (db, url) => {
    const lines = [];
    const ok = {
      out: (s) => lines.push(s),
      fetchImpl: async (u, init) => {
        assert.equal(init.headers.accept, "application/vnd.sdmx.data+csv");
        return reply(200, ABS_CPI);
      },
    };
    assert.equal(await runAbs({ TURSO_MAIN_URL: url }, ok), 0);
    const r = await db.execute(
      "SELECT d, value_micro FROM macro_series WHERE source='abs' ORDER BY d",
    );
    assert.equal(r.rows.length, 4);
    assert.equal(r.rows[3].d, "2026-09-30");
    assert.equal(
      await runAbs({ TURSO_MAIN_URL: url }, { ...ok, fetchImpl: async () => reply(503) }),
      1,
    );
    assert.equal(
      await runAbs(
        { TURSO_MAIN_URL: url },
        { ...ok, fetchImpl: async () => reply(200, "<html/>") },
      ),
      1,
    );
    assert.match(lines.at(-1), /did not parse/);
    assert.equal(await runAbs({}, ok), 1);
  });
});
