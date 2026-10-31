// @vitest-environment node
// D-348: the stage advances the corporate-action, halt and promotion machines nightly and appends the
// changed `cortex_state` rows (the closing 'none' row included), before runNight reads them.
import type { Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAsOfView } from "@/lib/cortex/pit/asOfView";
import { advanceStates, corpActionsWithProvenance } from "@/lib/cortex/stage";
import { statesInForce, stateHistory } from "@/lib/cortex/store";
import { cleanupTempDbs } from "../db/helpers";
import { freshReplayDb, MARKET } from "./batch2bHarness";
import { path, SESSIONS, statesWorld, type FixtureSpec } from "../cortex/states/zzStates";

const BREAK = 10;
const EX = SESSIONS[BREAK]!;
const KNOWN = `${SESSIONS[9]!}T05:00:00.000Z`;

let db: Client;
beforeAll(async () => {
  db = await freshReplayDb();
});
afterAll(cleanupTempDbs);

async function night(spec: FixtureSpec, t: number) {
  const view = buildAsOfView(statesWorld([spec]));
  const prior = await statesInForce(db, MARKET, SESSIONS[t]!);
  return advanceStates(db, {
    market: MARKET,
    d: SESSIONS[t]!,
    view,
    t,
    prior: prior.map((s) => ({ code: s.code, kind: s.kind, state: s.state, basis: s.basis })),
  });
}

describe("corporate action across two nights", () => {
  const [rec] = corpActionsWithProvenance(
    [
      {
        id: "7",
        code: "ZZS",
        type: "split",
        exDate: EX,
        payload: { new: 2, old: 1 },
        knownAt: null,
        evidence: { sources: [{ src: "announcement", ref: "a" }] },
      },
    ],
    [{ actionId: "7", at: KNOWN, status: "queued", note: JSON.stringify({ queue: "pending" }) }],
  );
  const spec: FixtureSpec = {
    code: "ZZS",
    tier: "U1",
    bars: { closesCents: path(1000, BREAK, [-0.5, -0.01]) },
    corpActions: [rec!],
  };

  it("a pending announcement becomes a candidate, then confirmed on the break, with rows written", async () => {
    const n1 = await night(spec, 9);
    expect(n1.written).toBe(1);
    expect(n1.states.find((s) => s.code === "ZZS")).toMatchObject({
      kind: "corp_action",
      state: "candidate",
    });
    const n2 = await night(spec, BREAK);
    expect(n2.written).toBe(1);
    expect(n2.states.find((s) => s.code === "ZZS")).toMatchObject({ state: "confirmed" });
    const h = await stateHistory(db, MARKET, "ZZS", "corp_action");
    expect(h.map((r) => [r.fromD, r.state])).toEqual([
      [SESSIONS[9], "candidate"],
      [SESSIONS[BREAK], "confirmed"],
    ]);
  });

  it("a second run of the same night writes nothing more", async () => {
    const again = await night(spec, BREAK);
    expect(again.written).toBe(0);
  });
});

describe("a halt opens and closes", () => {
  const closes = path(1000, SESSIONS.length, []).map((v, i) => (i === 5 || i === 6 ? null : v));
  const spec: FixtureSpec = {
    code: "ZZH",
    tier: "U1",
    bars: { closesCents: closes },
    halts: [
      { d: SESSIONS[5]!, halted: true },
      { d: SESSIONS[7]!, halted: false },
    ],
  };

  it("writes the halt row on the first halted night and the closing none row after it", async () => {
    expect((await night(spec, 5)).written).toBe(1);
    expect((await night(spec, 6)).written).toBe(0);
    const closed = await night(spec, 7);
    expect(closed.written).toBe(1);
    const h = await stateHistory(db, MARKET, "ZZH", "halt");
    expect(h.map((r) => [r.fromD, r.state])).toEqual([
      [SESSIONS[5], "halt"],
      [SESSIONS[7], "none"],
    ]);
    expect(closed.states.some((s) => s.code === "ZZH")).toBe(false);
  });
});
