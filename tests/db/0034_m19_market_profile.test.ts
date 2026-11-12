// @vitest-environment node
// Migration 0034_m19_market_profile (M19 A1; DAT-241, DAT-242, D-992, D-994, D-998): market_profile,
// market_profile_field, market_profile_change, market.enabled and market.slots_json, the IN and US rows.
// The SQL is a checked projection of the seed modules (the single definition): every seeded row equals the
// module, the generated file equals the generator's output, the two enabled/mode triggers hold, the change
// ledger is append-only, and the migration rolls back and comes back identical.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "@/lib/db/migrate-core.mjs";
import { PROFILE_FIELDS } from "@/lib/market/fields.mjs";
import { encodeValue, slotsJson } from "@/lib/market/profileCore.mjs";
import { SEEDS, builtMarkets } from "@/lib/market/seed/index.mjs";
// @ts-expect-error the generator is a script (not typed); its delta check is the checked projection
import { MIGRATION_PATH, applyDelta } from "../../scripts/market/gen-seed-sql.mjs";
import { cleanupTempDbs, freshDb, MIGRATIONS, schemaOf, tempDbUrl, track } from "./helpers";

afterEach(cleanupTempDbs);

const rows = async (db: Client, sql: string, args: (string | number)[] = []) =>
  (await db.execute({ sql, args })).rows;

describe("0034_m19_market_profile", () => {
  it("is migration 34: the applied file is frozen and the seed's later changes are the generated delta of 0036", async () => {
    const ms = await loadMigrations(MIGRATIONS("main"));
    expect(ms[33]).toMatchObject({ version: 34, name: "m19_market_profile" });
    // M20 (D-1122): 0034 is an applied migration, never regenerated; its checksum is pinned here and a seed change
    // since then is projected into 0036 (`gen-seed-sql.mjs --delta 0034`), which must be current
    expect(ms[33]!.checksum).toBe(
      createHash("sha256")
        .update(readFileSync(MIGRATION_PATH as string, "utf8"))
        .digest("hex"),
    );
    expect(
      createHash("sha256")
        .update(readFileSync(MIGRATION_PATH as string, "utf8"))
        .digest("hex"),
    ).toBe("bc695e98214aba218a1a62cfff49944eb7242b1d33dcb07c63506361257fb9a2");
    expect(await applyDelta(true)).toBe(true);
  });

  it("rolls back and comes back identical", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    const ms = await loadMigrations(MIGRATIONS("main"));
    await migrateUp(db, ms);
    const after = await schemaOf(db);
    expect(await migrateDown(db, ms, 3)).toEqual({ rolledBack: 3, version: 33 }); // 0036 and 0035 (the guard) sit on top
    const left = await rows(db, "SELECT name FROM sqlite_master WHERE name LIKE 'market_profile%'");
    expect(left).toHaveLength(0);
    const cols = (await rows(db, "SELECT name FROM pragma_table_info('market')")).map((r) =>
      String(r.name),
    );
    expect(cols).not.toContain("enabled");
    expect(cols).not.toContain("slots_json");
    expect((await rows(db, "SELECT code FROM market")).map((r) => String(r.code))).toEqual(["AU"]);
    expect(await migrateUp(db, ms)).toEqual({ applied: 3, version: 36 });
    expect(await schemaOf(db)).toEqual(after);
  });

  it("seeds the market rows: AU enabled, IN and US enabled 0 and off, each with its projection", async () => {
    const db = await freshDb("main");
    const r = await rows(db, "SELECT * FROM market ORDER BY code");
    expect(r.map((x) => String(x.code))).toEqual(builtMarkets());
    for (const x of r) {
      const seed = SEEDS[String(x.code)]!;
      const v = (n: (typeof PROFILE_FIELDS)[number]) => seed.fields[n].value;
      const cutoff = (v("decision_cutoff") as { time: string }).time;
      expect({
        tz: x.tz,
        open: x.open_time,
        close: x.close_time,
        cutoff: x.cutoff_time,
        currency: x.currency,
        mode: x.mode,
        enabled: Number(x.enabled),
      }).toEqual({
        tz: v("tz"),
        open: v("session_open"),
        close: v("session_close"),
        cutoff,
        currency: v("currency"),
        mode: seed.mode,
        enabled: seed.enabled,
      });
      const slots = slotsJson({
        sessionOpen: v("session_open") as string,
        sessionClose: v("session_close") as string,
        decisionCutoff: cutoff,
        batchSchedule: v("batch_schedule"),
        preopenRecheckMin: v("preopen_recheck_min") as number,
      });
      expect(x.slots_json).toBe(slots);
    }
    // production shape: AU is the only enabled market (BLD-050); IN and US are built and off
    expect(r.filter((x) => Number(x.enabled) === 1).map((x) => String(x.code))).toEqual(["AU"]);
    expect(r.filter((x) => String(x.code) !== "AU").every((x) => x.mode === "off")).toBe(true);
  });

  it("seeds one profile row per market and every field row equal to the seed module", async () => {
    const db = await freshDb("main");
    for (const [code, seed] of Object.entries(SEEDS)) {
      const p = (await rows(db, "SELECT * FROM market_profile WHERE code = ?", [code]))[0]!;
      expect({
        status: p.work_status,
        changed: p.status_changed_at,
        built: p.built_at,
        evidence: p.evidence_recorded_at,
        version: Number(p.profile_version),
      }).toEqual({
        status: seed.workStatus,
        changed: seed.statusChangedAt,
        built: seed.builtAt,
        evidence: seed.evidenceRecordedAt,
        version: seed.profileVersion,
      });
      const f = await rows(db, "SELECT * FROM market_profile_field WHERE code = ? ORDER BY field", [
        code,
      ]);
      expect(f.map((x) => String(x.field))).toEqual([...PROFILE_FIELDS].sort());
      for (const x of f) {
        const s = seed.fields[String(x.field) as (typeof PROFILE_FIELDS)[number]];
        expect(String(x.value_json), `${code}.${String(x.field)} value`).toBe(encodeValue(s.value));
        expect(Number(x.verify), `${code}.${String(x.field)} verify`).toBe(s.verify);
        expect(x.verified_at).toBe(s.verifiedAt);
        expect(x.evidence_ref).toBe(s.evidenceRef);
      }
    }
  });

  it("AU is approved everywhere (verify 0); IN and US keep every spec [VERIFY] value unverified (verify 1, no date)", async () => {
    const db = await freshDb("main");
    expect(
      await rows(db, "SELECT 1 FROM market_profile_field WHERE code = 'AU' AND verify = 1"),
    ).toHaveLength(0);
    for (const code of ["IN", "US"]) {
      const f = await rows(
        db,
        "SELECT verify, verified_at FROM market_profile_field WHERE code = ?",
        [code],
      );
      expect(f.every((x) => Number(x.verify) === 1 && x.verified_at === null)).toBe(true);
    }
    // the two [PROPOSED] parcel floors carry their decision reference (D-947)
    const pf = await rows(
      db,
      "SELECT code, evidence_ref FROM market_profile_field WHERE field = 'parcel_floor' AND code <> 'AU' ORDER BY code",
    );
    expect(pf.map((x) => String(x.evidence_ref))).toEqual(["D-947 [PROPOSED]", "D-947 [PROPOSED]"]);
    // "set at M20": sleeve_reality_cap, tiers, slippage_buckets, bar_latency_p95_min are null for IN and US
    const nulls = await rows(
      db,
      "SELECT code, field FROM market_profile_field WHERE value_json = 'null' ORDER BY code, field",
    );
    expect(nulls.map((x) => `${String(x.code)}.${String(x.field)}`)).toEqual([
      "IN.bar_latency_p95_min",
      "IN.sleeve_reality_cap",
      "IN.slippage_buckets",
      "IN.tiers",
      "US.bar_latency_p95_min",
      "US.sleeve_reality_cap",
      "US.slippage_buckets",
      "US.tiers",
    ]);
  });

  it("a market that is not enabled can only be off (insert and update), and AU keeps its mode", async () => {
    const db = await freshDb("main");
    await expect(
      db.execute(
        "INSERT INTO market (code, tz, open_time, close_time, cutoff_time, currency, mode, enabled) VALUES ('ZZ','UTC','09:00','17:00','18:00','USD','full',0)",
      ),
    ).rejects.toThrow(/not enabled must be off/);
    await db.execute(
      "INSERT INTO market (code, tz, open_time, close_time, cutoff_time, currency, mode, enabled) VALUES ('ZY','UTC','09:00','17:00','18:00','USD','off',0)",
    );
    await expect(
      db.execute("UPDATE market SET mode = 'data_only' WHERE code = 'IN'"),
    ).rejects.toThrow(/not enabled must be off/);
    await expect(db.execute("UPDATE market SET mode = 'full' WHERE code = 'US'")).rejects.toThrow(
      /not enabled must be off/,
    );
    // enabling then setting a mode is allowed (the M20 two-step order), and AU may change mode freely
    await db.execute("UPDATE market SET enabled = 1 WHERE code = 'IN'");
    await db.execute("UPDATE market SET mode = 'data_only' WHERE code = 'IN'");
    await db.execute("UPDATE market SET mode = 'full' WHERE code = 'AU'");
    await expect(db.execute("UPDATE market SET enabled = 0 WHERE code = 'IN'")).rejects.toThrow(
      /not enabled must be off/,
    );
    await expect(db.execute("UPDATE market SET enabled = 2 WHERE code = 'US'")).rejects.toThrow();
    await expect(db.execute("DELETE FROM market WHERE code = 'US'")).rejects.toThrow(
      /never deleted/,
    );
  });

  it("the profile tables keep their guards: no delete of profile rows, an append-only change ledger", async () => {
    const db = await freshDb("main");
    await expect(db.execute("DELETE FROM market_profile WHERE code = 'US'")).rejects.toThrow(
      /never deleted/,
    );
    await expect(db.execute("DELETE FROM market_profile_field WHERE code = 'US'")).rejects.toThrow(
      /never deleted/,
    );
    await expect(
      db.execute("UPDATE market_profile SET work_status = 'frozen' WHERE code = 'US'"),
    ).rejects.toThrow(); // status list
    await expect(
      db.execute(
        "INSERT INTO market_profile_field (code, field, value_json, verify, updated_at) VALUES ('US','x','{bad',1,'t')",
      ),
    ).rejects.toThrow(); // json_valid
    await db.execute(
      "INSERT INTO market_profile_change (code, field, old_json, new_json, changed_at, actor, reason) VALUES ('US','settlement_days','1','2','2030-01-01T00:00:00.000Z','1','test')",
    );
    await expect(db.execute("UPDATE market_profile_change SET reason = 'x'")).rejects.toThrow(
      /append-only/,
    );
    await expect(db.execute("DELETE FROM market_profile_change")).rejects.toThrow(/append-only/);
    await expect(
      db.execute(
        "INSERT INTO market_profile_change (code, field, changed_at, actor, reason) VALUES ('US','f','t','1','')",
      ),
    ).rejects.toThrow(); // reason 1..200
  });
});
