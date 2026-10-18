// @vitest-environment node
// T11 control path library: deciles within tier (decision 33), pool exclusions, 20 controls per row,
// draws with replacement when the pool is short (pool size recorded), seeded determinism, shared
// memo, exact control returns and the exit mapping (M3 mapControlExits) onto a control.
import { describe, expect, it } from "vitest";
import type { CsRule, ExitPlan, Tier } from "@/lib/agents/families";
import { defaultAgentParams } from "@/lib/agents/params";
import { makeRational } from "@/lib/money/rational";
import {
  createControlLibrary,
  mapPlanForControl,
  tierDeciles,
  type ControlRequest,
  type ControlSource,
  type PoolCode,
} from "@/lib/replay/controlLibrary";
import { costSetupFrom } from "@/lib/replay/returns";
import { sessionList, viewBar } from "../fixtures/replay/ledgerWorld";

const p = defaultAgentParams();
const cost = costSetupFrom(p);
const M = 1_000_000n;
const S = sessionList("2026-03-13", 12);
const code = (i: number) => `ZZ${String(i).padStart(3, "0")}`;

function pool(n: number, over: (i: number) => Partial<PoolCode> = () => ({})): PoolCode[] {
  return Array.from({ length: n }, (_, i) => ({
    code: code(i),
    tier: "U1" as Tier,
    vol20: i,
    atrMicro: 100_000n,
    advMicro: 10_000_000n * M,
    eligible: true,
    ...over(i),
  }));
}

/** Flat A$50 bars (open = low = high = close) for every code; the universe is the given pool. */
function source(
  universe: readonly PoolCode[],
  missing: ReadonlySet<string> = new Set(),
): ControlSource {
  return {
    sessions: S,
    bar: (c, d) => (missing.has(c) ? null : viewBar(d, 50n * M, 50n * M, 50n * M, 50n * M)),
    positionFacts: () => ({
      atrMicro: null,
      closeAboveExitSma: null,
      volumeRatios: [],
      events: [],
    }),
    controlUniverse: () => universe,
  };
}

const timeStop = (n: number): CsRule => ({
  id: "time_stop",
  via: null,
  kind: "time_stop",
  sessions: n,
  minReturn: null,
});
const f1Plan: ExitPlan = {
  initialStops: [
    {
      id: "initial",
      via: null,
      spec: { atr_micro: 1_000n, k: makeRational(2n), cap: null, level_micro: null },
    },
  ],
  trails: [],
  cs: [timeStop(3)],
};

const req = (over: Partial<ControlRequest> = {}): ControlRequest => ({
  rowId: "lr:AU:F1:F1.v1:F1:ZZ005:2026-03-16",
  lineage: "AU:F1",
  family: "F1",
  signalCode: code(5),
  tier: "U1",
  decisionIdx: 0,
  entryIdx: 1,
  endIdx: 11,
  plan: f1Plan,
  anchors: [],
  excludeCodes: new Set([code(5)]),
  count: 20,
  ...over,
});

describe("deciles within tier", () => {
  it("ranks eligible codes by vol20 then code; ineligible, unknown and other tiers are ignored", () => {
    const u = [
      ...pool(20),
      ...pool(3, (i) => ({ code: `ZZX${i}`, tier: "U2" as Tier, vol20: i })),
      { ...pool(1)[0]!, code: "ZZNOVOL", vol20: null },
      { ...pool(1)[0]!, code: "ZZINEL", vol20: 5, eligible: false },
    ];
    const d = tierDeciles(u, "U1");
    expect(d.size).toBe(20);
    expect(d.get(code(0))).toBe(0);
    expect(d.get(code(1))).toBe(0);
    expect(d.get(code(2))).toBe(1);
    expect(d.get(code(19))).toBe(9);
    expect(d.has("ZZNOVOL")).toBe(false);
    expect(d.has("ZZINEL")).toBe(false);
    expect([...tierDeciles(u, "U2").values()]).toEqual([0, 3, 6]);
  });
});

describe("drawing controls", () => {
  const universe = pool(210); // 21 codes per decile
  const lib = () => createControlLibrary(source(universe), cost, 1n);

  it("draws 20 distinct controls from the signal's tier and decile, never the signal itself", () => {
    const d = lib().draw(req());
    expect(d.decile).toBe(0);
    expect(d.poolSize).toBe(20);
    expect(d.usableSize).toBe(20);
    expect(d.withReplacement).toBe(false);
    expect(d.controls.map((c) => c.idx)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    const codes = d.controls.map((c) => c.code);
    expect(new Set(codes).size).toBe(20);
    expect(codes).not.toContain(code(5));
    expect(codes.every((c) => c <= code(20))).toBe(true); // decile 0 = codes 0..20
  });

  it("excludes same-day signals, and draws with replacement when fewer than 20 remain", () => {
    const d = lib().draw(req({ excludeCodes: new Set([code(5), code(7)]) }));
    expect(d.poolSize).toBe(19);
    expect(d.usableSize).toBe(19);
    expect(d.withReplacement).toBe(true);
    expect(d.controls).toHaveLength(20);
    expect(new Set(d.controls.map((c) => c.code)).size).toBe(19);
    expect(d.controls.map((c) => c.code)).not.toContain(code(7));
  });

  it("skips codes that cannot be entered (no bar) and records the usable size", () => {
    const l = createControlLibrary(
      source(universe, new Set([code(0), code(1), code(2)])),
      cost,
      1n,
    );
    const d = l.draw(req());
    expect(d.poolSize).toBe(20);
    expect(d.usableSize).toBe(17);
    expect(d.withReplacement).toBe(true);
    expect(d.controls.map((c) => c.code)).not.toContain(code(1));
  });

  it("records an empty draw with a reason instead of inventing controls", () => {
    expect(lib().draw(req({ signalCode: "ZZNONE" }))).toMatchObject({
      controls: [],
      note: "signal_not_in_universe",
    });
    const tiny = createControlLibrary(source(pool(1)), cost, 1n);
    expect(tiny.draw(req({ signalCode: code(0), excludeCodes: new Set([code(0)]) }))).toMatchObject(
      {
        controls: [],
        poolSize: 0,
        note: "empty_pool",
      },
    );
  });

  it("control returns are exact and computed like a row's (P5 net, P3 + 50 % stress)", () => {
    const d = lib().draw(req());
    for (const c of d.controls) {
      expect(c).toMatchObject({
        row_id: req().rowId,
        entry_d: S[1],
        exit_d: S[4],
        net_num: -11_100_000n,
        net_den: 555_550_000n,
        stress_num: -14_760_000n,
        stress_den: 557_380_000n,
      });
    }
    expect(d.forcedIdx).toEqual([]);
  });

  it("flags controls whose exit was forced at the end of the data", () => {
    const d = lib().draw(req({ endIdx: 3 })); // the 3-session time stop would fire after the data ends
    expect(d.forcedIdx).toHaveLength(20);
    expect(d.controls[0]!.exit_d).toBe(S[3]);
  });

  it("is deterministic: same seed and scope, any universe order; the seed changes the draw", () => {
    const big = pool(400); // 40 per decile: 20 of 39 drawn
    const a = createControlLibrary(source(big), cost, 7n).draw(req());
    const b = createControlLibrary(source([...big].reverse()), cost, 7n).draw(req());
    expect(b).toEqual(a);
    const c = createControlLibrary(source(big), cost, 8n).draw(req());
    expect(c.controls.map((x) => x.code)).not.toEqual(a.controls.map((x) => x.code));
    const e = createControlLibrary(source(big), cost, 7n).draw(
      req({ rowId: "lr:AU:F1:F1.v1:F1:ZZ005:2026-03-17" }),
    );
    expect(e.controls.map((x) => x.code)).not.toEqual(a.controls.map((x) => x.code));
    expect(a.poolSize).toBe(39);
    expect(a.withReplacement).toBe(false);
  });

  it("shares control paths between rows through the memo", () => {
    const l = lib();
    l.draw(req());
    expect(l.memoSize()).toBe(20);
    l.draw(req({ rowId: "lr:other", signalCode: code(6), excludeCodes: new Set([code(6)]) }));
    expect(l.memoSize()).toBe(21); // only code 5 was new
  });
});

describe("controls see corporate actions like rows", () => {
  it("a dividend inside the control hold is credited (qty x dps)", () => {
    const withDividend: ControlSource = {
      ...source(pool(210)),
      corpActions: () => [
        {
          id: "d1",
          code: "X",
          type: "cash_dividend",
          exDate: S[2]!,
          payload: { dps: "0.10", pay_date: S[5]! },
        },
      ],
    };
    const d = createControlLibrary(withDividend, cost, 1n).draw(req());
    expect(d.controls[0]!.net_num).toBe(-11_100_000n + 1_100_000n);
    expect(d.controls[0]!.stress_num).toBe(-14_760_000n + 1_100_000n);
  });
});

describe("mapping a plan onto a control (ARN-004, M3 mapControlExits)", () => {
  it("F1: the ATR multiple is kept on the control's own ATR; contributor rules are dropped", () => {
    const plan: ExitPlan = {
      ...f1Plan,
      initialStops: [
        ...f1Plan.initialStops,
        {
          id: "F4:initial",
          via: "F4",
          spec: { atr_micro: 9n, k: makeRational(2n), cap: null, level_micro: null },
        },
      ],
    };
    const m = mapPlanForControl({
      family: "F1",
      plan,
      entryOpenMicro: 20n * M,
      atrMicro: 400_000n,
      anchors: [],
    })!;
    expect(m.initialStops).toHaveLength(1);
    expect(m.initialStops[0]!.spec).toEqual({
      atr_micro: 400_000n,
      k: makeRational(2n),
      cap: null,
      level_micro: null,
    });
    expect(m.cs).toEqual(f1Plan.cs);
  });

  it("F3: the event-day-low stop keeps its distance in ATR units from the control's own open", () => {
    const f3: ExitPlan = {
      initialStops: [
        {
          id: "initial",
          via: null,
          spec: { atr_micro: null, k: null, cap: null, level_micro: 48_500_000n },
        },
      ],
      trails: [],
      cs: [timeStop(20)],
    };
    // signal: open 50.00, event low 48.50, ATR 1.00 -> 1.5 ATR; control: open 20.00, ATR 0.40
    const m = mapPlanForControl({
      family: "F3",
      plan: f3,
      entryOpenMicro: 20n * M,
      atrMicro: 400_000n,
      anchors: [{ ruleId: "F3.is_event_low", distanceMicro: 1_500_000n, atrMicro: 1n * M }],
    })!;
    expect(m.initialStops[0]!.spec.level_micro).toBe(20n * M - 600_000n);
  });

  it("F2: close-below-event-low is re-anchored; the polarity-event exit becomes the time stop", () => {
    const f2: ExitPlan = {
      initialStops: f1Plan.initialStops,
      trails: [],
      cs: [
        { id: "guidance_down", via: null, kind: "negative_event", categories: ["guidance_down"] },
        { id: "below_event_low", via: null, kind: "close_below_level", levelMicro: 48_500_000n },
        timeStop(60),
      ],
    };
    const m = mapPlanForControl({
      family: "F2",
      plan: f2,
      entryOpenMicro: 20n * M,
      atrMicro: 400_000n,
      anchors: [{ ruleId: "F2.cs_event_low", distanceMicro: 1_500_000n, atrMicro: 1n * M }],
    })!;
    expect(m.cs.map((r) => r.id)).toEqual(["below_event_low", "time_stop"]);
    expect(m.cs[0]).toMatchObject({ kind: "close_below_level", levelMicro: 20n * M - 600_000n });
  });

  it("returns null when the mapped stop would not stay above zero", () => {
    const f3: ExitPlan = {
      initialStops: [
        {
          id: "initial",
          via: null,
          spec: { atr_micro: null, k: null, cap: null, level_micro: 1n },
        },
      ],
      trails: [],
      cs: [timeStop(20)],
    };
    expect(
      mapPlanForControl({
        family: "F3",
        plan: f3,
        entryOpenMicro: 1n * M,
        atrMicro: 400_000n,
        anchors: [{ ruleId: "F3.is_event_low", distanceMicro: 100n * M, atrMicro: 1n * M }],
      }),
    ).toBeNull();
  });
});
