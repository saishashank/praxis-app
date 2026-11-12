// @vitest-environment node
// M20 A2 (D-1116, closing D-1016): the schema hash of a night manifest covers a pinned table list. The base list is
// exactly the schema-35 table set minus market_profile*, so the AU `schemaSha` is byte-identical after migration
// 0036 (A-20, AT-32/AT-50); an IN or US profile adds its rule-set tables, AU never does.
import { createHash } from "node:crypto";
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateUp } from "@/lib/db/migrate-core.mjs";
import { STAGE_TABLES, stageTablesFor } from "@/lib/cortex/stageTables.mjs";
import { staticProfile } from "@/lib/market/staticProfile.mjs";
import { cleanupTempDbs, MIGRATIONS } from "../db/helpers";

afterEach(cleanupTempDbs);

const sha = (names: readonly string[]) =>
  createHash("sha256").update(names.join(",")).digest("hex");

/** The pre-M20 computation: a scan of sqlite_master after the first `upTo` migrations. */
async function scan(upTo: number): Promise<string[]> {
  const db = createClient({ url: ":memory:" });
  try {
    const all = await loadMigrations(MIGRATIONS("main"));
    await migrateUp(
      db,
      all.filter((m) => m.version <= upTo),
    );
    const r = await db.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'market_profile%' ORDER BY name",
    );
    return r.rows.map((x) => String(x.name));
  } finally {
    db.close();
  }
}

const M20_TABLES = [
  "announcement_category",
  "bar_latency_sample",
  "fundamental_fact",
  "holdout_look",
  "label_item",
  "market_switch",
  "price_band",
  "surveillance_list",
  "trading_halt",
];

describe("the base list", () => {
  it("equals the schema-35 table set minus market_profile*, sorted, with no duplicate", async () => {
    expect([...STAGE_TABLES]).toEqual(await scan(35));
    expect([...STAGE_TABLES]).toEqual([...STAGE_TABLES].sort());
    expect(new Set(STAGE_TABLES).size).toBe(STAGE_TABLES.length);
    expect(STAGE_TABLES.some((t) => t.startsWith("market_profile"))).toBe(false);
  });

  it("is the whole migrated schema minus the market_profile tables and the nine tables 0036 adds", async () => {
    const now = await scan(36);
    expect(now.filter((t) => !M20_TABLES.includes(t))).toEqual([...STAGE_TABLES]);
    expect(now.filter((t) => M20_TABLES.includes(t))).toEqual(M20_TABLES);
  });

  it("the AU schemaSha equals the pre-M20 scan of a schema-35 database, byte for byte", async () => {
    const au = staticProfile("AU");
    expect(stageTablesFor(au)).toEqual([...STAGE_TABLES]);
    expect(sha(stageTablesFor(au))).toBe(sha(await scan(35)));
    // pinned: a change of the base list moves the AU hash and the AT-32 baseline with it
    expect(sha(STAGE_TABLES)).toBe(sha(await scan(35)));
    expect(STAGE_TABLES).toHaveLength(170);
    expect(sha(STAGE_TABLES)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("stageTablesFor", () => {
  it("an IN profile adds price_band, surveillance_list and announcement_category", () => {
    const names = stageTablesFor(staticProfile("IN"));
    expect(names.filter((t) => !STAGE_TABLES.includes(t))).toEqual([
      "announcement_category",
      "price_band",
      "surveillance_list",
    ]);
    expect(names).toEqual([...names].sort());
    expect(sha(names)).not.toBe(sha(STAGE_TABLES));
  });

  it("a US profile adds trading_halt and announcement_category", () => {
    const names = stageTablesFor(staticProfile("US"));
    expect(names.filter((t) => !STAGE_TABLES.includes(t))).toEqual([
      "announcement_category",
      "trading_halt",
    ]);
  });

  it("a plain profile shape: cx16 and no category map is the base list; a null profile too", () => {
    expect(
      stageTablesFor({ haltModel: "cx16", fields: { category_map: { value: { kind: "none" } } } }),
    ).toEqual([...STAGE_TABLES]);
    expect(stageTablesFor(null)).toEqual([...STAGE_TABLES]);
    expect(stageTablesFor({ haltModel: "us_luld" })).toEqual(
      [...STAGE_TABLES, "trading_halt"].sort(),
    );
  });

  it("returns a copy: mutating the result leaves the pinned list alone", () => {
    const a = stageTablesFor(staticProfile("AU"));
    a.push("x");
    expect(stageTablesFor(staticProfile("AU"))).toHaveLength(STAGE_TABLES.length);
  });
});
