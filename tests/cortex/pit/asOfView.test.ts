// @vitest-environment node
// The as-of view: every accessor bounded by t, by construction (M15 C1a; CTX-010; TST-109; AT-50).
import { describe, expect, it } from "vitest";
import { decisionCutoffUtc } from "@/lib/agents/decisionView";
import { regimeForLast } from "@/lib/agents/regime";
import { AsOfError, buildAsOfView, cutWorld, sessionIndexOf } from "@/lib/cortex/pit/asOfView";
import {
  assertTruncationInvariant,
  truncationMismatches,
  valueKey,
} from "@/lib/cortex/pit/truncation";
import type { AsOfView } from "@/lib/cortex/pit/types";
import { barsFor, CUTOFF_HHMM, regimeWorld, SESSIONS, zzWorld } from "./zzWorld";

const world = zzWorld();
const view = buildAsOfView(world);
const T = (d: string) => sessionIndexOf(SESSIONS, d);

describe("bounds by construction", () => {
  it("answers 0..maxT and refuses anything else with AsOfError", () => {
    expect(view.maxT).toBe(SESSIONS.length - 1);
    expect(view.cutoffUtc(0)).toBe(decisionCutoffUtc("2026-03-02", CUTOFF_HHMM));
    for (const bad of [-1, SESSIONS.length, 1.5, Number.NaN]) {
      expect(() => view.bars("ZZA", bad, 5)).toThrow(AsOfError);
      expect(() => view.codes(bad)).toThrow(AsOfError);
      expect(() => view.regime(bad)).toThrow(AsOfError);
      expect(() => view.manifest(bad)).toThrow(AsOfError);
    }
  });

  it("a truncated handle keeps the full session list but refuses t beyond its cut", () => {
    const h = view.truncated(3);
    expect(h.maxT).toBe(3);
    expect(h.sessions).toBe(view.sessions);
    expect(h.bars("ZZA", 3, 2).map((b) => b.d)).toEqual(["2026-03-04", "2026-03-05"]);
    expect(() => h.bars("ZZA", 4, 1)).toThrow(AsOfError);
    expect(() => h.indexChanges("ZZB", 4)).toThrow(AsOfError);
    expect(view.truncated(view.maxT)).toBe(view);
    expect(() => view.truncated(99)).toThrow(AsOfError);
  });

  it("sessionIndexOf finds sessions and refuses non-sessions", () => {
    expect(T("2026-03-10")).toBe(5);
    expect(() => T("2026-03-09")).toThrow(RangeError);
  });

  it("refuses unsorted bars and an empty session list", () => {
    const bad = zzWorld({ bars: new Map([["ZZA", [...barsFor("ZZA")].reverse()]]) });
    expect(() => buildAsOfView(bad)).toThrow(RangeError);
    expect(() => buildAsOfView(zzWorld({ sessions: [], bars: new Map() }))).toThrow(RangeError);
  });
});

describe("accessors return only what the cut-off of sessions[t] has made known", () => {
  it("bars: the last count with d <= sessions[t]", () => {
    expect(view.bars("ZZA", 2, 2).map((b) => b.d)).toEqual(["2026-03-03", "2026-03-04"]);
    expect(view.bars("ZZA", 0, 5).map((b) => b.d)).toEqual(["2026-03-02"]);
    expect(view.bars("ZZX", 3, 5)).toEqual([]);
  });

  it("codes: universe codes with a bar on the session and a tier at t, sorted", () => {
    expect(view.codes(0)).toEqual(["ZZA", "ZZB"]); // ZZC has no tier before the 10th
    expect(view.codes(T("2026-03-10"))).toEqual(["ZZA", "ZZB", "ZZC"]);
    expect(view.tier("ZZC", 4)).toBeNull();
    expect(view.tier("ZZC", 5)).toBe("U3");
    expect(view.tier("ZZA", 0)).toBe("U1");
    expect(view.tier("ZZX", 0)).toBeNull();
    // Without a tier table every code with a bar is in the universe.
    const noTiers = buildAsOfView(zzWorld({ tiers: undefined }));
    expect(noTiers.codes(0)).toEqual(["ZZA", "ZZB", "ZZC"]);
  });

  it("index: AXJO at the cut-off of D; GSPC/VIX one session later (D-290)", () => {
    const t = T("2026-03-05");
    expect(view.index("AXJO", t, 1)[0]!.d).toBe("2026-03-05");
    expect(view.index("GSPC", t, 1)[0]!.d).toBe("2026-03-04");
    expect(view.index("VIX", t, 1)[0]!.d).toBe("2026-03-04");
    // Friday's US bar is known Saturday 09:00, so the Tuesday after the holiday sees it.
    expect(view.index("GSPC", T("2026-03-10"), 1)[0]!.d).toBe("2026-03-06");
    expect(view.index("GSPC", 0, 3)).toEqual([]);
  });

  it("shorts: newest first, only points ASIC has published by the cut-off", () => {
    expect(view.shorts("ZZA", T("2026-03-06"), 5)).toEqual([]);
    // as_of 03-02 + 5 weekdays = 03-09 23:59:59Z -> usable on the 10th; as_of 03-03 -> 03-10 23:59:59Z -> the 11th.
    expect(view.shorts("ZZA", T("2026-03-10"), 5)).toEqual([{ asOf: "2026-03-02", ppm: 12_000 }]);
    expect(view.shorts("ZZA", T("2026-03-11"), 5).map((p) => p.asOf)).toEqual([
      "2026-03-03",
      "2026-03-02",
    ]);
    expect(view.shorts("ZZA", T("2026-03-11"), 1).map((p) => p.asOf)).toEqual(["2026-03-03"]);
  });

  it("macro: the series rule decides when an observation is usable", () => {
    expect(view.macro("RBA_CASH_RATE", T("2026-03-02"), 5)).toEqual([]);
    expect(view.macro("RBA_CASH_RATE", T("2026-03-03"), 5)).toEqual([
      { obsD: "2026-03-03", value: 3.6 },
    ]);
    expect(view.macro("DGS10", T("2026-03-02"), 5)).toEqual([]);
    expect(view.macro("DGS10", T("2026-03-03"), 5)).toEqual([{ obsD: "2026-03-02", value: 4.2 }]);
    expect(view.macro("CPIAUCSL", view.maxT, 5)).toEqual([]); // lag 35 runs past this world
    expect(view.macro("NOPE", 0, 5)).toEqual([]);
  });

  it("events: a timed row from its publication; an untimed row from the next session; day0 <= D", () => {
    expect(view.events("ZZA", T("2026-03-04"))).toEqual([]); // published 23:30Z on the 4th, after the cut-off
    const zza = view.events("ZZA", T("2026-03-05"));
    expect(zza.map((e) => e.day0)).toEqual(["2026-03-05"]);
    expect("publishedAt" in zza[0]!).toBe(false);
    expect(view.events("ZZB", T("2026-03-06"))).toEqual([]);
    expect(view.events("ZZB", T("2026-03-10")).map((e) => e.day0)).toEqual(["2026-03-06"]);
  });

  it("corpActions: by known_at (confirmed) or ex-date - 1 session (vendor)", () => {
    expect(view.corpActions("ZZC", T("2026-03-06"))).toEqual([]);
    expect(view.corpActions("ZZC", T("2026-03-10")).map((a) => a.id)).toEqual(["ca-zzc-split"]);
    expect(view.corpActions("ZZA", T("2026-03-03"))).toEqual([]);
    expect(view.corpActions("ZZA", T("2026-03-04")).map((a) => a.id)).toEqual(["ca-zza-div"]);
  });

  it("indexChanges: from the announced date; a missing list is reported, not silently empty", () => {
    expect(view.indexChangesLoaded).toBe(true);
    expect(view.indexChanges("ZZB", T("2026-03-03"))).toEqual([]);
    expect(view.indexChanges("ZZB", T("2026-03-04"))).toEqual([
      { indexName: "ZZ200", kind: "add", announced: "2026-03-04", effective: "2026-03-12" },
    ]);
    const missing = buildAsOfView(zzWorld({ indexChanges: null }));
    expect(missing.indexChangesLoaded).toBe(false);
    expect(missing.indexChanges("ZZB", 5)).toEqual([]);
    expect(() => missing.indexChanges("ZZB", 99)).toThrow(AsOfError);
  });

  it("industry and halted: the latest as-of row, null before any", () => {
    expect(view.industry("ZZA", T("2026-03-02"))).toBeNull();
    expect(view.industry("ZZA", T("2026-03-03"))).toBe("Materials");
    expect(view.industry("ZZB", 5)).toBeNull();
    expect(view.halted("ZZB", T("2026-03-10"))).toBeNull();
    expect(view.halted("ZZB", T("2026-03-11"))).toBe(true);
    expect(view.halted("ZZB", T("2026-03-13"))).toBe(false);
    expect(view.halted("ZZA", 5)).toBeNull();
  });

  it("adj: split-adjusted on the basis known at the cut-off; the dividend factor is separate", () => {
    // ZZC's 2-for-1 split (ex 11th) is confirmed on the 10th at 05:00Z, before the 10th's cut-off, but
    // its ex-date is after the 10th, so the basis of the 10th is unadjusted (DAT-126 ex-date <= D).
    const before = view.adj("ZZC", T("2026-03-10"), 3);
    expect(before.adjClose).toEqual(before.raw.map((b) => b.close));
    const after = view.adj("ZZC", T("2026-03-11"), 3);
    expect(after.d).toEqual(["2026-03-06", "2026-03-10", "2026-03-11"]);
    expect(after.adjClose[0]).toBe(after.raw[0]!.close / 2n);
    expect(after.adjVolume[0]).toBe(after.raw[0]!.volume * 2n);
    expect(after.adjClose[2]).toBe(after.raw[2]!.close); // on the ex-date itself: no later split
    expect(after.adj[0]!.open).toBe(after.raw[0]!.open / 2n);
    // ZZA's dividend (ex 5th, A$0.10 on a close of A$20.40 the session before): factor on bars before it.
    const zza = view.adj("ZZA", T("2026-03-06"), 5);
    expect(zza.divFactor[0]).toBeCloseTo(1 - 100_000 / 20_400_000, 12);
    expect(zza.divFactor[3]).toBe(1); // the ex-date bar and later carry no factor
    expect(zza.adjClose).toEqual(zza.raw.map((b) => b.close)); // dividends never touch the price basis
    expect(view.adj("ZZX", 3, 5).d).toEqual([]);
  });

  it("regime: unknown before the warm-up, and the same by construction as a fresh regimeForLast", () => {
    expect(view.regime(0)).toBe("unknown");
    const rw = regimeWorld();
    const rv = buildAsOfView(rw);
    const closes = rw.index!.AXJO!.map((b) => b.close);
    const seen = new Set<string>();
    for (const t of [10, 140, 155, 159, 200, 260, 299]) {
      const expected = regimeForLast(closes.slice(0, t + 1), rw.regimeParams, null).state;
      expect(rv.regime(t)).toBe(expected);
      seen.add(expected);
    }
    expect(rv.regime(10)).toBe("unknown");
    expect(rv.regime(159)).toBe("SHOCK");
    expect(seen.size).toBeGreaterThanOrEqual(3); // the fixture actually moves between regimes
  });
});

describe("manifest", () => {
  it("counts rows per kind up to the cut-off, in InputKind order, with a stable id", () => {
    const m = view.manifest(T("2026-03-10"));
    expect(m.d).toBe("2026-03-10");
    expect(m.market).toBe("AU");
    expect(m.schemaSha).toBe("schema-zz-1");
    const byKind = Object.fromEntries(m.sources.map((s) => [s.kind, s.rows]));
    expect(byKind).toEqual({
      bar_au: 18, // 3 codes x 6 sessions
      index_au: 6,
      index_us: 10, // GSPC + VIX, five sessions each (the 10th's bars are known on the 11th)
      asic_short: 1,
      macro: 2, // RBA cash rate (decision day) and DGS10 (+1 session); CPIAUCSL's lag runs past the world
      announcement: 2,
      corp_action: 2,
      index_change: 1,
      calendar: 13,
      sector_map: 1,
    });
    expect(m.manifestId).toMatch(/^[0-9a-f]{64}$/);
    expect(buildAsOfView(zzWorld()).manifest(T("2026-03-10")).manifestId).toBe(m.manifestId);
    expect(view.manifest(T("2026-03-11")).manifestId).not.toBe(m.manifestId);
  });
});

describe("cutWorld and the TST-109 helper", () => {
  it("cutWorld keeps exactly the rows the full view knows at t", () => {
    const t = T("2026-03-10");
    const cut = cutWorld(world, t);
    expect(cut.sessions).toEqual(SESSIONS.slice(0, t + 1));
    expect(cut.bars.get("ZZA")!.length).toBe(t + 1);
    expect(cut.index!.GSPC!.map((b) => b.d).at(-1)).toBe("2026-03-06");
    expect(cut.shorts!.get("ZZA")!.map((p) => p.asOf)).toEqual(["2026-03-02"]);
    expect(cut.macro!.get("CPIAUCSL")).toEqual([]);
    expect(cut.macro!.get("RBA_CASH_RATE")).toEqual([{ obsD: "2026-03-03", value: 3.6 }]);
    expect(cut.events!.get("ZZB")!.length).toBe(1);
    expect(cut.corpActions!.get("ZZC")!.length).toBe(1);
    expect(cut.tiers!.get("ZZC")!.length).toBe(1);
    expect(cut.halts!.get("ZZB")).toEqual([]);
    expect(() => cutWorld(world, 99)).toThrow(RangeError);
    const cutView = buildAsOfView(cut);
    expect(cutView.manifest(t).manifestId).toBe(view.manifest(t).manifestId);
  });

  it("a clean feature passes at every (code, t); a leaky one is caught with the two values", () => {
    const clean = (v: AsOfView, code: string, t: number) => ({
      close: v.adj(code, t, 3).adjClose.at(-1),
      shorts: v.shorts(code, t, 1),
      us: v.index("GSPC", t, 1).map((b) => b.d),
      ev: v.events(code, t).length,
      ind: v.industry(code, t),
      regime: v.regime(t),
      manifest: v.manifest(t).manifestId,
    });
    expect(truncationMismatches(world, clean)).toEqual([]);
    expect(() => assertTruncationInvariant(world, clean)).not.toThrow();
    expect(
      truncationMismatches(regimeWorld(), (v, _c, t) => v.regime(t), { ts: [100, 200, 299] }),
    ).toEqual([]);

    // Reads the last bar of the handle instead of the bar at t: sees the future on the full view.
    const leaky = (v: AsOfView, code: string) => v.bars(code, v.maxT, 1)[0]?.close;
    const m = truncationMismatches(world, leaky, { codes: ["ZZA"] });
    expect(m.length).toBe(SESSIONS.length - 1);
    expect(m[0]).toEqual({
      code: "ZZA",
      t: 0,
      full: valueKey(barsFor("ZZA").at(-1)!.close),
      cut: valueKey(barsFor("ZZA")[0]!.close),
    });
    expect(() => assertTruncationInvariant(world, leaky)).toThrow(/TST-109/);

    // A feature that throws on one side is a mismatch too, named by the error.
    const throwing = (v: AsOfView, code: string, t: number) => v.bars(code, t + 1, 1).length;
    const tm = truncationMismatches(world, throwing, { codes: ["ZZA"], ts: [0] });
    expect(tm).toEqual([{ code: "ZZA", t: 0, full: "1", cut: "throw:AsOfError" }]);
  });

  it("valueKey is stable over key order, bigint, undefined and maps", () => {
    expect(valueKey({ b: 1n, a: undefined })).toBe(valueKey({ a: undefined, b: 1n }));
    expect(valueKey(undefined)).toBe("undefined");
    expect(valueKey(new Map([["x", 2]]))).toBe('[["x",2]]');
    expect(valueKey([1, "a", null])).toBe('[1,"a",null]');
  });
});
