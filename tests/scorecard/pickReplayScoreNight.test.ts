// @vitest-environment node
// D-1062…D-1066 (Owner O-84): the scoring side of the night-by-night replay (scoreNight) on a stub
// world: sectors and their members, halted and illiquid codes, missing or zero bars, the index move,
// the volume against the usual, and a night with no scorable mover. Invented ZZ numbers.
import { describe, expect, it } from "vitest";
import type { ViewBar } from "@/lib/agents/decisionView";
import { defaultAgentParams } from "@/lib/agents/params";
import { scoreNight, type PickReplayDeps } from "@/lib/scorecard/pickReplay";
import type { ScoredPick } from "@/lib/scorecard/pickScorecard";

const D = "2026-11-12";
const ND = "2026-11-13";
const m = (n: number): bigint => BigInt(Math.round(n * 1_000_000));

type Code = {
  code: string;
  tier?: string;
  halted?: boolean;
  industry?: string | null;
  /** close on d and on nd (undefined = no bar that day) */
  dClose?: number;
  ndClose?: number;
  /** earlier volumes (oldest first) and the volume of nd */
  priorVol?: number[];
  ndVol?: number;
  /** drop the nd bar from the code's own list while keeping its close lookup */
  noNdBarInList?: boolean;
};

function stub(codes: Code[], index: { d?: number; nd?: number } = { d: 7000, nd: 7070 }) {
  const find = (c: string) => codes.find((x) => x.code === c);
  const barsOf = (code: string): ViewBar[] => {
    const x = find(code);
    if (x === undefined) return [];
    const bar = (d: string, close: number, volume: number): ViewBar => ({
      d,
      open: m(close),
      high: m(close),
      low: m(close),
      close: m(close),
      volume: BigInt(volume),
    });
    const prior = (x.priorVol ?? []).map((v, i) =>
      bar(`2026-10-${String(10 + i).padStart(2, "0")}`, 100, v),
    );
    const out = [...prior];
    if (x.dClose !== undefined) out.push(bar(D, x.dClose, 1000));
    if (x.ndClose !== undefined && !x.noNdBarInList) out.push(bar(ND, x.ndClose, x.ndVol ?? 1000));
    return out;
  };
  const world = {
    market: "AU",
    familyInputs: (d: string) => {
      expect(d).toBe(ND);
      return {
        codes: codes.map((c) => ({
          code: c.code,
          tier: c.tier ?? "U1",
          halted: c.halted ?? false,
          industry: c.industry ?? null,
        })),
      };
    },
    bar: (code: string, d: string) => {
      const x = find(code);
      const v = d === D ? x?.dClose : x?.ndClose;
      return v === undefined ? undefined : { close: m(v) };
    },
    barsOf,
    indexBarsOf: () => [
      ...(index.d === undefined ? [] : [{ d: D, close: m(index.d) }]),
      ...(index.nd === undefined ? [] : [{ d: ND, close: m(index.nd) }]),
    ],
  };
  return { world, params: defaultAgentParams(), db: null as never } as unknown as PickReplayDeps;
}

const pick = (code: string): ScoredPick => ({
  profile: "balanced",
  rank: 1,
  code,
  source: "strategy",
  stopMicro: m(90),
  aimMicro: m(110),
});

describe("scoreNight", () => {
  const banks = (n: number, ndClose: (i: number) => number): Code[] =>
    Array.from({ length: n }, (_, i) => ({
      code: `ZB${i + 1}`,
      industry: "Banks",
      dClose: 100,
      ndClose: ndClose(i),
      priorVol: [1000, 1000, 1000],
      ndVol: 5000,
    }));

  it("a mover that went with its sector is explained by the sector; the index and volume are read", () => {
    // ZB1 +10 %, its five sector mates +9 %: the sector explains it (same sign, at least 60 % of the move)
    const deps = stub(banks(6, (i) => (i === 0 ? 110 : 109)));
    const day = scoreNight(deps, D, ND, [pick("ZB1")], null)!;
    expect(day.nextD).toBe(ND);
    expect(day.liquidN).toBe(6);
    expect(day.gainersN).toBe(5);
    expect(day.gainerHits).toBe(1); // ZB1 was picked
    expect(day.detail.gainers[0]).toMatchObject({ code: "ZB1", via: "strategy" });
    // ZB2..ZB5 were not picked: their move is the sector's, so the cause is the sector move
    const missed = day.detail.gainers.filter((g) => g.missed !== null).map((g) => g.missed);
    expect(missed).toEqual(["sector_move", "sector_move", "sector_move", "sector_move"]);
    expect(day.cortex).toBeNull();
  });

  it("a mover with no sector mates, a placeholder industry or no industry has no sector figure", () => {
    const codes: Code[] = [
      {
        code: "ZS1",
        industry: "Banks",
        dClose: 100,
        ndClose: 108,
        priorVol: [1000, 1000],
        ndVol: 1000,
      }, // alone in its sector
      { code: "ZS2", industry: "Not Applic", dClose: 100, ndClose: 107, priorVol: [], ndVol: 1000 },
      { code: "ZS3", industry: null, dClose: 100, ndClose: 106, priorVol: [0, 0], ndVol: 1000 },
      { code: "ZS4", industry: "Class Pend", dClose: 100, ndClose: 105 },
    ];
    // the index moved with them, so the market explains the unsectored movers
    const day = scoreNight(stub(codes, { d: 7000, nd: 7070 }), D, ND, [], null)!;
    expect(day.gainersN).toBe(4);
    expect(day.detail.gainers.every((g) => g.missed !== null)).toBe(true);
  });

  it("without an index move, with a zero previous index close, or with an index bar missing, the night still scores", () => {
    const codes: Code[] = [{ code: "ZI1", dClose: 100, ndClose: 103 }];
    for (const index of [{ d: 7000 }, { nd: 7070 }, { d: 0, nd: 7070 }, {}]) {
      const day = scoreNight(stub(codes, index), D, ND, [pick("ZI1")], null)!;
      expect(day).toMatchObject({ gainersN: 1, gainerHits: 1, picksN: 1 });
    }
  });

  it("volume against the usual: today's bar missing from the list, or a zero usual volume, gives no ratio", () => {
    const codes: Code[] = [
      // the nd close exists, but the code's own list stops before nd (no volume for the day)
      { code: "ZV1", dClose: 100, ndClose: 104, priorVol: [1000], noNdBarInList: true },
      // all-zero prior volume: no ratio
      { code: "ZV2", dClose: 100, ndClose: 103, priorVol: [0, 0, 0], ndVol: 9000 },
      // five times the usual volume with no news: heavy trading
      { code: "ZV3", dClose: 100, ndClose: 102, priorVol: [1000, 1000, 1000], ndVol: 5000 },
    ];
    const day = scoreNight(stub(codes, {}), D, ND, [], null)!;
    expect(day.gainersN).toBe(3);
    expect(day.detail.gainers.map((g) => g.code)).toEqual(["ZV1", "ZV2", "ZV3"]);
  });

  it("halted and illiquid codes are not liquid; codes with no or a zero bar on either day are not moves", () => {
    const codes: Code[] = [
      { code: "ZL1", dClose: 100, ndClose: 105 },
      { code: "ZH1", halted: true, dClose: 100, ndClose: 130 },
      { code: "ZT3", tier: "U3", dClose: 100, ndClose: 120 }, // a move, but not a liquid share
      { code: "ZN1", dClose: undefined, ndClose: 110 }, // no bar on d
      { code: "ZN2", dClose: 100, ndClose: undefined }, // no bar on nd
      { code: "ZN3", dClose: 100, ndClose: 0 }, // a zero close
      { code: "ZN4", dClose: 0, ndClose: 100 },
    ];
    const day = scoreNight(stub(codes), D, ND, [], null)!;
    expect(day.liquidN).toBe(5); // ZL1 and the four with a missing or zero bar are U1, not halted
    expect(day.gainersN).toBe(1);
    expect(day.detail.gainers[0]!.code).toBe("ZL1");
  });

  it("a night with no scorable move is skipped", () => {
    const codes: Code[] = [
      { code: "ZN1", dClose: undefined, ndClose: 110 },
      { code: "ZH1", halted: true, dClose: 100, ndClose: 130 },
    ];
    expect(scoreNight(stub(codes), D, ND, [], null)).toBeNull();
  });

  it("the Cortex basis is carried to the day", () => {
    // no features night: no Cortex line whatever the basis
    expect(
      scoreNight(stub([{ code: "ZL1", dClose: 100, ndClose: 105 }]), D, ND, [], null, "golive")!
        .cortex,
    ).toBeNull();
  });
});
