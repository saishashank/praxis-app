// @vitest-environment node
// Probes in the night (Owner O-81; design C.6 table 5): an open candidate measure is computed beside the
// night and stored in cortex_feature_probe only. Without probes the bytes are unchanged; with probes
// everything but the probe values is byte-identical (they never enter S, eligibility, a gate or
// cortex_feature_daily). A promoted measure is scored only by the rule that admits it. Synthetic ZZ data.
import type { Client } from "@libsql/client";
import { afterAll, describe, expect, it } from "vitest";
import type { Family } from "@/lib/agents/families/types";
import type { AngleDef } from "@/lib/cortex/angles/types";
import { probeRowsOf } from "@/lib/cortex/learn/baseStore";
import {
  nightOutputJson,
  probeDefsOf,
  runNight,
  type FamilyNightRule,
  type NightInputs,
  type NightOutput,
} from "@/lib/cortex/night";
import { activeSetHash } from "@/lib/cortex/score/map";
import type { CortexMap } from "@/lib/cortex/score/types";
import { persistNight, ruleFromMap } from "@/lib/cortex/stage";
import type { MapRow } from "@/lib/cortex/store/maps";
import { cleanupTempDbs, freshDb } from "../../db/helpers";
import { mapFor, NIGHT_ANGLES, nightInputs, ruleFor, SESSIONS } from "./zzNight";

afterAll(cleanupTempDbs);

const T = SESSIONS.length - 1;

/** A candidate measure (no passport): three-session return, momentum cluster, live input. */
const PROBE: AngleDef = {
  id: "A-D3-01",
  version: 2,
  domain: 3,
  title: "ZZ short return",
  definition: "close over the close two sessions back, minus one",
  kind: "score",
  cluster: "momentum",
  orientation: 1,
  horizonSessions: 5,
  warmupSessions: 3,
  inputs: ["bar_au"],
  grid: {},
  compute: (view, code, t) => {
    const s = view.adj(code, t, 3);
    if (s.adjClose.length < 3) return undefined;
    return Number(s.adjClose[2]! - s.adjClose[0]!) / Number(s.adjClose[0]!);
  },
};
const MACRO: AngleDef = { ...PROBE, id: "A-D3-02", inputs: ["macro"] };
const FLAGGER: AngleDef = { ...PROBE, id: "A-D3-03", compute: () => ({ flag: "hot" }) };
const ANGLES = [...NIGHT_ANGLES, PROBE, MACRO, FLAGGER];

const withProbes = (probes: readonly string[] | undefined, over: Partial<NightInputs> = {}) =>
  nightInputs(T, { angles: ANGLES, ...(probes === undefined ? {} : { probes }), ...over });

const withoutProbes = (out: NightOutput): string => nightOutputJson({ ...out, probes: undefined });

describe("runNight with probes", () => {
  it("an empty probe list is the same as none, and the registry addition alone changes nothing", () => {
    const none = nightOutputJson(runNight(nightInputs(T)));
    expect(nightOutputJson(runNight(withProbes(undefined)))).toBe(none);
    expect(nightOutputJson(runNight(withProbes([])))).toBe(none);
  });

  it("computes the probe on every code and leaves every other byte as it was", () => {
    const base = runNight(withProbes(undefined));
    const out = runNight(withProbes(["A-D3-01"]));
    expect(out.probes).toBeDefined();
    expect([...out.probes!.keys()]).toEqual([...out.features.keys()]);
    for (const feats of out.probes!.values()) expect([...feats.keys()]).toEqual(["A-D3-01"]);
    const values = [...out.probes!.values()].map((m) => m.get("A-D3-01"));
    expect(values.some((v) => typeof v === "number")).toBe(true);
    for (const feats of out.features.values()) expect(feats.has("A-D3-01")).toBe(false);
    expect(withoutProbes(out)).toBe(nightOutputJson(base));
    expect(out.decisions.length).toBeGreaterThan(0);
  });

  it("never computes an angle of the scored set, one without live readers, or an unknown id", () => {
    expect(runNight(withProbes(["A-D1-01", "A-D3-02", "A-D9-99"])).probes).toBeUndefined();
    const defs = probeDefsOf(ANGLES, NIGHT_ANGLES, ["A-D1-01", "A-D3-01", "A-D3-02", "A-D3-03"]);
    expect(defs.map((a) => a.id)).toEqual(["A-D3-01", "A-D3-03"]);
    expect(probeDefsOf(ANGLES, NIGHT_ANGLES, undefined)).toEqual([]);
  });

  it("an abstain-all night computes no probe", () => {
    const out = runNight(withProbes(["A-D3-01"], { degrade: { elapsedMinutes: 10_000 } }));
    expect(out.status).toBe("abstain_all");
    expect(out.probes).toBeUndefined();
  });
});

describe("persistNight with probes", () => {
  async function dump(
    inputs: NightInputs,
  ): Promise<{ rows: string; probes: Record<string, unknown>[] }> {
    const db: Client = await freshDb("main");
    const out = runNight(inputs);
    await persistNight(db, {
      market: "AU",
      d: inputs.d,
      inputs,
      out,
      runtimeMs: 7,
      createdAt: "2026-03-28T08:00:00.000Z",
    });
    const parts: string[] = [];
    for (const t of ["cortex_night", "cortex_feature_daily", "cortex_decision", "cortex_abstain"]) {
      const r = await db.execute(`SELECT * FROM ${t} ORDER BY 1, 2, 3, 4`);
      parts.push(`${t}:${JSON.stringify(r.rows.map((x) => ({ ...x })))}`);
    }
    const p = await db.execute("SELECT * FROM cortex_feature_probe ORDER BY d, code, angle_id");
    db.close();
    return { rows: parts.join("\n"), probes: p.rows.map((x) => ({ ...x })) };
  }

  it("writes the probe values to cortex_feature_probe only; every other row is unchanged", async () => {
    const a = await dump(withProbes(undefined));
    const b = await dump(withProbes(["A-D3-01", "A-D3-03"]));
    expect(b.rows).toBe(a.rows);
    expect(a.probes).toEqual([]);
    expect(b.probes.length).toBeGreaterThan(0);
    expect(new Set(b.probes.map((r) => r.angle_id))).toEqual(new Set(["A-D3-01", "A-D3-03"]));
    const flagged = b.probes.filter((r) => r.angle_id === "A-D3-03");
    expect(flagged.every((r) => r.value === null && r.flag === "hot")).toBe(true);
    expect(b.probes.find((r) => r.angle_id === "A-D3-01")!.angle_version).toBe(2);
  });

  it("probeRowsOf: version 1 for an angle the list does not know, undefined as null", () => {
    const rows = probeRowsOf(
      "AU",
      "2026-03-27",
      new Map([["ZZA", new Map([["A-D3-09", undefined]])]]),
      "m",
      [],
    );
    expect(rows).toEqual([
      {
        market: "AU",
        d: "2026-03-27",
        code: "ZZA",
        angleId: "A-D3-09",
        value: null,
        flag: null,
        angleVersion: 1,
        manifestId: "m",
      },
    ]);
    const bucket = probeRowsOf(
      "AU",
      "d",
      new Map([["ZZA", new Map([["x", { bucket: "b" }]])]]),
      "m",
    );
    expect(bucket[0]!.flag).toBe("b");
  });
});

describe("admitted: a promoted measure is scored by its own rule only", () => {
  const listed = ["A-D1-01", "A-D1-02", "A-D2-01", "A-D3-01"];
  const set = [
    { id: "A-D1-01", version: 1, cluster: "momentum" as const },
    { id: "A-D1-02", version: 1, cluster: "low_volatility" as const },
    { id: "A-D2-01", version: 1, cluster: "liquidity" as const },
    { id: "A-D3-01", version: 2, cluster: "momentum" as const },
  ];
  const run = (admitted: readonly string[] | undefined): NightOutput => {
    const rule: FamilyNightRule = ruleFor("F1", {
      ruleVersion: "F1.zz.1+b2",
      angles: listed,
      ...(admitted === undefined ? {} : { admitted }),
    });
    const map: CortexMap = {
      ...mapFor("F1"),
      ruleVersion: "F1.zz.1+b2",
      activeSetHash: activeSetHash(set),
    };
    const base = nightInputs(T, { angles: ANGLES });
    return runNight({
      ...base,
      rules: new Map<Family, FamilyNightRule>([...base.rules, ["F1", rule]]),
      maps: new Map<Family, CortexMap>([...base.maps, ["F1", map]]),
    });
  };
  const ruleMissing = (out: NightOutput): number =>
    out.blocked.filter(
      (b) =>
        b.family === "F1" &&
        b.trace.some((x) => x.gateId === "G04_economic" && x.value === "rule_missing"),
    ).length;

  it("without the admission the rule's set is invalid (the measure is a candidate); with it the rule scores", () => {
    const off = run(undefined);
    const on = run(["A-D3-01"]);
    expect(ruleMissing(off)).toBeGreaterThan(0);
    expect(ruleMissing(on)).toBe(0);
    // the shared features and the night's hash are untouched either way
    expect(on.activeSetHash).toBe(off.activeSetHash);
    expect(
      nightOutputJson({
        ...on,
        decisions: [],
        queued: [],
        shadow: [],
        blocked: [],
        abstains: [],
        sectorTilt: [],
      }),
    ).toBe(
      nightOutputJson({
        ...off,
        decisions: [],
        queued: [],
        shadow: [],
        blocked: [],
        abstains: [],
        sectorTilt: [],
      }),
    );
  });

  it("ruleFromMap reads `admitted` only beside an own angle list", () => {
    const row = (params: Record<string, unknown>): MapRow => ({
      market: "AU",
      family: "F1",
      ruleVersion: "F1.zz.1+b2",
      fittedAt: "2026-03-27T20:00:00.000Z",
      params: {
        a: 0,
        b: 0,
        s_mean: 0,
        s_sd: 1,
        K: 1,
        clusters: ["momentum"],
        ...params,
      } as unknown as MapRow["params"],
      activeSetHash: "h",
      nEff: 0,
      pool: "system",
      fitSplit: "base_change",
    });
    expect(ruleFromMap("F1", row({ angles: ["A-D3-01"], admitted: ["A-D3-01"] })).admitted).toEqual(
      ["A-D3-01"],
    );
    expect(ruleFromMap("F1", row({ admitted: ["A-D3-01"] })).admitted).toBeUndefined();
    expect(ruleFromMap("F1", row({ angles: ["A-D3-01"], admitted: [] })).admitted).toBeUndefined();
    expect(ruleFromMap("F1", row({ angles: ["A-D3-01"], admitted: [3] })).admitted).toBeUndefined();
  });
});
