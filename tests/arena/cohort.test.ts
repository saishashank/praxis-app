// @vitest-environment node
// Execution registry, cohort start, restart groups, seeded PRNG, effective-N fields, C2 exit mapping
// and the C1 / C3 shells (M3 T9; spec 05 ARN-001..004, ARN-053; AT-11; D-076).
import { describe, expect, it } from "vitest";
import {
  atrMultiple,
  buildExecutionRegistry,
  c1EtfStatus,
  C1_ETF_PLACEHOLDER,
  canonicalJson,
  carriesSleeve,
  cohortIdFor,
  cohortSlots,
  controlStopMicro,
  createPrng,
  deriveRngSeed,
  effectiveN,
  effectiveNByExecution,
  FAMILIES,
  FAMILY_EXIT_RULES,
  FAMILY_TIME_STOP_SESSIONS,
  mapControlExits,
  paramsJson,
  parseAtrMultiple,
  parseCohortParams,
  planCohortStart,
  planGroupRestart,
  planInitialStart,
  resolveCohortParams,
  sha256Hex,
  splitmix64,
  type EffectiveNCohort,
  type SlotCohort,
} from "@/lib/arena/cohort";
import { assertTxn, txnRows } from "@/lib/arena/ledger";
import { CONFIG_KEYS } from "@/lib/config/keys";
import { makeRational } from "@/lib/money/rational";

const MASTER = 20_261_011n;
const registry = buildExecutionRegistry();
const byId = new Map(registry.map((e) => [e.id, e]));
const executionFor = (id: string) => {
  const e = byId.get(id);
  if (e === undefined) throw new Error(`no execution ${id}`);
  return e;
};
const paramsFor = () => resolveCohortParams();

describe("execution registry (ARN-001, ARN-002, ARN-004)", () => {
  it("12 E executions: E01/E02 F1 ... E11/E12 F6, odd = U, even = L, twins share a restart group", () => {
    const e = registry.filter((r) => r.kind === "E");
    expect(e).toHaveLength(12);
    e.forEach((row, i) => {
      expect(row.id).toBe(`E${String(i + 1).padStart(2, "0")}`);
      expect(row.family).toBe(`F${Math.floor(i / 2) + 1}`);
      expect(row.variant).toBe(i % 2 === 0 ? "U" : "L");
      expect(row.twin_group).toBe(`TW-F${Math.floor(i / 2) + 1}`);
      expect(row.market).toBe("AU");
      expect(row.cost_profile).toBe("P5");
      expect(row.status).toBe("active");
    });
    expect(carriesSleeve(e[0])).toBe(false);
    expect(carriesSleeve(e[1])).toBe(true);
  });

  it("C1, C2-F1..F6 (no sleeve) and C3-F1..F6 (sleeve): 25 rows, C2/C3 in their family's group", () => {
    expect(registry).toHaveLength(25);
    expect(registry.find((r) => r.id === "C1")).toMatchObject({
      kind: "C1",
      family: null,
      twin_group: "TW-C1",
    });
    for (const f of FAMILIES) {
      const c2 = executionFor(`C2-${f}`);
      const c3 = executionFor(`C3-${f}`);
      expect(c2).toMatchObject({ kind: "C2", family: f, twin_group: `TW-${f}` });
      expect(c3).toMatchObject({ kind: "C3", family: f, twin_group: `TW-${f}` });
      expect(carriesSleeve(c2)).toBe(false);
      expect(carriesSleeve(c3)).toBe(true);
    }
    expect(new Set(registry.map((r) => r.id)).size).toBe(25);
  });

  it("is deterministic and honours its options", () => {
    expect(JSON.stringify(buildExecutionRegistry())).toBe(JSON.stringify(registry));
    const other = buildExecutionRegistry({ market: "AU", ruleVersion: "v2", costProfile: "P3" });
    expect(other.every((r) => r.rule_version === "v2" && r.cost_profile === "P3")).toBe(true);
  });

  it("slots: one per E and C1, 20 per C2 and C3 execution = 253", () => {
    const slots = cohortSlots(registry);
    expect(slots).toHaveLength(12 + 1 + 6 * 20 + 6 * 20);
    expect(slots.filter((s) => s.executionId === "C2-F3").map((s) => s.controlIdx)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    expect(slots.find((s) => s.executionId === "E05")?.controlIdx).toBeNull();
    expect(cohortSlots(registry, 3)).toHaveLength(13 + 36);
    expect(() => cohortSlots(registry, 0)).toThrow(/positive/);
  });

  it("cohort ids are stable text", () => {
    expect(cohortIdFor("E01", null, "2026-10-14")).toBe("E01@2026-10-14");
    expect(cohortIdFor("C2-F3", 7, "2026-10-14")).toBe("C2-F3#07@2026-10-14");
  });
});

describe("resolved parameters (params_json = copy + hash, ARN-102)", () => {
  it("defaults: A$600 seed, 2x target, 50 % bust, floor 510,606,061, 5 / 20 / 252, P5, matched", () => {
    const p = resolveCohortParams();
    expect(p).toMatchObject({
      market: "AU",
      seedMicro: 600_000_000n,
      costProfile: "P5",
      settlementMode: "matched",
      minParcelMicro: 500_000_000n,
      maxOpenPositions: 2,
      c1EtfCode: C1_ETF_PLACEHOLDER,
    });
    expect(p.terminal).toMatchObject({
      stallFloorMicro: 510_606_061n,
      stallSessions: 5,
      stallParcelRejections: 20,
      timeoutSessions: 252,
    });
  });

  it("round-trips through JSON, carries a SHA-256 of the canonical params and rejects tampering", () => {
    const p = resolveCohortParams({
      terminal: { stallSessions: 7 },
      cashBuffer: makeRational(2n, 100n),
    });
    const text = paramsJson(p);
    const parsed = JSON.parse(text) as { hash: string; params: unknown };
    expect(parsed.hash).toBe(sha256Hex(canonicalJson(parsed.params)));
    expect(parsed.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(parseCohortParams(text)).toEqual(p);
    expect(paramsJson(p)).toBe(text);
    expect(() =>
      parseCohortParams(text.replace('"stall_sessions":7', '"stall_sessions":6')),
    ).toThrow(/hash/);
    expect(paramsJson(resolveCohortParams({ terminal: { stallSessions: 6 } }))).not.toBe(text);
  });

  it("canonical JSON sorts keys and is stable", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,{"x":2,"y":1}]},"b":1}',
    );
  });

  it("the stall sessions come from the injected values, a bad one is refused", () => {
    expect(resolveCohortParams({ terminal: { stallSessions: 3 } }).terminal.stallSessions).toBe(3);
    expect(() => resolveCohortParams({ terminal: { timeoutSessions: 0 } })).toThrow(
      /timeout_sessions/,
    );
  });
});

describe("seeded integer PRNG (no Math.random, no clock)", () => {
  it("SplitMix64 reproduces the published first outputs for seed 0", () => {
    let state = 0n;
    const out: bigint[] = [];
    for (let i = 0; i < 3; i++) {
      const step = splitmix64(state);
      state = step.state;
      out.push(step.value);
    }
    expect(out.map((v) => v.toString(16))).toEqual([
      "e220a8397b1dcdaf",
      "6e789e6aa1b965f4",
      "6c45d188009454f",
    ]);
  });

  it("is deterministic per seed, differs between seeds, and stays in range without bias gaps", () => {
    const a = createPrng(42n);
    const b = createPrng(42n);
    const c = createPrng(43n);
    const xs = Array.from({ length: 50 }, () => a.below(1000n));
    expect(xs).toEqual(Array.from({ length: 50 }, () => b.below(1000n)));
    expect(xs).not.toEqual(Array.from({ length: 50 }, () => c.below(1000n)));
    expect(xs.every((x) => x >= 0n && x < 1000n)).toBe(true);
    expect(new Set(xs).size).toBeGreaterThan(40);
    expect(() => a.below(0n)).toThrow(/positive/);
    const small = createPrng(7n);
    const seen = new Set(Array.from({ length: 200 }, () => small.below(3n)));
    expect([...seen].sort()).toEqual([0n, 1n, 2n]);
  });

  it("cohort rng seeds derive from the master seed and the id: stable, distinct, positive, 62 bits", () => {
    const ids = cohortSlots(registry).map((s) =>
      cohortIdFor(s.executionId, s.controlIdx, "2026-10-14"),
    );
    const seeds = ids.map((id) => deriveRngSeed(MASTER, id));
    expect(seeds.map((s) => s.toString())).toEqual(
      ids.map((id) => deriveRngSeed(MASTER, id).toString()),
    );
    expect(new Set(seeds).size).toBe(ids.length);
    expect(seeds.every((s) => s > 0n && s < 1n << 62n)).toBe(true);
    expect(deriveRngSeed(MASTER + 1n, ids[0])).not.toBe(seeds[0]);
  });
});

describe("cohort start (AT-11: every execution and control starts with A$600)", () => {
  const starts = planInitialStart({
    registry,
    startD: "2026-10-14",
    paramsFor,
    masterSeed: MASTER,
  });

  it("253 cohorts, all A$600, one session, unique ids, live, no restart_of", () => {
    expect(starts).toHaveLength(253);
    expect(new Set(starts.map((s) => s.id)).size).toBe(253);
    expect(starts.every((s) => s.seedMicro === 600_000_000n && s.startD === "2026-10-14")).toBe(
      true,
    );
    expect(starts.every((s) => s.restartOf === null && s.dataSnapshotId === null)).toBe(true);
    expect(starts.every((s) => s.costProfileVersion === 1)).toBe(true);
  });

  it("each seed transaction is balanced: A$600 into settled cash against equity, dated at the start", () => {
    for (const s of starts) {
      assertTxn(s.seedTxn);
      expect(s.seedTxn.d).toBe("2026-10-14");
      expect(txnRows(s.seedTxn).map((r) => [r.account, r.deltaMicro])).toEqual([
        ["cash_settled", 600_000_000n],
        ["equity", -600_000_000n],
      ]);
    }
  });

  it("only the L twins and the C3 controls carry sleeve settings", () => {
    for (const s of starts) {
      const execution = executionFor(s.executionId);
      expect(s.sleeveJson !== null).toBe(carriesSleeve(execution));
    }
    const l = starts.find((s) => s.executionId === "E02")?.sleeveJson ?? "";
    expect(JSON.parse(l)).toMatchObject({
      leverage: "10",
      margin_cap_micro: "20000000",
      margin_nav_fraction: "1/25",
      closeout_fraction: "1/2",
      financing_rate: "9/100",
      financing_basis: "365",
      recovery_mode: "REC-2",
      profile: "P5",
    });
  });

  it("is byte-identical on a second call (replay)", () => {
    const again = planInitialStart({
      registry,
      startD: "2026-10-14",
      paramsFor,
      masterSeed: MASTER,
    });
    const ser = (xs: typeof starts) =>
      JSON.stringify(xs, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
    expect(ser(again)).toBe(ser(starts));
  });

  it("twin cohorts of one group carry the same twin_group; controls need an index, E rows must not have one", () => {
    expect(starts.find((s) => s.id === "E01@2026-10-14")?.twinGroup).toBe("TW-F1");
    expect(starts.find((s) => s.id === "C3-F1#20@2026-10-14")?.twinGroup).toBe("TW-F1");
    expect(starts.find((s) => s.id === "C1@2026-10-14")?.twinGroup).toBe("TW-C1");
    const params = resolveCohortParams();
    expect(() =>
      planCohortStart({
        execution: executionFor("E01"),
        controlIdx: 1,
        startD: "2026-10-14",
        params,
        masterSeed: MASTER,
      }),
    ).toThrow(/control index/);
    expect(() =>
      planCohortStart({
        execution: executionFor("C2-F1"),
        controlIdx: null,
        startD: "2026-10-14",
        params,
        masterSeed: MASTER,
      }),
    ).toThrow(/control index/);
  });
});

describe("C1 and C3 shells (no family entry selection - M4)", () => {
  it("C1 uses a config key whose default is a placeholder, flagged [VERIFY], not a ticker", () => {
    expect(CONFIG_KEYS.c1_etf_code.default).toBe(C1_ETF_PLACEHOLDER);
    expect(CONFIG_KEYS.c1_etf_code.editable).toBe("O");
    const unset = c1EtfStatus(C1_ETF_PLACEHOLDER);
    expect(unset.verified).toBe(false);
    expect(unset.flag).toContain("[VERIFY]");
    const set = c1EtfStatus("ZZETF");
    expect(set.verified).toBe(true);
    expect(set.flag).toContain("[VERIFY]");
  });

  it("the config validator accepts a code and refuses junk", async () => {
    const check = (v: unknown) => CONFIG_KEYS.c1_etf_code.validate(v);
    expect(await check("ZZETF")).toBeNull();
    expect(await check("UNSET-C1-ETF")).toBeNull();
    for (const bad of ["", "lower", "TOO-LONG-CODE-X", 5, null])
      expect(await check(bad)).not.toBeNull();
  });

  it("the C1 cohort carries the ETF code in its stored parameters and no sleeve", () => {
    const start = planCohortStart({
      execution: executionFor("C1"),
      controlIdx: null,
      startD: "2026-10-14",
      params: resolveCohortParams({ c1EtfCode: "ZZETF" }),
      masterSeed: MASTER,
    });
    expect(parseCohortParams(start.paramsJson).c1EtfCode).toBe("ZZETF");
    expect(start.sleeveJson).toBeNull();
    expect(start.kind).toBe("C1");
  });
});

describe("group restart plan (ARN-053)", () => {
  const calendar = [{ d: "2026-10-16", kind: "holiday" as const, close_time: null }];
  const live = (over: Record<string, Partial<SlotCohort>> = {}, group = "TW-F1"): SlotCohort[] =>
    cohortSlots(registry, 2)
      .filter((s) => executionFor(s.executionId).twin_group === group)
      .map((s) => {
        const id = cohortIdFor(s.executionId, s.controlIdx, "2026-10-01");
        return {
          id,
          executionId: s.executionId,
          controlIdx: s.controlIdx,
          startD: "2026-10-01",
          terminalKind: null,
          liqNavMicro: 640_000_000n,
          ...over[id],
        };
      });

  const plan = (cohorts: SlotCohort[], trigger: string, closeD = "2026-10-14") =>
    planGroupRestart({
      group: "TW-F1",
      triggerCohortId: trigger,
      closeD,
      calendar,
      live: cohorts,
      executionFor,
      paramsFor,
      masterSeed: MASTER,
    });

  it("trigger resolves at D: liquidation D+1, every cohort of the group restarts together at D+2", () => {
    const cohorts = live({
      "E01@2026-10-01": { terminalKind: "target", liqNavMicro: 1_210_000_000n },
    });
    const p = plan(cohorts, "E01@2026-10-01");
    expect(p.liquidationD).toBe("2026-10-15");
    expect(p.restartD).toBe("2026-10-19"); // 16th is a holiday, 17th/18th weekend
    // E01, E02, C2-F1 x2, C3-F1 x2 = 6 slots
    expect(p.starts).toHaveLength(6);
    expect(new Set(p.starts.map((s) => s.startD))).toEqual(new Set(["2026-10-19"]));
    expect(p.starts.every((s) => s.restartOf !== null && s.seedMicro === 600_000_000n)).toBe(true);
    expect(p.starts.map((s) => s.restartOf).sort()).toEqual(cohorts.map((c) => c.id).sort());
    expect(p.ended.map((e) => e.cohortId)).toEqual(["E01@2026-10-01"]);
    // unfinished twin and controls continue in shadow, each remembering the liquidation estimate
    expect(p.shadow.map((s) => s.cohortId).sort()).toEqual(
      cohorts
        .filter((c) => c.id !== "E01@2026-10-01")
        .map((c) => c.id)
        .sort(),
    );
    expect(p.shadow.every((s) => s.liveLiquidationNavMicro === 640_000_000n)).toBe(true);
    expect(p.shadow.find((x) => x.cohortId === "E02@2026-10-01")?.newCohortId).toBe(
      "E02@2026-10-19",
    );
  });

  it("two cohorts resolving on the same close are both 'ended'; nobody is flipped to shadow", () => {
    const p = plan(
      live({
        "E01@2026-10-01": { terminalKind: "target" },
        "E02@2026-10-01": { terminalKind: "bust" },
      }),
      "E01@2026-10-01",
    );
    expect(p.ended.map((e) => e.cohortId)).toEqual(["E01@2026-10-01", "E02@2026-10-01"]);
    expect(p.shadow).toHaveLength(4);
  });

  it("is deterministic, whatever order the live cohorts arrive in", () => {
    const cohorts = live({ "E02@2026-10-01": { terminalKind: "stalled" } });
    const a = plan(cohorts, "E02@2026-10-01");
    const b = plan([...cohorts].reverse(), "E02@2026-10-01");
    expect(b.starts.map((s) => s.id)).toEqual(a.starts.map((s) => s.id));
    expect(b.starts.map((s) => s.rngSeed)).toEqual(a.starts.map((s) => s.rngSeed));
  });

  it("refuses an unresolved trigger, a foreign trigger, a duplicate slot and a cohort of another group", () => {
    const cohorts = live({ "E01@2026-10-01": { terminalKind: "target" } });
    expect(() => plan(live(), "E01@2026-10-01")).toThrow(/no terminal state/);
    expect(() => plan(cohorts, "ZZ@2026-10-01")).toThrow(/not a live cohort/);
    expect(() => plan([...cohorts, { ...cohorts[0], id: "dup" }], "E01@2026-10-01")).toThrow(
      /two live cohorts/,
    );
    expect(() => plan([...cohorts, ...live({}, "TW-F2")], "E01@2026-10-01")).toThrow(
      /not in group/,
    );
  });
});

describe("effective N (ARN-053): the stored fields are enough", () => {
  const c = (
    id: string,
    startD: string,
    terminalD: string | null,
    kind: EffectiveNCohort["terminalKind"],
    executionId = "E01",
  ): EffectiveNCohort => ({
    id,
    executionId,
    startD,
    terminalD,
    terminalKind: kind,
  });

  it("counts resolved, non-overlapping cohorts greedily in start order", () => {
    const cohorts = [
      c("a", "2026-01-05", "2026-02-10", "target"),
      c("b", "2026-02-12", "2026-03-20", "bust"), // starts after a ended: counted
      c("c", "2026-03-01", "2026-04-01", "timeout"), // overlaps b: not counted
      c("d", "2026-03-23", null, null), // censored: never counted
      c("e", "2026-03-23", "2026-05-01", "stalled"), // starts after b ended
      c("f", "2026-05-01", "2026-06-01", "target"), // starts ON e's terminal close: overlaps
    ];
    const r = effectiveN([...cohorts].reverse());
    expect(r.counted).toEqual(["a", "b", "e"]);
    expect(r.n).toBe(3);
  });

  it("a live cohort overlapping its own twin's shadow cohort does not count; ties break by id", () => {
    // E02's shadow cohort (start 01-05, ends 03-01) and its live successor (start 01-21)
    const e02 = [
      c("shadow", "2026-01-05", "2026-03-01", "stalled", "E02"),
      c("live2", "2026-01-21", "2026-02-20", "target", "E02"),
      c("live3", "2026-03-03", "2026-04-01", "bust", "E02"),
    ];
    expect(effectiveN(e02).counted).toEqual(["shadow", "live3"]);
    expect(
      effectiveN([
        c("b", "2026-01-05", "2026-01-30", "target"),
        c("a", "2026-01-05", "2026-01-30", "bust"),
      ]).counted,
    ).toEqual(["a"]);
    expect(effectiveN([]).n).toBe(0);
  });

  it("is reported per execution", () => {
    const all = [
      c("a", "2026-01-05", "2026-02-10", "target", "E01"),
      c("b", "2026-01-05", "2026-02-10", "target", "E02"),
      c("c", "2026-02-11", "2026-03-10", "bust", "E01"),
    ];
    const m = effectiveNByExecution(all);
    expect([...m.keys()]).toEqual(["E01", "E02"]);
    expect(m.get("E01")?.n).toBe(2);
    expect(m.get("E02")?.n).toBe(1);
  });
});

describe("C2 exit mapping in ATR units (ARN-004, TST-101)", () => {
  it("F3 event low 1.3 ATR below the open: control stop 1.3 ATR below its own entry-day open (TST101-042)", () => {
    const multiple = parseAtrMultiple("1.3");
    expect(
      controlStopMicro({ entryDayOpenMicro: 10_000_000n, atr20Micro: 400_000n, multiple }),
    ).toEqual({
      offsetMicro: 520_000n,
      stopMicro: 9_480_000n,
    });
    expect(atrMultiple(520_000n, 400_000n)).toEqual(multiple);
  });

  it("the multiple is exact, the offset is rounded once (half away), and the stop stays positive", () => {
    // 1/3 ATR of 1,000,001 micro = 333,333.67 -> 333,334
    const m = atrMultiple(100n, 300n);
    expect(
      controlStopMicro({ entryDayOpenMicro: 5_000_000n, atr20Micro: 1_000_001n, multiple: m })
        .offsetMicro,
    ).toBe(333_334n);
    expect(() =>
      controlStopMicro({
        entryDayOpenMicro: 1_000_000n,
        atr20Micro: 400_000n,
        multiple: parseAtrMultiple("2.5"),
      }),
    ).toThrow(/above zero/);
    expect(() => atrMultiple(1n, 0n)).toThrow(/ATR/);
  });

  it("F2, F3, F6 tables: event-anchored levels move to ATR units, unmappable exits become the time stop, the rest is unchanged", () => {
    const atrControl = 250_000n;
    const open = 12_000_000n;
    const f3 = mapControlExits({
      family: "F3",
      entryDayOpenMicro: open,
      atr20Micro: atrControl,
      events: { "F3.is_event_low": { distanceMicro: 780_000n, atrMicro: 600_000n } }, // 1.3 ATR
    });
    expect(f3.map((x) => x.kind)).toEqual(["atr_level", "unchanged", "unchanged"]);
    expect(f3[0]).toMatchObject({
      ruleId: "F3.is_event_low",
      trigger: "intraday",
      levelMicro: 11_675_000n,
    });

    const f2 = mapControlExits({
      family: "F2",
      entryDayOpenMicro: open,
      atr20Micro: atrControl,
      events: { "F2.cs_event_low": { distanceMicro: 500_000n, atrMicro: 250_000n } }, // 2.0 ATR
    });
    expect(f2.map((x) => x.kind)).toEqual(["unchanged", "time_stop", "atr_level", "unchanged"]);
    expect(f2[1]).toMatchObject({
      ruleId: "F2.cs_guidance",
      sessions: FAMILY_TIME_STOP_SESSIONS.F2,
    });
    expect(f2[2]).toMatchObject({ trigger: "close", levelMicro: 11_500_000n });

    const f6 = mapControlExits({
      family: "F6",
      entryDayOpenMicro: open,
      atr20Micro: atrControl,
      events: {},
    });
    expect(f6.map((x) => x.kind)).toEqual(["unchanged", "unchanged", "time_stop"]);
    expect(f6[2]).toMatchObject({ ruleId: "F6.cs_earliest", sessions: 20 });
  });

  it("an event-anchored rule without an event distance is refused; every family has a rule table and a time stop", () => {
    expect(() =>
      mapControlExits({ family: "F3", entryDayOpenMicro: 1_000_000n, atr20Micro: 1n, events: {} }),
    ).toThrow(/no event distance/);
    for (const f of FAMILIES) {
      expect(FAMILY_EXIT_RULES[f].length).toBeGreaterThan(1);
      expect(FAMILY_TIME_STOP_SESSIONS[f]).toBeGreaterThan(0);
      expect(FAMILY_EXIT_RULES[f].some((r) => r.kind === "time")).toBe(true);
    }
  });
});
