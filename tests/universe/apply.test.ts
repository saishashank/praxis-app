// @vitest-environment node
// D-067 apply rules (pure): new, changed, unchanged, missing once vs twice, shrink guard,
// reactivation. DAT-130: delisted codes are kept (nothing here deletes).
import { describe, expect, it } from "vitest";
import {
  DELIST_REASON,
  MISSING_TO_DELIST,
  planUniverse,
  SHRINK_MIN_PERCENT,
  type ExistingInstrument,
} from "@/lib/data/universe/apply.mjs";
import { codes } from "./helpers";

const T = "2026-10-13";
const ex = (code: string, over: Partial<ExistingInstrument> = {}): ExistingInstrument => ({
  code,
  name: `Synthetic ${code} Ltd`,
  industry: "Materials",
  delistedOn: null,
  missingCount: 0,
  ...over,
});
const row = (code: string, over: Partial<{ name: string; industry: string | null }> = {}) => ({
  code,
  name: `Synthetic ${code} Ltd`,
  industry: "Materials",
  ...over,
});
const rows = (n: number, from = 0) => codes(n, from).map((c) => row(c));
const plan = (existing: ExistingInstrument[], file: ReturnType<typeof row>[]) => {
  const p = planUniverse({ existing, file, today: T });
  if (!p.ok) throw new Error("expected ok");
  return p;
};

describe("constants", () => {
  it("two consecutive misses, 80 % floor", () => {
    expect(MISSING_TO_DELIST).toBe(2);
    expect(SHRINK_MIN_PERCENT).toBe(80);
    expect(DELIST_REASON).toBe("absent_from_listed_companies");
  });
});

describe("planUniverse", () => {
  it("first import into an empty table inserts everything and skips the shrink guard", () => {
    const p = plan([], rows(5));
    expect(p.inserts).toHaveLength(5);
    expect(p.counts).toMatchObject({ inserted: 5, prevActive: 0, unchanged: 0, delisted: 0 });
  });

  it("a new code is inserted; unchanged codes change nothing", () => {
    const p = plan(
      codes(10).map((c) => ex(c)),
      [...rows(10), row("ZZNEW")],
    );
    expect(p.inserts.map((r) => r.code)).toEqual(["ZZNEW"]);
    expect(p.updates).toEqual([]);
    expect(p.counts).toMatchObject({ unchanged: 10, inserted: 1 });
  });

  it("name or industry changes update only the changed codes (a null industry counts as changed)", () => {
    const e = [ex("ZZ00"), ex("ZZ01"), ex("ZZ02", { industry: null }), ex("ZZ03"), ex("ZZ04")];
    const p = plan(e, [
      row("ZZ00", { name: "Synthetic Renamed Ltd" }),
      row("ZZ01", { industry: "Banks" }),
      row("ZZ02"),
      row("ZZ03"),
      row("ZZ04"),
    ]);
    expect(p.updates.map((r) => r.code)).toEqual(["ZZ00", "ZZ01", "ZZ02"]);
    expect(p.counts).toMatchObject({ updated: 3, unchanged: 2 });
  });

  it("missing once: counter goes to 1, nothing delisted", () => {
    const p = plan(
      codes(10).map((c) => ex(c)),
      rows(9),
    );
    expect(p.missing).toEqual([{ code: "ZZ09", missingCount: 1 }]);
    expect(p.delists).toEqual([]);
  });

  it("missing on the second consecutive import: delisted", () => {
    const e = codes(10).map((c, i) => ex(c, { missingCount: i === 9 ? 1 : 0 }));
    const p = plan(e, rows(9));
    expect(p.delists).toEqual(["ZZ09"]);
    expect(p.missing).toEqual([]);
    expect(p.counts.delisted).toBe(1);
  });

  it("present again resets the counter (not consecutive)", () => {
    const e = codes(10).map((c, i) => ex(c, { missingCount: i === 3 ? 1 : 0 }));
    const p = plan(e, rows(10));
    expect(p.seenAgain).toEqual(["ZZ03"]);
    expect(p.delists).toEqual([]);
    expect(p.missing).toEqual([]);
  });

  it("shrink guard: exactly 80 % passes, just under rejects", () => {
    const e = codes(10).map((c) => ex(c));
    expect(planUniverse({ existing: e, file: rows(8), today: T }).ok).toBe(true);
    expect(planUniverse({ existing: e, file: rows(7), today: T })).toEqual({
      ok: false,
      error: "suspicious_shrink",
      prevActive: 10,
      fileCount: 7,
    });
  });

  it("the guard counts active instruments only; delisted ones are not part of the base", () => {
    const e = [
      ...codes(5).map((c) => ex(c)),
      ...codes(20, 50).map((c) => ex(c, { delistedOn: "2025-01-01" })),
    ];
    expect(planUniverse({ existing: e, file: rows(4), today: T }).ok).toBe(true);
  });

  it("a delisted code back in the file is reactivated; delisted rows still absent are left alone", () => {
    const e = [
      ...codes(10).map((c) => ex(c)),
      ex("ZZOLD", { delistedOn: "2026-10-01" }), // V1-S7: a quick return (even renamed) is the same company
      ex("ZZGONE", { delistedOn: "2025-03-03" }),
    ];
    const p = plan(e, [...rows(10), row("ZZOLD", { name: "Synthetic Back Ltd" })]);
    expect(p.reactivations.map((r) => r.code)).toEqual(["ZZOLD"]);
    expect(p.inserts).toEqual([]);
    expect(p.delists).toEqual([]);
    expect(p.missing).toEqual([]); // ZZGONE is already delisted: no counter
  });
});
