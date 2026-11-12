// M19 E2 (AT-68, MKT-110, D-1079): the production-shape assertion of the CI recorded day, on a fresh migrated
// database. The production shape passes; each deviation (a second market enabled, the home market off its mode, a row
// counted for a market that is not enabled, a stray market row, a market tag in the recorded slot table) fails it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadMigrations, migrateUp } from "../../src/lib/db/migrate-core.mjs";
import {
  PRODUCTION_ENABLED,
  PRODUCTION_SHAPE,
  checkProductionShape,
  main,
  marketTagsIn,
  parseArgs,
  workerMarketsSql,
} from "./assert-production-shape.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = {
  workerMarketsText: readFileSync(path.join(ROOT, "worker/src/markets.ts"), "utf8"),
  slotSnapshotText: readFileSync(
    path.join(ROOT, "worker/test/fixtures/au-slots.snapshot.json"),
    "utf8",
  ),
};

const clean = (dir) => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* Windows keeps a database file locked for a moment; the run Temp folder is swept later */
  }
};

/** A migrated main database in the shape a finished recorded day leaves (the home market switched to `full`). */
async function shaped(dir, name) {
  const file = path.join(dir, `${name}.db`);
  const client = createClient({ url: pathToFileURL(file).href });
  await migrateUp(client, await loadMigrations(path.join(ROOT, "db/migrations/main")), {});
  await client.execute("UPDATE market SET mode = 'full' WHERE enabled = 1");
  return { client, file };
}

test("the shape is read from the profile modules: one enabled market, the others built and off", () => {
  assert.equal(PRODUCTION_ENABLED.length, 1);
  assert.deepEqual(Object.keys(PRODUCTION_SHAPE).sort(), ["AU", "IN", "US"]);
  assert.deepEqual(PRODUCTION_SHAPE[PRODUCTION_ENABLED[0]], { enabled: 1, modes: ["full"] });
});

test("the Worker's per-tick statement and the AU slot table are found in the repository", () => {
  assert.match(workerMarketsSql(SRC.workerMarketsText) ?? "", /FROM market WHERE enabled = 1$/);
  assert.equal(workerMarketsSql("export const X = 1;"), null);
  assert.deepEqual(marketTagsIn(SRC.slotSnapshotText), ["AU"]);
  assert.deepEqual(
    marketTagsIn('{"id":"ingest-batch1:IN","keyPrefix":"arena-2a:AU:","other":"07:30"}'),
    ["AU", "IN"],
  );
});

test("a database in the production shape passes", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "praxis-aps-"));
  const { client } = await shaped(dir, "ok");
  try {
    const r = await checkProductionShape(client, SRC);
    assert.deepEqual(
      r.lines.filter((l) => l.startsWith("FAIL")),
      [],
    );
    assert.equal(r.ok, true);
    assert.ok(r.lines.length >= 8);
  } finally {
    client.close();
    clean(dir);
  }
});

const deviations = [
  [
    "a second market is enabled",
    "UPDATE market SET enabled = 1 WHERE code = 'IN'",
    /FAIL IN: enabled 1/,
  ],
  [
    "the home market is not full",
    "UPDATE market SET mode = 'data_only' WHERE code = 'AU'",
    /FAIL AU: enabled 1, mode data_only/,
  ],
  [
    "the invariant counted rows of a market that is not enabled",
    "INSERT INTO market_row_count (d, tbl, market, n) VALUES ('2026-11-12', 'price_bar', 'US', 3)",
    /FAIL market_row_count holds no row.*US x1/,
  ],
  [
    "a stray market row",
    "INSERT INTO market (code, tz, open_time, close_time, cutoff_time, currency, mode, enabled) VALUES ('ZZ', 'UTC', '09:00', '17:00', '18:00', 'USD', 'off', 0)",
    /FAIL market rows are the built markets.*ZZ/,
  ],
  [
    "the Worker's read would return a second market (a second row enabled and projected)",
    "UPDATE market SET enabled = 1, mode = 'full', slots_json = (SELECT slots_json FROM market WHERE code = 'AU') WHERE code = 'US'",
    /FAIL the Worker's per-tick read returns AU only \(got AU, US\)/,
  ],
  [
    "the home market's anchors are not the projection",
    "UPDATE market SET slots_json = replace(slots_json, '17:30', '17:31') WHERE code = 'AU'",
    /FAIL the home market row's slots_json/,
  ],
];
for (const [name, sql, expected] of deviations) {
  test(`fails when ${name}`, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "praxis-aps-"));
    const { client } = await shaped(dir, "bad");
    try {
      await client.execute(sql);
      const r = await checkProductionShape(client, SRC);
      assert.equal(r.ok, false);
      assert.ok(
        r.lines.some((l) => expected.test(l)),
        r.lines.join("\n"),
      );
    } finally {
      client.close();
      clean(dir);
    }
  });
}

test("fails when the recorded slot table names another market", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "praxis-aps-"));
  const { client } = await shaped(dir, "tag");
  try {
    const r = await checkProductionShape(client, {
      ...SRC,
      slotSnapshotText: '{"id":"arena-2a:IN:"}',
    });
    assert.equal(r.ok, false);
    assert.ok(
      r.lines.some((l) =>
        /FAIL the recorded home-market slot table names no other market \(IN\)/.test(l),
      ),
    );
  } finally {
    client.close();
    clean(dir);
  }
});

test("the command: exit 0 on the shape, 1 on a deviation, 2 on a bad argument or a remote database", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "praxis-aps-"));
  const { client, file } = await shaped(dir, "cmd");
  try {
    const lines = [];
    const out = (s) => lines.push(s);
    assert.equal(await main(["--db", file], { out }), 0);
    assert.equal(lines.at(-1), "production shape: ok");
    await client.execute("UPDATE market SET enabled = 1 WHERE code = 'US'");
    assert.equal(await main(["--db", file], { out }), 1);
    assert.equal(lines.at(-1), "production shape: FAILED");
    assert.equal(await main([], { out }), 2);
    assert.equal(await main(["--db", file, "--work", dir], { out }), 2);
    assert.equal(await main(["--db", "libsql://example.invalid"], { out }), 2);
    assert.equal(await main(["--db", path.join(dir, "missing-dir", "x.db")], { out }), 2);
    assert.deepEqual(parseArgs(["--work", "w"]), { work: "w", db: null });
    // output never carries a URL or a value
    assert.ok(lines.every((l) => !/libsql:|https?:/.test(l)));
  } finally {
    client.close();
    clean(dir);
  }
});
