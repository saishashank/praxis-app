// @vitest-environment node
// M5 T7 (AGT-110, AGT-111; D-096 #15, #16; D-102 draft): the pure thesis-breaker evaluator. Every
// catalogue breaker green / amber / red, the amber level kept as the card stored it, the TB-KW
// confirmation by A2 category or ASX type, the worst-of rule, determinism and order independence.
import { describe, expect, it } from "vitest";
import {
  buildObservation,
  evaluateBreaker,
  evaluateBreakers,
  eventLowOf,
  INTRADAY_BREAKERS,
  itemFromAnnouncement,
  itemsFromEvents,
  worstStatus,
  type BreakerItem,
  type BreakerObservation,
} from "@/lib/agents/breakerEval";
import type { EventFact } from "@/lib/agents/families/types";
import { buildAgentParams } from "@/lib/agents/params";
import {
  cardBreakers,
  describeBreaker,
  BREAKER_CATALOGUE,
  type BreakerId,
  type CardBreaker,
} from "@/lib/agents/thesisBreakers";
import { CONFIG_KEYS } from "@/lib/config/keys";
import type { ViewBar } from "@/lib/agents/decisionView";

const p = buildAgentParams((k) => CONFIG_KEYS[k].default);

const OBS: BreakerObservation = {
  d: "2031-03-03",
  phase: "nightly",
  closeMicro: 1_000_000n,
  smaMicro: 800_000n,
  refCloseMicro: 1_000_000n,
  shortDeltaPpm: 0,
  regime: "RISK-ON",
  items: [],
};
const obs = (o: Partial<BreakerObservation>): BreakerObservation => ({ ...OBS, ...o });

const item = (o: Partial<BreakerItem> = {}): BreakerItem => ({
  ref: "asx|1",
  ageSessions: 0,
  category: "other",
  priceSensitive: false,
  polarity: 0,
  title: null,
  type: null,
  ...o,
});

function breaker(id: BreakerId, family: "F1" | "F2" | "F4" = "F2"): CardBreaker {
  const spec = BREAKER_CATALOGUE.find((b) => b.id === id)!;
  return describeBreaker(spec, { family, shortInterestAvailable: true }, p, {
    closeMicro: 1_000_000n,
    eventLowMicro: 900_000n,
  });
}

const status = (id: BreakerId, o: BreakerObservation, family: "F1" | "F2" | "F4" = "F2"): string =>
  evaluateBreaker(breaker(id, family), o, p).status;

describe("event breakers are green or red only", () => {
  it("TB-NEG: a price-sensitive negative item is red", () => {
    expect(status("TB-NEG", obs({}))).toBe("green");
    expect(status("TB-NEG", obs({ items: [item({ priceSensitive: true, polarity: -1 })] }))).toBe(
      "red",
    );
    expect(status("TB-NEG", obs({ items: [item({ priceSensitive: false, polarity: -1 })] }))).toBe(
      "green",
    );
    expect(status("TB-NEG", obs({ items: [item({ priceSensitive: true, polarity: 1 })] }))).toBe(
      "green",
    );
  });

  it("TB-HALT: a halt, suspension or exchange query is red", () => {
    expect(status("TB-HALT", obs({}))).toBe("green");
    expect(status("TB-HALT", obs({ items: [item({ category: "halt_suspension" })] }))).toBe("red");
    expect(status("TB-HALT", obs({ items: [item({ category: "exchange_query" })] }))).toBe("red");
    expect(status("TB-HALT", obs({ items: [item({ category: "results" })] }))).toBe("green");
  });

  it("TB-RAISE: a capital raising is red", () => {
    expect(status("TB-RAISE", obs({}), "F1")).toBe("green");
    expect(status("TB-RAISE", obs({ items: [item({ category: "capital_raising" })] }), "F1")).toBe(
      "red",
    );
  });

  it("TB-REGIME: SHOCK for every family, RISK-OFF also for F1 (never amber)", () => {
    expect(status("TB-REGIME", obs({ regime: "RISK-ON" }), "F1")).toBe("green");
    expect(status("TB-REGIME", obs({ regime: "RISK-OFF" }), "F1")).toBe("red");
    expect(status("TB-REGIME", obs({ regime: "SHOCK" }), "F1")).toBe("red");
    expect(status("TB-REGIME", obs({ regime: "RISK-OFF" }), "F2")).toBe("green");
    expect(status("TB-REGIME", obs({ regime: "SHOCK" }), "F2")).toBe("red");
    expect(status("TB-REGIME", obs({ regime: null }), "F1")).toBe("green");
  });

  it("names the announcement that triggered it, the first by reference", () => {
    const e = evaluateBreaker(
      breaker("TB-HALT"),
      obs({
        items: [
          item({ ref: "asx|9", category: "halt_suspension" }),
          item({ ref: "asx|2", category: "exchange_query" }),
        ],
      }),
      p,
    );
    expect(e.triggerRef).toBe("asx|2");
  });
});

describe("TB-EVLOW: the amber level is the one stored on the card (D-096 #15)", () => {
  // card: level 900,000, amber at 900,000 + 20 % x (1,000,000 - 900,000) = 920,000
  it("green above the amber level, amber at and below it, red below the level", () => {
    const b = breaker("TB-EVLOW");
    expect(b.amber_at_micro).toBe("920000");
    expect(status("TB-EVLOW", obs({ closeMicro: 950_000n }))).toBe("green");
    expect(status("TB-EVLOW", obs({ closeMicro: 920_001n }))).toBe("green");
    expect(status("TB-EVLOW", obs({ closeMicro: 920_000n }))).toBe("amber");
    expect(status("TB-EVLOW", obs({ closeMicro: 900_000n }))).toBe("amber");
    expect(status("TB-EVLOW", obs({ closeMicro: 899_999n }))).toBe("red");
  });

  it("never recomputes the level: a card with another stored amber level wins", () => {
    const stored = { ...breaker("TB-EVLOW"), amber_at_micro: "950000" };
    expect(evaluateBreaker(stored, obs({ closeMicro: 940_000n }), p).status).toBe("amber");
  });

  it("no level on the card or no bar: green with the reason", () => {
    const none = { ...breaker("TB-EVLOW"), level_micro: null, amber_at_micro: null };
    expect(evaluateBreaker(none, obs({}), p)).toMatchObject({ status: "green" });
    expect(evaluateBreaker(breaker("TB-EVLOW"), obs({ closeMicro: null }), p)).toMatchObject({
      status: "green",
      valueText: "no_bar",
    });
  });
});

describe("TB-SMA: amber after only the amber fraction of the distance from the card day is left", () => {
  // sma 1,000,000, close on the card day 1,100,000 -> amber at 1,000,000 + 20 % x 100,000
  const o = (close: bigint): BreakerObservation =>
    obs({ smaMicro: 1_000_000n, refCloseMicro: 1_100_000n, closeMicro: close });
  it("green / amber / red", () => {
    expect(status("TB-SMA", o(1_050_000n), "F4")).toBe("green");
    expect(status("TB-SMA", o(1_020_001n), "F4")).toBe("green");
    expect(status("TB-SMA", o(1_020_000n), "F4")).toBe("amber");
    expect(status("TB-SMA", o(1_000_000n), "F4")).toBe("amber");
    expect(status("TB-SMA", o(999_999n), "F4")).toBe("red");
  });
  it("warm-up (no SMA) is green with the reason", () => {
    expect(evaluateBreaker(breaker("TB-SMA", "F4"), obs({ smaMicro: null }), p)).toMatchObject({
      status: "green",
      valueText: "no_level",
    });
  });
});

describe("TB-SI: a short-interest rise of f6_short_drop_pp (2 pp = 20,000 ppm) is red", () => {
  it("green / amber / red; unknown is green", () => {
    expect(status("TB-SI", obs({ shortDeltaPpm: 0 }))).toBe("green");
    expect(status("TB-SI", obs({ shortDeltaPpm: -50_000 }))).toBe("green");
    expect(status("TB-SI", obs({ shortDeltaPpm: 15_999 }))).toBe("green");
    expect(status("TB-SI", obs({ shortDeltaPpm: 16_000 }))).toBe("amber");
    expect(status("TB-SI", obs({ shortDeltaPpm: 19_999 }))).toBe("amber");
    expect(status("TB-SI", obs({ shortDeltaPpm: 20_000 }))).toBe("red");
    expect(evaluateBreaker(breaker("TB-SI"), obs({ shortDeltaPpm: null }), p)).toMatchObject({
      status: "green",
      valueText: "unknown",
    });
  });
});

describe("TB-KW: automatic confirmation (D-096 #16)", () => {
  const kw = (o: Partial<BreakerItem>): BreakerObservation =>
    obs({ items: [item({ title: "company announces guidance downgrade", ...o })] });
  it("the night the keyword is first seen: amber, awaiting confirmation", () => {
    const e = evaluateBreaker(
      breaker("TB-KW"),
      kw({ ageSessions: 0, category: "guidance_down" }),
      p,
    );
    expect(e.status).toBe("amber");
    expect(e.valueText).toContain("awaiting_confirmation");
  });
  it("after tb_kw_confirm_sessions: red when the A2 category confirms", () => {
    expect(p.tbKwConfirmSessions).toBe(1);
    expect(status("TB-KW", kw({ ageSessions: 1, category: "guidance_down" }))).toBe("red");
    expect(status("TB-KW", kw({ ageSessions: 1, category: "halt_suspension" }))).toBe("red");
  });
  it("red when the ASX type code confirms although the category does not", () => {
    expect(status("TB-KW", kw({ ageSessions: 1, category: "other", type: "trading halt" }))).toBe(
      "red",
    );
  });
  it("otherwise back to green, reason unconfirmed", () => {
    const e = evaluateBreaker(breaker("TB-KW"), kw({ ageSessions: 1, category: "other" }), p);
    expect(e.status).toBe("green");
    expect(e.valueText).toContain("unconfirmed");
    expect(status("TB-KW", kw({ ageSessions: 3, category: "other" }))).toBe("green");
  });
  it("no keyword in the title (or no text at all) is green", () => {
    expect(
      status("TB-KW", obs({ items: [item({ title: "routine update", ageSessions: 0 })] })),
    ).toBe("green");
    expect(
      status("TB-KW", obs({ items: [item({ title: null, category: "guidance_down" })] })),
    ).toBe("green");
  });
  it("the wait is a parameter, not a constant", () => {
    const slow = buildAgentParams((k) =>
      k === "tb_kw_confirm_sessions" ? 3 : CONFIG_KEYS[k].default,
    );
    const o = kw({ ageSessions: 2, category: "guidance_down" });
    expect(evaluateBreaker(breaker("TB-KW"), o, slow).status).toBe("amber");
    expect(
      evaluateBreaker(breaker("TB-KW"), kw({ ageSessions: 3, category: "guidance_down" }), slow)
        .status,
    ).toBe("red");
  });
});

describe("position status, phases and determinism", () => {
  it("worst breaker wins (decision 15)", () => {
    expect(worstStatus([])).toBe("green");
    expect(worstStatus(["green", "amber", "green"])).toBe("amber");
    expect(worstStatus(["amber", "red", "green"])).toBe("red");
  });

  it("a card list evaluates in card order and reports the red ids", () => {
    const list = cardBreakers({ family: "F1", shortInterestAvailable: true }, p, {
      closeMicro: 1_000_000n,
      eventLowMicro: null,
    });
    const r = evaluateBreakers(
      list,
      obs({ regime: "RISK-OFF", items: [item({ category: "capital_raising" })] }),
      p,
    );
    expect(r.evaluations.map((e) => e.id)).toEqual(list.map((b) => b.id));
    expect(r.status).toBe("red");
    expect(r.red).toEqual(["TB-RAISE", "TB-REGIME"]);
  });

  it("the intraday phase runs only the event breakers", () => {
    const list = cardBreakers({ family: "F2", shortInterestAvailable: true }, p, {
      closeMicro: 1_000_000n,
      eventLowMicro: 900_000n,
    });
    const r = evaluateBreakers(list, obs({ phase: "intraday", closeMicro: 1n }), p);
    expect(r.evaluations.every((e) => INTRADAY_BREAKERS.includes(e.id))).toBe(true);
    expect(r.status).toBe("green"); // TB-EVLOW would be red at close 1: not evaluated intraday
  });

  it("is deterministic and independent of item order", () => {
    const list = cardBreakers({ family: "F2", shortInterestAvailable: true }, p, {
      closeMicro: 1_000_000n,
      eventLowMicro: 900_000n,
    });
    const items = [
      item({ ref: "asx|3", category: "capital_raising", priceSensitive: true, polarity: -1 }),
      item({ ref: "asx|1", category: "halt_suspension", priceSensitive: true, polarity: -1 }),
      item({ ref: "asx|2", title: "guidance downgrade", category: "guidance_down" }),
    ];
    const a = evaluateBreakers(list, obs({ items }), p);
    const b = evaluateBreakers(list, obs({ items: [...items].reverse() }), p);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(evaluateBreakers(list, obs({ items }), p))).toBe(JSON.stringify(a));
  });
});

describe("observations", () => {
  const bar = (d: string, close: bigint): ViewBar => ({
    d,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1n,
  });

  it("the SMA is exact over sma_trend_period raw closes; null while warming up", () => {
    const bars = Array.from({ length: 200 }, (_, i) => bar(`d${i}`, BigInt(1_000_000 + i)));
    const full = buildObservation(
      {
        d: "d199",
        phase: "nightly",
        rawBars: bars,
        refCloseMicro: null,
        shortDeltaPpm: null,
        regime: null,
        items: [],
      },
      p,
    );
    expect(full.smaMicro).toBe(1_000_100n); // mean of 1,000,000..1,000,199 = 1,000,099.5, half away
    expect(full.closeMicro).toBe(1_000_199n);
    const warm = buildObservation(
      {
        d: "d9",
        phase: "nightly",
        rawBars: bars.slice(0, 10),
        refCloseMicro: null,
        shortDeltaPpm: null,
        regime: null,
        items: [],
      },
      p,
    );
    expect(warm.smaMicro).toBeNull();
  });

  it("a stale last bar is no close", () => {
    const o = buildObservation(
      {
        d: "d5",
        phase: "nightly",
        rawBars: [bar("d4", 5n)],
        refCloseMicro: null,
        shortDeltaPpm: null,
        regime: null,
        items: [],
      },
      p,
    );
    expect(o.closeMicro).toBeNull();
  });

  it("items from A2 events count the sessions since day 0; text is looked up by reference", () => {
    const sessions = ["s1", "s2", "s3", "s4"];
    const ev = (id: string, day0: string): EventFact => ({
      id,
      code: "ZZ",
      day0,
      groupKey: `ZZ|${day0}`,
      category: "guidance_down",
      priceSensitive: true,
      polarity: -1,
      ar: null,
      volRatio: null,
      timed: true,
      day0LowMicro: null,
    });
    const items = itemsFromEvents(
      [ev("asx|b", "s2"), ev("asx|a", "s4")],
      sessions,
      "s4",
      new Map([["asx|b", { title: "Guidance DOWNGRADE", type: " Trading Halt " }]]),
    );
    expect(items.map((i) => [i.ref, i.ageSessions])).toEqual([
      ["asx|a", 0],
      ["asx|b", 2],
    ]);
    expect(items[1]).toMatchObject({ title: "guidance downgrade", type: "trading halt" });
    expect(items[0]).toMatchObject({ title: null, type: null });
  });

  it("a raw announcement is classified by the A2 rule table (halt: negative, price sensitive)", () => {
    const i = itemFromAnnouncement({
      ref: "asx|x",
      type: "Trading Halt",
      title: "Trading Halt",
      priceSensitive: true,
    });
    expect(i).toMatchObject({ category: "halt_suspension", polarity: -1, ageSessions: 0 });
  });

  it("the event low is the day-0 low of the signal's group", () => {
    const e = {
      id: "a",
      code: "ZZ",
      day0: "s1",
      groupKey: "g1",
      day0LowMicro: 7n,
    } as unknown as EventFact;
    expect(eventLowOf([e], "g1")).toBe(7n);
    expect(eventLowOf([e], "g2")).toBeNull();
    expect(eventLowOf([e], null)).toBeNull();
  });
});
