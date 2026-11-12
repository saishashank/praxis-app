// @vitest-environment node
// DAT-242 (M19 A1; D-999): profile completeness is computed, never stored. Cited under AT-67 (d) and AT-68 (c)
// (the Markets row's "n of m fields verified"). The seed: AU complete, IN and US incomplete with exact counts;
// verifying every IN field with a date and a reference makes it complete; the one writer bumps the version,
// appends the change ledger, re-projects `market`, and charges a counted trial for a cost, tick, slippage,
// settlement or parcel change; a second identical write is a no-op; the ledger refuses UPDATE and DELETE.
import { afterEach, describe, expect, it } from "vitest";
import { PROFILE_FIELDS } from "@/lib/market/fields.mjs";
import { completeness, isComplete } from "@/lib/market/profileCore.mjs";
import { invalidateProfiles, loadProfile } from "@/lib/market/profile";
import { markFieldVerified, setProfileField } from "@/lib/market/profileWrite";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(() => {
  cleanupTempDbs();
  invalidateProfiles();
});

const NOW = "2030-02-03T04:05:06.000Z";
const base = { actor: "1", reason: "test", now: NOW } as const;

describe("completeness from the seed", () => {
  it("AU is complete; IN and US are incomplete by design with the exact counts", async () => {
    const db = await freshDb("main");
    const au = await loadProfile(db, "AU");
    expect(au.complete).toBe(true);
    expect(isComplete(au)).toBe(true);
    expect(au.completeness).toMatchObject({
      total: 40,
      valued: 40,
      verified: 40,
      missing: [],
      unverified: [],
    });
    for (const code of ["IN", "US"]) {
      const p = await loadProfile(db, code);
      expect(p.complete).toBe(false);
      expect(p.completeness.total).toBe(40);
      expect(p.completeness.valued).toBe(40); // the four M20 fields were set by A4 (all [VERIFY])
      expect(p.completeness.verified).toBe(0); // every [VERIFY] value awaits its evidence
      expect(p.completeness.unverified).toHaveLength(40);
      expect(p.completeness.missing).toHaveLength(0);
    }
  });

  it("a field is verified only with BOTH a date and a reference", () => {
    const f = (verifiedAt: string | null, evidenceRef: string | null) => ({
      value: 1,
      verify: 1 as const,
      verifiedAt,
      evidenceRef,
    });
    const fields = Object.fromEntries(
      PROFILE_FIELDS.map((n) => [n, f("2030-01-01", "DAT-101 report")]),
    );
    expect(isComplete({ fields })).toBe(true);
    expect(isComplete({ fields: { ...fields, tz: f("2030-01-01", null) } })).toBe(false);
    expect(isComplete({ fields: { ...fields, tz: f(null, "ref") } })).toBe(false);
    expect(
      isComplete({ fields: { ...fields, tz: { ...f(null, null), verify: 0 as const } } }),
    ).toBe(true);
    expect(isComplete({ fields: { ...fields, tz: { ...f("d", "r"), value: null } } })).toBe(false);
    expect(completeness({ fields: {} }).missing).toHaveLength(40);
  });
});

describe("setProfileField, the one writer", () => {
  it("verifying every IN field with a date and a reference, and filling the four M20 fields, makes it complete", async () => {
    const db = await freshDb("main");
    const before = await loadProfile(db, "IN");
    for (const name of before.completeness.missing) {
      const value: Record<string, unknown> = {
        tiers: { windowSessions: 60 },
        slippage_buckets: { buckets: [{ fromAdvMicro: 0n, bps: 25 }] },
        sleeve_reality_cap: { multiple: 2, basis: "SEBI" },
        bar_latency_p95_min: 45,
      };
      const r = await setProfileField(db, { ...base, code: "IN", field: name, value: value[name] });
      expect(r.ok, `${name}: ${JSON.stringify(r)}`).toBe(true);
    }
    for (const name of PROFILE_FIELDS) {
      const r = await markFieldVerified(db, {
        ...base,
        code: "IN",
        field: name,
        verified: { at: "2030-02-01", evidenceRef: "DAT-101 report" },
      });
      expect(r.ok, name).toBe(true);
    }
    invalidateProfiles();
    const p = await loadProfile(db, "IN");
    expect(p.complete).toBe(true);
    expect(p.completeness).toMatchObject({ valued: 40, verified: 40 });
  });

  it("a settlement_days change is a counted trial: ledger row, version bump, projection, one write only", async () => {
    const db = await freshDb("main");
    // two Cortex lineages of AU already have a split: both are charged, the others are skipped
    for (const family of ["F1", "F4"]) {
      await db.execute({
        sql: "INSERT INTO lineage (id, created_d) VALUES (?, '2030-01-01')",
        args: [`AU:${family}`],
      });
      await db.execute({
        sql: `INSERT INTO lineage_split (lineage_id, version, block_sessions, holdout_len, validation_len, purge,
                data_end_d, deferred_until_d, reason) VALUES (?, 1, 20, 60, 60, 5, '2030-01-01', '2030-12-31', 'create')`,
        args: [`AU:${family}`],
      });
    }
    const r = await setProfileField(db, {
      ...base,
      code: "AU",
      field: "settlement_days",
      value: 1,
    });
    expect(r).toMatchObject({ ok: true, changed: true, version: 2, countedTrial: true });
    expect(r.ok && r.chargedLineages).toEqual(["AU:F1", "AU:F4"]);
    const ch = (await db.execute("SELECT * FROM market_profile_change WHERE actor <> 'migration'"))
      .rows;
    expect(ch).toHaveLength(1);
    expect(ch[0]).toMatchObject({
      code: "AU",
      field: "settlement_days",
      old_json: "2",
      new_json: "1",
      actor: "1",
      reason: "test",
      counted_trial: 1,
    });
    const trials = (
      await db.execute("SELECT lineage_id, kind, variant FROM trial_ledger ORDER BY lineage_id")
    ).rows;
    expect(trials.map((t) => String(t.lineage_id))).toEqual(["AU:F1", "AU:F4"]);
    expect(
      trials.every((t) => t.kind === "challenger" && t.variant === "field:settlement_days"),
    ).toBe(true);
    expect((await loadProfile(db, "AU")).settlementDays).toBe(1);
    // the identical write again changes nothing: no version bump, no second ledger row, no second trial
    const again = await setProfileField(db, {
      ...base,
      code: "AU",
      field: "settlement_days",
      value: 1,
    });
    expect(again).toMatchObject({ ok: true, changed: false, version: 2, countedTrial: false });
    expect(
      (await db.execute("SELECT 1 FROM market_profile_change WHERE actor <> 'migration'")).rows,
    ).toHaveLength(1);
    expect((await db.execute("SELECT 1 FROM trial_ledger")).rows).toHaveLength(2);
  });

  it("a session or cut-off change re-projects the market row; a non-counted field charges no trial", async () => {
    const db = await freshDb("main");
    const r = await setProfileField(db, {
      ...base,
      code: "AU",
      field: "decision_cutoff",
      value: { time: "18:20", zone: "Australia/Melbourne" },
    });
    expect(r).toMatchObject({ ok: true, changed: true, countedTrial: false });
    const row = (await db.execute("SELECT cutoff_time, slots_json FROM market WHERE code = 'AU'"))
      .rows[0]!;
    expect(row.cutoff_time).toBe("18:20");
    expect(JSON.parse(String(row.slots_json)).cutoff).toBe("18:20");
    expect(
      (
        await db.execute(
          "SELECT counted_trial FROM market_profile_change WHERE actor <> 'migration'",
        )
      ).rows[0]!.counted_trial,
    ).toBe(0);
    expect((await db.execute("SELECT 1 FROM trial_ledger")).rows).toHaveLength(0);
  });

  it("a changed [VERIFY] value loses its evidence unless the caller supplies it with the value", async () => {
    const db = await freshDb("main");
    await markFieldVerified(db, {
      ...base,
      code: "US",
      field: "settlement_days",
      verified: { at: "2030-02-01", evidenceRef: "ref-1" },
    });
    await setProfileField(db, { ...base, code: "US", field: "settlement_days", value: 2 });
    let row = (
      await db.execute(
        "SELECT verified_at, evidence_ref FROM market_profile_field WHERE code = 'US' AND field = 'settlement_days'",
      )
    ).rows[0]!;
    expect([row.verified_at, row.evidence_ref]).toEqual([null, null]);
    await setProfileField(db, {
      ...base,
      code: "US",
      field: "settlement_days",
      value: 1,
      verified: { at: "2030-02-02", evidenceRef: "ref-2" },
    });
    row = (
      await db.execute(
        "SELECT verified_at, evidence_ref FROM market_profile_field WHERE code = 'US' AND field = 'settlement_days'",
      )
    ).rows[0]!;
    expect([row.verified_at, row.evidence_ref]).toEqual(["2030-02-02", "ref-2"]);
  });

  it("refuses an unknown market or field, a bad shape, a null and a missing reason", async () => {
    const db = await freshDb("main");
    expect(
      await setProfileField(db, { ...base, code: "ZZ", field: "settlement_days", value: 1 }),
    ).toMatchObject({ ok: false, error: "unknown_market" });
    expect(
      await setProfileField(db, { ...base, code: "AU", field: "nope", value: 1 }),
    ).toMatchObject({ ok: false, error: "unknown_field" });
    expect(
      await setProfileField(db, { ...base, code: "AU", field: "settlement_days", value: 9 }),
    ).toMatchObject({ ok: false, error: "invalid" });
    expect(
      await setProfileField(db, { ...base, code: "AU", field: "settlement_days", value: null }),
    ).toMatchObject({ ok: false, error: "invalid" });
    expect(
      await setProfileField(db, {
        ...base,
        reason: " ",
        code: "AU",
        field: "settlement_days",
        value: 1,
      }),
    ).toMatchObject({ ok: false, error: "invalid" });
    expect(
      (await db.execute("SELECT 1 FROM market_profile_change WHERE actor <> 'migration'")).rows,
    ).toHaveLength(0);
  });

  it("the change ledger refuses UPDATE and DELETE", async () => {
    const db = await freshDb("main");
    await setProfileField(db, { ...base, code: "AU", field: "preopen_recheck_min", value: 6 });
    await expect(db.execute("UPDATE market_profile_change SET reason = 'x'")).rejects.toThrow(
      /append-only/,
    );
    await expect(db.execute("DELETE FROM market_profile_change")).rejects.toThrow(/append-only/);
  });
});
