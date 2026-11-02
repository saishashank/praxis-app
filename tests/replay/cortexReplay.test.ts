// @vitest-environment node
// M15 P3 snapshot additions and the Cortex replay world (design 3a "replay" producer; D-321
// provenance; D-278). The new snapshot tables are additive: a snapshot without them is byte-identical
// to before, with them they round-trip and SnapshotWorld exposes them; the as-of world carries the
// corporate-action provenance and a vendor-only row never re-bases. ZZ codes only (SEC-110).
import { describe, expect, it } from "vitest";
import { defaultAgentParams } from "@/lib/agents/params";
import { buildAsOfView } from "@/lib/cortex/pit/asOfView";
import { stepCorpAction, type CorpActionState } from "@/lib/cortex/states/corpAction";
import { buildSnapshot, loadSnapshot, parseSnapshot } from "@/lib/replay/snapshot";
import { asOfWorldOf } from "@/lib/replay/cortexReplay";
import { SnapshotWorld } from "@/lib/replay/snapshotWorld";
import { FROM, TO, replayInputs, replayWorld } from "../fixtures/m15/replayWorld";

const params = defaultAgentParams();

describe("snapshot format additions are additive", () => {
  it("without the new data: no new table lines, no provenance columns on a corporate-action line", () => {
    const s = buildSnapshot({
      from: FROM,
      to: TO,
      inputs: replayInputs({ provenance: "legacy", withUsIndex: false }),
    });
    expect(Object.keys(s.counts)).not.toContain("short_interest");
    expect(Object.keys(s.counts)).not.toContain("macro_series");
    const line = s.text.split("\n").find((l) => l.startsWith('["corporate_actions"'))!;
    expect((JSON.parse(line)[1] as unknown[]).length).toBe(6); // code, ex_date, id, type, factor, known_at
    // the same inputs give the same bytes (determinism) and the table order puts the new tables last but one
    expect(
      buildSnapshot({
        from: FROM,
        to: TO,
        inputs: replayInputs({ provenance: "legacy", withUsIndex: false }),
      }).sha,
    ).toBe(s.sha);
  });

  it("with the new data: tables round-trip through parse and the loaded view", () => {
    const o = { provenance: "notice", withShort: true, withMacro: true } as const;
    const s = buildSnapshot({ from: FROM, to: TO, inputs: replayInputs(o) });
    expect(s.counts.short_interest).toBe(30);
    expect(s.counts.macro_series).toBe(40);
    const parsed = parseSnapshot(s.bytes);
    expect(parsed.sha).toBe(s.sha);
    const loaded = loadSnapshot(s.bytes);
    expect(loaded.shortInterest).toHaveLength(30);
    expect(loaded.macroSeries[0]).toMatchObject({ series: "ZZ_RATE", published_at: null });
    expect(loaded.corporateActions[0]).toMatchObject({
      sources: "announcement,vendor",
      status: "confirmed",
    });
    expect(loaded.indexBars.map((r) => r.index_code)).toContain("GSPC");
    expect(loaded.indexBars.map((r) => r.index_code)).toContain("VIX");
  });

  it("rejects a bad provenance value", () => {
    const inputs = replayInputs({ provenance: "notice" });
    const bad = inputs.corporate_actions.map((a) => ({ ...a, status: "maybe" }));
    expect(() =>
      buildSnapshot({ from: FROM, to: TO, inputs: { ...inputs, corporate_actions: bad } }),
    ).toThrow(/bad_row:corporate_actions.status/);
  });
});

describe("SnapshotWorld exposes the Cortex inputs", () => {
  const world = replayWorld({ provenance: "notice", withShort: true, withMacro: true });

  it("index bars of AXJO, GSPC and VIX; short interest; macro series; calendar", () => {
    expect(world.indexBarsOf("AXJO")).toHaveLength(40);
    expect(world.indexBarsOf("GSPC")).toHaveLength(40);
    expect(world.indexBarsOf("VIX")[0]!.close).toBe(15_000_000n);
    expect(world.indexBarsOf("NOPE")).toEqual([]);
    expect(world.shortInterest().get("ZZA")).toHaveLength(30);
    expect(world.macroSeries().get("ZZ_RATE")).toHaveLength(40);
    expect(world.calendarRows()).toHaveLength(40);
  });

  it("D-321: corporate-action records carry sources and status from the snapshot evidence", () => {
    const rec = world.cortexCorpActions().get("ZZB")![0]!;
    expect(rec).toMatchObject({ sources: ["announcement", "vendor"], status: "confirmed" });
    // the v1 records are untouched: no provenance fields
    expect(Object.keys(world.corpActions("ZZB")[0]!)).not.toContain("sources");
  });

  it("a legacy row (no columns) is vendor-only and confirmed", () => {
    const w = replayWorld({ provenance: "legacy" });
    expect(w.cortexCorpActions().get("ZZB")![0]).toMatchObject({
      sources: ["vendor"],
      status: "confirmed",
    });
  });
});

describe("the replay as-of world (D-321: vendor-only rows never re-base)", () => {
  const stateAfter = (world: SnapshotWorld, code: string): string[] => {
    const view = buildAsOfView(asOfWorldOf({ world, params, indexChangesLoaded: true }));
    const states: string[] = [];
    let s: CorpActionState | null = null;
    for (let t = 0; t < view.sessions.length; t += 1) {
      const step = stepCorpAction(view, code, t, s);
      states.push(step.next.state);
      s = step.next;
    }
    return states;
  };

  it("the view carries the provenance and the US index and short-interest rows by known time", () => {
    const world = replayWorld({ provenance: "notice", withShort: true, withMacro: true });
    const view = buildAsOfView(asOfWorldOf({ world, params, indexChangesLoaded: true }));
    const t = 25;
    expect(view.corpActions("ZZB", t)[0]).toMatchObject({ sources: ["announcement", "vendor"] });
    expect(view.index("GSPC", t, 1)[0]!.d).toBe(view.sessions[t - 1]); // D+1 09:00 rule
    expect(view.shorts("ZZA", t, 5).length).toBeGreaterThan(0);
    expect(view.macro("ZZ_RATE", t, 3).length).toBeGreaterThan(0);
    expect(view.indexChangesLoaded).toBe(true);
    expect(buildAsOfView(asOfWorldOf({ world, params })).indexChangesLoaded).toBe(false); // fail closed
  });

  it("a vendor-only split never becomes a candidate or a re-base; a notice-confirmed one is acted on", () => {
    const vendor = stateAfter(replayWorld({ provenance: "vendor" }), "ZZB");
    expect(new Set(vendor)).toEqual(new Set(["none"]));
    const legacy = stateAfter(replayWorld({ provenance: "legacy" }), "ZZB");
    expect(new Set(legacy)).toEqual(new Set(["none"]));
    const notice = stateAfter(replayWorld({ provenance: "notice" }), "ZZB");
    expect(notice.some((s) => s !== "none")).toBe(true);
  });
});
