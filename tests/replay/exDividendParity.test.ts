// @vitest-environment node
// FAM-007 / GL-02 parity (M14 review fix 1): the live signal ledger (LiveWorld) must give the walk
// the same decision cut-off per session as the replay world, so a dividend confirmed before the
// previous session's cut-off is filled on its ex-date in both.
import type { Client } from "@libsql/client";
import { describe, expect, it } from "vitest";
import type { ExitPlan } from "@/lib/agents/families";
import { decisionCutoffUtc } from "@/lib/agents/decisionView";
import { LiveWorld } from "@/lib/agents/forwardLedger";
import { defaultAgentParams } from "@/lib/agents/params";
import { costSetupFrom, walkPosition, type PathSource } from "@/lib/replay/returns";
import { handSource, sessionList, viewBar } from "../fixtures/replay/ledgerWorld";

const p = defaultAgentParams();
const M = 1_000_000n;
const S = sessionList("2026-03-13", 12);
const facts = { atrMicro: null, closeAboveExitSma: null, volumeRatios: [], events: [] };
const plan: ExitPlan = {
  initialStops: [],
  trails: [],
  cs: [
    { id: "ts", via: null, kind: "time_stop", sessions: 4, minReturn: null },
  ] as unknown as ExitPlan["cs"],
};

function liveWorld(): LiveWorld {
  return new LiveWorld({
    db: {} as Client,
    market: "AU",
    d: S[S.length - 1]!,
    sessions: S,
    params: p,
    actions: [],
    replay: false,
    hours: { tz: "Australia/Sydney", open_time: "10:00", close_time: "16:00" },
  });
}

describe("ex-dividend parity: live ledger vs replay (FAM-007)", () => {
  const bars = Array.from({ length: 7 }, (_, i) =>
    viewBar(S[i]!, 50n * M, 50n * M, 50n * M, 50n * M),
  );
  const div = {
    id: "d1",
    code: "ZZA",
    type: "cash_dividend",
    exDate: S[2]!,
    payload: { dps: "0.10", pay_date: S[5]! },
    knownAt: `${S[0]}T00:00:00.000Z`, // before the cut-off of S[1]
  };
  const hand = handSource(S, { ZZA: bars }, facts, undefined, [div]);
  const spec = {
    code: "ZZA",
    plan,
    entryIdx: 0,
    endIdx: 11,
    advMicro: (10_000_000n * 10_000_000n * M) / 10_000_000n,
    maxOpenMicro: null,
    forceExit: false,
  } as Parameters<typeof walkPosition>[1];

  it("LiveWorld exposes the same cut-off as the replay world formula", () => {
    const w = liveWorld();
    for (const d of [S[0]!, S[3]!]) {
      expect(w.decisionCutoffOf(d)).toBe(decisionCutoffUtc(d, p.decisionCutoff));
    }
  });

  it("a dividend known before the prior cut-off is filled via LiveWorld's cut-off", () => {
    const w = liveWorld();
    const live: PathSource = { ...hand, decisionCutoffOf: (d) => w.decisionCutoffOf(d) };
    const replay: PathSource = {
      ...hand,
      decisionCutoffOf: (d) => decisionCutoffUtc(d, p.decisionCutoff),
    };
    const cost = costSetupFrom(p);
    const a = walkPosition(live, spec, cost);
    const b = walkPosition(replay, spec, cost);
    expect(a).toEqual(b);
    expect(a.kind).toBe("filled");
    expect(a.kind === "filled" ? a.dividendMicro : 0n).toBe(1_100_000n);
  });
});
