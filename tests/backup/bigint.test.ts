// D-175: 64-bit integers (cohort.rng_seed) survive the nightly backup exactly. Production 2026-10-23:
// the dump failed ("main_dump: unexpected error") once the first cohorts existed, because the default
// libsql number mode refuses integers beyond 2^53.
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { dumpDatabase, encodeValue } from "@/lib/backup/dump";
import { decodeValue, restoreDatabase } from "@/lib/backup/restore";
import { cleanupTempDbs, tempDbUrl, track } from "../db/helpers";

afterEach(cleanupTempDbs);

const AT = "2026-10-23T12:00:00.000Z";
const SEED = 1948686321533620142n; // a real production rng_seed size

const lossless = () => track(createClient({ url: tempDbUrl(), intMode: "bigint" }));

describe("64-bit integers in the backup", () => {
  it("encodes safe integers as plain numbers and only larger ones as $int", () => {
    expect(encodeValue(600000000n)).toBe(600000000);
    expect(encodeValue(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    expect(encodeValue(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toEqual({ $int: "9007199254740992" });
    expect(encodeValue(-SEED)).toEqual({ $int: "-1948686321533620142" });
    expect(decodeValue({ $int: SEED.toString() })).toBe(SEED);
  });

  it("a lossless dump and restore carry the seed exactly", async () => {
    const src = lossless();
    await src.execute(
      "CREATE TABLE cohort (id TEXT PRIMARY KEY, seed_micro INTEGER NOT NULL, rng_seed INTEGER NOT NULL) STRICT, WITHOUT ROWID",
    );
    await src.execute({
      sql: "INSERT INTO cohort VALUES (?, ?, ?), (?, ?, ?)",
      args: ["c1", 600000000n, SEED, "c2", 600000000n, -SEED],
    });
    const dump = await dumpDatabase(src, { name: "main", createdAt: AT, ephemeral: [] });
    expect(dump.counts.cohort).toBe(2);
    expect(dump.text).toContain('"$int":"1948686321533620142"');
    expect(dump.text).toContain("600000000"); // the safe value stays a plain number

    const target = lossless();
    await restoreDatabase(target, dump.text);
    const rows = await target.execute("SELECT id, seed_micro, rng_seed FROM cohort ORDER BY id");
    expect(rows.rows.map((r) => [r.id, r.seed_micro, r.rng_seed])).toEqual([
      ["c1", 600000000n, SEED],
      ["c2", 600000000n, -SEED],
    ]);
  });

  it("the default number mode still refuses the seed, which is why the dump client is lossless", async () => {
    const url = tempDbUrl();
    const writer = track(createClient({ url, intMode: "bigint" }));
    await writer.execute("CREATE TABLE t (v INTEGER NOT NULL) STRICT");
    await writer.execute({ sql: "INSERT INTO t VALUES (?)", args: [SEED] });
    const numbers = track(createClient({ url }));
    await expect(
      dumpDatabase(numbers, { name: "main", createdAt: AT, ephemeral: [] }),
    ).rejects.toThrow(RangeError);
  });
});
