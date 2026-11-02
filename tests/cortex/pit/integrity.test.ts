// @vitest-environment node
// L0 integrity predicates (M15 C1a; CTX-010 null close and late bar; CTX-050 / D-289 quota degrade).
import { describe, expect, it } from "vitest";
import {
  hasNullClose,
  isLateBarNight,
  partitionNullClose,
  quotaDegrade,
} from "@/lib/cortex/pit/integrity";
import { buildManifest, manifestIdOf, normaliseSources } from "@/lib/cortex/pit/manifest";
import { INPUT_KINDS } from "@/lib/cortex/pit/types";

describe("null-close rejection", () => {
  it("rejects null, missing, non-finite and non-positive adjusted closes; keeps the rest in order", () => {
    expect(hasNullClose({ adjClose: null })).toBe(true);
    expect(hasNullClose({ adjClose: undefined })).toBe(true);
    expect(hasNullClose({ adjClose: 0n })).toBe(true);
    expect(hasNullClose({ adjClose: -1 })).toBe(true);
    expect(hasNullClose({ adjClose: Number.NaN })).toBe(true);
    expect(hasNullClose({ adjClose: "1.5" })).toBe(true);
    expect(hasNullClose({ adjClose: 1n })).toBe(false);
    expect(hasNullClose({ adjClose: 0.5 })).toBe(false);
    const rows = [
      { code: "ZZA", adjClose: 1n },
      { code: "ZZB", adjClose: null },
      { code: "ZZC", adjClose: 3n },
    ];
    const p = partitionNullClose(rows);
    expect(p.kept.map((r) => r.code)).toEqual(["ZZA", "ZZC"]);
    expect(p.rejected.map((r) => r.code)).toEqual(["ZZB"]);
  });
});

describe("late D bar = abstain-all night", () => {
  it("abstains when the benchmark bar is not dated D or no universe code has a D bar", () => {
    expect(
      isLateBarNight({ d: "2026-03-05", benchmarkBarD: "2026-03-05", universeBarsOnD: 1 }),
    ).toBe(false);
    expect(
      isLateBarNight({ d: "2026-03-05", benchmarkBarD: "2026-03-04", universeBarsOnD: 500 }),
    ).toBe(true);
    expect(isLateBarNight({ d: "2026-03-05", benchmarkBarD: null, universeBarsOnD: 500 })).toBe(
      true,
    );
    expect(
      isLateBarNight({ d: "2026-03-05", benchmarkBarD: "2026-03-05", universeBarsOnD: 0 }),
    ).toBe(true);
  });
});

describe("quota degrade (D-289)", () => {
  const base = {
    elapsedMinutes: 5,
    stageMinutes: 20,
    staleShare: 0.01,
    staleUniverseMaxShare: 0.1,
  };
  it("null inside both bounds (equality still runs); quota first, then universe_incomplete", () => {
    expect(quotaDegrade(base)).toBeNull();
    expect(quotaDegrade({ ...base, elapsedMinutes: 20 })).toBeNull();
    expect(quotaDegrade({ ...base, staleShare: 0.1 })).toBeNull();
    expect(quotaDegrade({ ...base, elapsedMinutes: 20.5 })).toBe("quota");
    expect(quotaDegrade({ ...base, staleShare: 0.11 })).toBe("universe_incomplete");
    expect(quotaDegrade({ ...base, elapsedMinutes: 61, staleShare: 1 })).toBe("quota");
  });

  it("refuses non-finite or negative inputs", () => {
    expect(() => quotaDegrade({ ...base, elapsedMinutes: Number.NaN })).toThrow(RangeError);
    expect(() => quotaDegrade({ ...base, staleShare: -0.1 })).toThrow(RangeError);
  });
});

describe("input manifest id", () => {
  const sources = [
    { kind: "bar_au" as const, rows: 10, lastKnownAt: "2026-03-05T07:10:00.000Z" },
    { kind: "calendar" as const, rows: 3, lastKnownAt: "1970-01-01T00:00:00.000Z" },
  ];
  const body = { market: "AU", d: "2026-03-05", schemaSha: "s1", sources };

  it("is the sha256 of canonical JSON: same inputs -> same id, any change -> a new id", () => {
    const id = manifestIdOf(body);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(manifestIdOf({ ...body, sources: [...sources].reverse() })).toBe(id);
    expect(manifestIdOf({ ...body, schemaSha: "s2" })).not.toBe(id);
    expect(
      manifestIdOf({ ...body, sources: [{ ...sources[0]!, rows: 11 }, sources[1]!] }),
    ).not.toBe(id);
    expect(manifestIdOf({ ...body, d: "2026-03-06" })).not.toBe(id);
  });

  it("normalises to one row per InputKind in table order", () => {
    const m = buildManifest(body);
    expect(m.sources.map((s) => s.kind)).toEqual(INPUT_KINDS);
    expect(m.sources.find((s) => s.kind === "macro")).toEqual({
      kind: "macro",
      rows: 0,
      lastKnownAt: null,
    });
    expect(m.manifestId).toBe(manifestIdOf(body));
    expect(() => normaliseSources([sources[0]!, sources[0]!])).toThrow(RangeError);
  });
});
