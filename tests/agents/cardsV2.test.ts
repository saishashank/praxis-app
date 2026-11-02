// @vitest-environment node
// Decision Card schema v2 (M15 P4; CTX-070): a v1 card still validates and is untouched by the change;
// a v2 card is the v1 card plus the Cortex block; the block carries whole numbers and plain words only.
import { describe, expect, it } from "vitest";
import {
  CARD_SCHEMA_VERSION,
  CARD_SCHEMA_VERSION_V2,
  buildCard,
  buildCardV2,
  cardVersion,
  checkCard,
  cortexBlockOf,
  type CardInputs,
} from "@/lib/agents/cards";
import { defaultAgentParams } from "@/lib/agents/params";
import { COST_PROFILES } from "@/lib/arena/costs";
import { GATE_LABELS } from "@/lib/cortex/gates/list";
import type { CardFields } from "@/lib/cortex/night";
import { makeRational } from "@/lib/money/rational";

const params = defaultAgentParams();

const inputs = (): CardInputs => ({
  signalId: "sig:AU:2031-02-26:F4:F4.v1:F4:ZZA",
  market: "AU",
  d: "2031-02-26",
  executionId: "E07",
  candidate: {
    family: "F4",
    variant: "F4",
    ruleVersion: "F4.v1",
    code: "ZZA",
    regime: "RISK-ON",
    rules: [{ id: "rsi2", pass: true, value: "7.5", threshold: "10" }],
    rankText: "-7.5",
    flags: ["first-seen"],
    halfSize: false,
    groupKey: "ZZA|2031-02-24",
  },
  taken: true,
  notTakenReason: null,
  closeMicro: 1_000_000n,
  plan: {
    initialStops: [
      {
        id: "initial",
        via: null,
        spec: { atr_micro: 50_000n, k: makeRational(2n), cap: null, level_micro: null },
      },
    ],
    trails: [{ id: "trail", via: null, k: makeRational(3n), activateGain: null }],
    cs: [{ id: "time_stop", via: null, kind: "time_stop", sessions: 10, minReturn: null }],
  },
  events: [],
  insiderScoreQ: null,
  shortDrop: false,
  eventLowMicro: null,
  sizing: null,
  scenario: { split: null, nets: [] },
  params,
  costProfile: COST_PROFILES.P5,
  tickCrossFactor: makeRational(1n),
});

const fields: CardFields = {
  similar: { p: 0.6, lo: null, hi: null, n: 84 },
  breakEven: [
    { c: 0.025, pBe: 0.531 },
    { c: 0.05, pBe: 0.563 },
    { c: 0.075, pBe: 0.595 },
  ],
  reasonsFor: ["momentum"],
  reasonsAgainst: ["sentiment"],
  wouldHaveStopped: "G11_portfolio",
  regime: "RISK-ON",
  independentSources: ["bar_au"],
  costPerOrderPpm: 12_000,
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("card schema v2", () => {
  it("a v1 card keeps validating and keeps version 1", () => {
    const c = clone(buildCard(inputs()));
    expect(c.v).toBe(CARD_SCHEMA_VERSION);
    expect(cardVersion(c)).toBe(1);
    expect(checkCard(c, params)).toEqual([]);
  });

  it("a v1 card is rejected if it carries the v2 block (the version decides the schema)", () => {
    const c = { ...clone(buildCard(inputs())), cortex: cortexBlockOf(fields) };
    expect(checkCard(c, params).length).toBeGreaterThan(0);
  });

  it("a v2 card is the v1 card plus the block and validates", () => {
    const c = clone(buildCardV2(inputs(), fields));
    expect(c.v).toBe(CARD_SCHEMA_VERSION_V2);
    expect(cardVersion(c)).toBe(2);
    expect(checkCard(c, params)).toEqual([]);
    const strip = (x: object): Record<string, unknown> => {
      const o: Record<string, unknown> = { ...x };
      delete o.cortex;
      delete o.v;
      return o;
    };
    expect(strip(c)).toEqual(strip(clone(buildCard(inputs()))));
  });

  it("the block holds ppm integers and the plain label, never the gate id", () => {
    const b = cortexBlockOf(fields);
    expect(b.similar).toEqual({ p_ppm: 600_000, lo_ppm: null, hi_ppm: null, n: 84 });
    expect(b.break_even.map((x) => x.p_be_ppm)).toEqual([531_000, 563_000, 595_000]);
    expect(b.would_have_stopped).toBe(GATE_LABELS.G11_portfolio);
    expect(JSON.stringify(b)).not.toMatch(/G11/);
  });

  it("is deterministic", () => {
    expect(JSON.stringify(buildCardV2(inputs(), fields))).toBe(
      JSON.stringify(buildCardV2(inputs(), fields)),
    );
  });

  it("rejects a banned term, a wrong break-even count and a missing block", () => {
    const good = clone(buildCardV2(inputs(), fields)) as unknown as {
      cortex: Record<string, unknown>;
    };
    const banned = clone(good);
    banned.cortex.would_have_stopped = "lower bound too low";
    expect(checkCard(banned, params)).toContain("cortex: a banned term on the card");
    const two = clone(good);
    two.cortex.break_even = (two.cortex.break_even as unknown[]).slice(0, 2);
    expect(checkCard(two, params)).toContain("cortex.break_even: none or three cost levels");
    const none = clone(good) as Record<string, unknown>;
    delete none.cortex;
    expect(checkCard(none, params).join()).toContain("cortex");
  });

  it("rejects a probability-named key inside the block", () => {
    const c = clone(buildCardV2(inputs(), fields)) as unknown as {
      cortex: Record<string, unknown>;
    };
    c.cortex.probability = 0.7;
    expect(checkCard(c, params).length).toBeGreaterThan(0);
  });
});
