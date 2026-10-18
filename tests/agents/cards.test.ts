// @vitest-environment node
// Decision Cards (M4 T9; AGT-110, AT-16; design 4.5, decisions 20 and 21; D-084). Pure builder,
// thesis-breaker catalogue, scenario table (n = 12 acceptance case), validator, grounding of the
// card note, determinism, and the scenario lookup against the development ledger.
import type { Client } from "@libsql/client";
import { afterAll, describe, expect, it } from "vitest";
import {
  CARD_NOTE_KIND,
  CARD_TEMPLATE_VERSION,
  DATA_QUALITY_FLAGS,
  buildCard,
  buildScenario,
  cardIdOf,
  cardNote,
  checkCard,
  finishCard,
  loadScenarioInput,
  noteRequest,
  nearestRankPpm,
  rulesNoteText,
  validateCard,
  type CardInputs,
  type DecisionCard,
} from "@/lib/agents/cards";
import type { EventFact, ExitPlan, Family } from "@/lib/agents/families/types";
import { defaultAgentParams } from "@/lib/agents/params";
import {
  BREAKER_CATALOGUE,
  amberLevelMicro,
  applicableBreakers,
  cardBreakers,
} from "@/lib/agents/thesisBreakers";
import { COST_PROFILES } from "@/lib/arena/costs";
import { checkGrounding } from "@/lib/llm/grounding";
import { promptSha } from "@/lib/llm/providers";
import { buildPrompt } from "@/lib/llm/router";
import { makeRational } from "@/lib/money/rational";
import { cleanupTempDbs } from "../db/helpers";
import { freshReplayDb } from "./batch2bHarness";
import { MOCK_MODEL, makeRouter, mockProvider } from "../llm/helpers";

afterAll(cleanupTempDbs);

const params = defaultAgentParams();

const plan: ExitPlan = {
  initialStops: [
    {
      id: "initial",
      via: null,
      spec: { atr_micro: 50_000n, k: makeRational(2n), cap: null, level_micro: null },
    },
  ],
  trails: [{ id: "trail", via: null, k: makeRational(3n), activateGain: null }],
  cs: [{ id: "time_stop", via: null, kind: "time_stop", sessions: 10, minReturn: null }],
};

const event: EventFact = {
  id: "asx|ann-77",
  code: "ZZA",
  day0: "2031-02-24",
  groupKey: "ZZA|2031-02-24",
  category: "results",
  priceSensitive: true,
  polarity: 1,
  ar: makeRational(37n, 1000n),
  volRatio: makeRational(3n),
  timed: false,
  day0LowMicro: 980_000n,
};

function inputs(over: Partial<CardInputs> & { family?: Family } = {}): CardInputs {
  const family = over.family ?? "F4";
  return {
    signalId: `sig:AU:2031-02-26:${family}:${family}.v1:${family}:ZZA`,
    market: "AU",
    d: "2031-02-26",
    executionId: "E07",
    candidate: {
      family,
      variant: family,
      ruleVersion: `${family}.v1`,
      code: "ZZA",
      regime: "RISK-ON",
      rules: [
        { id: "rsi2", pass: true, value: "7.5", threshold: "10" },
        { id: "above_sma200", pass: true, value: "true", threshold: "true" },
      ],
      rankText: "-7.5",
      flags: ["first-seen"],
      halfSize: false,
      groupKey: event.groupKey,
    },
    taken: true,
    notTakenReason: null,
    closeMicro: 1_000_000n,
    plan,
    events: [event],
    insiderScoreQ: null,
    shortDrop: false,
    eventLowMicro: 980_000n,
    sizing: {
      accepted: true,
      reasons: [],
      qty: 540n,
      fillPriceMicro: 1_001_000n,
      slipMicro: 1_000n,
      brokerageMicro: 9_500_000n,
      orderValueMicro: 540n * 1_001_000n,
      refPriceMicro: 1_000_000n,
      advValueMicro: 2_000_000_000_000n,
    },
    scenario: { split: null, nets: [] },
    params,
    costProfile: COST_PROFILES.P5,
    tickCrossFactor: makeRational(1n),
    ...over,
  };
}

const nets = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ num: BigInt(i + 1), den: 100n }));
const split = { version: 1, devEndD: "2030-12-31", deferredUntilD: null, asOfD: "2030-12-31" };

describe("AT-16: every card has thesis-breakers, a scenario table and no LLM number", () => {
  it("lists 3-5 catalogue breakers for every family and carries every AGT-110 field", () => {
    for (const family of ["F1", "F2", "F3", "F4", "F5", "F6"] as const) {
      const card = buildCard(inputs({ family }));
      expect(checkCard(JSON.parse(JSON.stringify(card)), params)).toEqual([]);
      expect(card.thesis_breakers.length).toBeGreaterThanOrEqual(params.thesisBreakersMin);
      expect(card.thesis_breakers.length).toBeLessThanOrEqual(params.thesisBreakersMax);
      expect(Object.keys(card)).toEqual(
        expect.arrayContaining([
          "market",
          "code",
          "family",
          "execution",
          "rule_version",
          "variant",
          "regime",
          "rules_fired",
          "rank_score",
          "evidence",
          "exit_plan",
          "cost",
          "scenario",
          "footnote",
        ]),
      );
      expect(card.scenario).toBeDefined();
      expect(JSON.stringify(card)).not.toMatch(/prob|confidence/i);
    }
  });

  it("exit plan carries IS/CS tags and the cost block the break-even", () => {
    const card = buildCard(inputs());
    expect(card.exit_plan.map((e) => `${e.tag}:${e.kind}`)).toEqual([
      "IS:initial_stop",
      "IS:trail",
      "CS:time_stop",
    ]);
    // stop at close = 1,000,000 - round(2 x 50,000) = 900,000
    expect(card.exit_plan[0]!.detail.stop_at_close_micro).toBe("900000");
    expect(card.cost.available).toBe(true);
    const total = BigInt(card.cost.cost_estimate_micro!);
    const parts =
      BigInt(card.cost.entry_brokerage_micro!) +
      BigInt(card.cost.entry_slippage_micro!) +
      BigInt(card.cost.exit_brokerage_micro!) +
      BigInt(card.cost.exit_slippage_micro!);
    expect(total).toBe(parts);
    const value = BigInt(card.cost.order_value_micro!);
    expect(BigInt(card.cost.break_even_ppm!)).toBe((total * 1_000_000n + value - 1n) / value);
    expect(buildCard(inputs({ sizing: null })).cost).toMatchObject({
      available: false,
      reason: "not_sized",
    });
  });

  it("events show polarity, AR and source ids; flags are the five allowed ones", () => {
    const card = buildCard(inputs({ family: "F2" }));
    expect(card.evidence.events).toEqual([
      {
        source: "asx",
        ann_id: "ann-77",
        day0: "2031-02-24",
        category: "results",
        polarity: "1",
        price_sensitive: true,
        ar_ppm: 37_000,
        timed: false,
      },
    ]);
    expect(card.evidence.insider_flow).toBe("unknown");
    // untimed event -> assumed-time; first-seen came from the signal
    expect(card.evidence.data_quality_flags).toEqual(["assumed-time", "first-seen"]);
    for (const f of card.evidence.data_quality_flags) expect(DATA_QUALITY_FLAGS).toContain(f);
    const odd = buildCard(
      inputs({ candidate: { ...inputs().candidate, flags: ["halt-proxy", "stale-data"] } }),
    );
    expect(odd.evidence.data_quality_flags).toEqual(["assumed-time", "stale-data"]);
    expect(odd.evidence.other_flags).toEqual(["halt-proxy"]);
  });
});

describe("scenario table (decision 21)", () => {
  it("n = 12 shows insufficient history with the reason and n", () => {
    const card = buildCard(inputs({ scenario: { split, nets: nets(12) } }));
    expect(card.scenario).toMatchObject({
      insufficient_history: true,
      n: 12,
      reason: "n < 30",
      p10_ppm: null,
      p50_ppm: null,
      p90_ppm: null,
    });
    expect(card.footnote).toBe("Development-split replay, n 12, split v1, as of 2030-12-31.");
    expect(checkCard(JSON.parse(JSON.stringify(card)), params)).toEqual([]);
  });

  it("n = 29 is insufficient, n = 30 shows nearest-rank percentiles", () => {
    expect(buildScenario({ split, nets: nets(29) }, "F4", "F4.v1", 30).insufficient_history).toBe(
      true,
    );
    const s = buildScenario({ split, nets: nets(30) }, "F4", "F4.v1", 30);
    expect(s.insufficient_history).toBe(false);
    // ranks ceil(3), ceil(15), ceil(27) of values i/100 -> 30,000 / 150,000 / 270,000 ppm
    expect([s.p10_ppm, s.p50_ppm, s.p90_ppm]).toEqual([30_000, 150_000, 270_000]);
  });

  it("is order independent and exact on unsorted, negative and unreduced fractions", () => {
    const rows = [
      { num: -5n, den: 100n },
      { num: 300n, den: 1_000n },
      { num: 0n, den: 7n },
      { num: 1n, den: 3n },
      { num: -1n, den: 50n },
    ];
    const sorted = [...rows].reverse();
    const a = buildScenario({ split, nets: rows }, "F4", "F4.v1", 1);
    const b = buildScenario({ split, nets: sorted }, "F4", "F4.v1", 1);
    expect(a).toEqual(b);
    expect(nearestRankPpm([{ num: 1n, den: 3n }], 50)).toBe(333_333);
    expect(a.p50_ppm).toBe(0); // rank 3 of 5 after sorting: -5 %, -2 %, 0, 30 %, 33.3 % -> 0
  });

  it("explains a missing or deferred split", () => {
    expect(buildScenario({ split: null, nets: [] }, "F4", "F4.v1", 30)).toMatchObject({
      insufficient_history: true,
      n: 0,
      reason: "no development replay yet",
    });
    const deferred = buildScenario(
      { split: { ...split, devEndD: null, deferredUntilD: "2031-06-30" }, nets: [] },
      "F4",
      "F4.v1",
      30,
    );
    expect(deferred.reason).toBe("splits deferred until 2031-06-30");
    expect(buildCard(inputs({ scenario: { split: null, nets: [] } })).footnote).toBe(
      "Development-split replay: no split yet, n 0.",
    );
  });
});

describe("thesis-breaker catalogue (design 4.5)", () => {
  const lv = { closeMicro: 1_000_000n, eventLowMicro: 900_000n };
  const ids = (family: Family, si = true): string[] =>
    applicableBreakers({ family, shortInterestAvailable: si }, params).map((b) => b.id);

  it("lists the applicable ones in catalogue order, at most the maximum", () => {
    expect(ids("F4")).toEqual(["TB-NEG", "TB-HALT", "TB-SMA"]);
    expect(ids("F1")).toEqual(["TB-NEG", "TB-HALT", "TB-RAISE", "TB-REGIME", "TB-SMA"]);
    expect(ids("F5")).toEqual(["TB-NEG", "TB-HALT", "TB-RAISE", "TB-EVLOW", "TB-REGIME"]);
    expect(ids("F2")).toEqual(["TB-NEG", "TB-HALT", "TB-RAISE", "TB-EVLOW", "TB-SI"]);
    expect(ids("F6")).toEqual(["TB-NEG", "TB-HALT", "TB-RAISE", "TB-SI", "TB-REGIME"]);
    for (const family of ["F1", "F2", "F3", "F4", "F5", "F6"] as const) {
      expect(ids(family).length).toBeGreaterThanOrEqual(params.thesisBreakersMin);
    }
  });

  it("does not list TB-SI when short interest is unavailable (DAT-125a)", () => {
    expect(ids("F6", false)).toEqual(["TB-NEG", "TB-HALT", "TB-RAISE", "TB-REGIME"]);
    expect(ids("F6", false).length).toBeGreaterThanOrEqual(params.thesisBreakersMin - 1);
    const card = buildCard(
      inputs({
        family: "F6",
        shortDrop: "unknown",
        candidate: { ...inputs().candidate, family: "F6" },
      }),
    );
    expect(card.thesis_breakers.map((b) => b.id)).not.toContain("TB-SI");
    expect(card.evidence.short_interest).toBe("unknown");
  });

  it("thresholds come from AgentParams; regime states depend on the family", () => {
    const f6 = cardBreakers({ family: "F6", shortInterestAvailable: true }, params, lv);
    expect(f6.find((b) => b.id === "TB-SI")).toMatchObject({
      rise_pp: `${params.f6.shortDropPp.num}/${params.f6.shortDropPp.den}`,
      sessions: params.windows.shortInterest,
    });
    expect(f6.find((b) => b.id === "TB-REGIME")!.states).toEqual(["RISK-OFF", "SHOCK"]);
    const f2 = cardBreakers({ family: "F2", shortInterestAvailable: true }, params, lv);
    expect(f2.find((b) => b.id === "TB-EVLOW")).toMatchObject({ level_micro: "900000" });
    const f1 = cardBreakers({ family: "F1", shortInterestAvailable: true }, params, lv);
    expect(f1.find((b) => b.id === "TB-SMA")!.period).toBe(params.windows.smaTrend);
  });

  it("amber level = trigger + 20 % of today's distance (AGT-111)", () => {
    expect(amberLevelMicro(1_000_000n, 900_000n, params.thesisAmberFraction)).toBe(920_000n);
    expect(amberLevelMicro(900_000n, 900_000n, params.thesisAmberFraction)).toBeNull();
    expect(BREAKER_CATALOGUE.map((b) => b.id)).toHaveLength(8);
  });
});

describe("card validator (AT-16)", () => {
  const built = (): { card: DecisionCard; inputs: CardInputs } => {
    const i = inputs({ scenario: { split, nets: nets(40) } });
    return { card: buildCard(i), inputs: i };
  };
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

  it("accepts a built card and rebuilds it byte for byte from its inputs", () => {
    const { card, inputs: i } = built();
    expect(validateCard(clone(card), params, i)).toEqual([]);
  });

  it("rejects schema violations: unknown or missing fields, wrong types, probabilities", () => {
    const { card } = built();
    const extra = { ...clone(card), probability_of_gain: 0.7 };
    expect(checkCard(extra, params).join()).toContain("unknown field");
    const nested = clone(card) as unknown as Record<string, Record<string, unknown>>;
    nested.scenario!.win_probability = 1;
    expect(checkCard(nested, params).join()).toMatch(/unknown field|probabilit/);
    const missing: Record<string, unknown> = clone(card) as never;
    delete missing.footnote;
    expect(checkCard(missing, params).join()).toContain("card.footnote: missing");
    const typed = { ...clone(card), taken: "yes" };
    expect(checkCard(typed, params).join()).toContain("boolean expected");
    expect(checkCard(null, params)).not.toEqual([]);
  });

  it("enforces the 3-5 breakers, catalogue order, the flag set and the scenario rules", () => {
    const { card } = built();
    const few = clone(card) as DecisionCard & { thesis_breakers: unknown[] };
    few.thesis_breakers = few.thesis_breakers.slice(0, 2);
    expect(checkCard(few, params).join()).toContain("thesis_breakers: 2 outside");
    const swapped = clone(card) as unknown as { thesis_breakers: unknown[] };
    swapped.thesis_breakers = [...swapped.thesis_breakers].reverse();
    expect(checkCard(swapped, params).join()).toContain("catalogue order");
    const flag = clone(card) as unknown as { evidence: { data_quality_flags: string[] } };
    flag.evidence.data_quality_flags = ["rumour"];
    expect(checkCard(flag, params)).not.toEqual([]);
    const low = clone(card) as unknown as { scenario: { n: number } };
    low.scenario.n = 12;
    expect(checkCard(low, params).join()).toContain("insufficient history");
    const unordered = clone(card) as unknown as { scenario: { p10_ppm: number } };
    unordered.scenario.p10_ppm = 999_999_999;
    expect(checkCard(unordered, params).join()).toContain("ordered");
    const note = clone(card) as unknown as { footnote: string };
    note.footnote = "Great upside expected.";
    expect(checkCard(note, params).join()).toContain("footnote");
  });

  it("every number in the card is produced by a field builder: any changed number is caught", () => {
    const { card, inputs: i } = built();
    const paths: (string | number)[][] = [];
    const walk = (v: unknown, path: (string | number)[]): void => {
      if (typeof v === "number" || (typeof v === "string" && /^-?\d+$/.test(v))) paths.push(path);
      else if (Array.isArray(v)) v.forEach((x, k) => walk(x, [...path, k]));
      else if (v !== null && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) walk(x, [...path, k]);
      }
    };
    walk(card, []);
    expect(paths.length).toBeGreaterThan(20);
    for (const path of paths) {
      const copy = clone(card);
      let holder: any = copy; // eslint-disable-line @typescript-eslint/no-explicit-any
      for (const k of path.slice(0, -1)) holder = holder[k];
      const last = path[path.length - 1]!;
      holder[last] = typeof holder[last] === "number" ? holder[last] + 1 : `${holder[last]}1`;
      expect(validateCard(copy, params, i), path.join(".")).not.toEqual([]);
    }
  });
});

describe("determinism", () => {
  it("the same inputs give the same bytes, sha and id; the id names signal and execution", () => {
    const a = finishCard(inputs());
    const b = finishCard(inputs());
    expect(b.json).toBe(a.json);
    expect(b.sha).toBe(a.sha);
    expect(a.sha).toMatch(/^[0-9a-f]{64}$/);
    expect(a.id).toBe(cardIdOf(inputs().signalId, "E07"));
    expect(JSON.parse(a.json)).toEqual(JSON.parse(JSON.stringify(buildCard(inputs()))));
    const other = finishCard(inputs({ executionId: "E08" }));
    expect(other.id).not.toBe(a.id);
    expect(other.sha).not.toBe(a.sha);
  });
});

describe("card note: rules-only by default, LLM text only when grounded", () => {
  const card = buildCard(inputs({ scenario: { split, nets: nets(40) } }));

  it("the rules-only text is grounded in the card (no number the card lacks)", () => {
    expect(checkGrounding(rulesNoteText(card), card)).toEqual({ ok: true, missing: [] });
    const short = buildCard(inputs({ scenario: { split, nets: nets(12) } }));
    expect(checkGrounding(rulesNoteText(short), short).ok).toBe(true);
    expect(rulesNoteText(short)).toContain("insufficient history");
  });

  it("without a router, or in mode off / rules-only, the note is the template", async () => {
    const plain = await cardNote(card);
    expect(plain).toMatchObject({
      kind: CARD_NOTE_KIND,
      provider: null,
      fallback_depth: "rules-only",
      tokens_in: 0,
    });
    expect(plain.text).toBe(rulesNoteText(card));
    for (const mode of ["off", "rules-only"] as const) {
      const { router } = makeRouter(mode, [mockProvider({})]);
      expect((await cardNote(card, router)).text).toBe(rulesNoteText(card));
    }
  });

  function fixture(answer: string) {
    const req = noteRequest(card);
    const sha = promptSha(
      req.role,
      MOCK_MODEL,
      CARD_TEMPLATE_VERSION,
      buildPrompt(req.task, req.facts, [], false),
    );
    return { [sha]: { text: JSON.stringify({ text: answer }), tokensIn: 200, tokensOut: 40 } };
  }

  it("mock mode returns a grounded fixture answer and records provider and tokens", async () => {
    const text = `${card.code} is an oversold ${card.family} setup; the scenario has n ${card.scenario.n}.`;
    const { router } = makeRouter("mock", [mockProvider(fixture(text))]);
    const note = await cardNote(card, router);
    expect(note.text).toBe(text);
    expect(note.provider).toBe("mock");
    expect(note).toMatchObject({ tokens_in: 200, tokens_out: 40 });
    expect(note.prompt_sha).toMatch(/^[0-9a-f]{64}$/);
  });

  it("mock mode rejects an answer with a number that is not on the card (falls back)", async () => {
    const { router } = makeRouter("mock", [
      mockProvider(fixture(`${card.code} should gain 41.7 percent.`)),
    ]);
    const note = await cardNote(card, router);
    expect(note.provider).toBeNull();
    expect(note.text).toBe(rulesNoteText(card));
  });

  it("a mock without a recorded answer falls back to the template", async () => {
    const { router } = makeRouter("mock", [mockProvider({})]);
    expect((await cardNote(card, router)).fallback_depth).toBe("rules-only");
  });
});

describe("scenario lookup from the development ledger (decision 21)", () => {
  async function seed(db: Client, signals: number, devEnd: string | null): Promise<void> {
    await db.execute({
      sql: "INSERT INTO lineage (id, created_d, parent) VALUES ('AU:F4', '2030-01-01', NULL)",
      args: [],
    });
    await db.execute({
      sql: `INSERT INTO lineage_split (lineage_id, version, block_sessions, holdout_len,
              validation_len, purge, data_end_d, holdout_start_d, holdout_end_d, validation_start_d,
              validation_end_d, dev_end_d, deferred_until_d, reason, measured_on_run)
            VALUES ('AU:F4', 1, 5, 100, 100, 50, '2030-12-31', ?, ?, ?, ?, ?, ?, 'create', NULL)`,
      args:
        devEnd === null
          ? [null, null, null, null, null, "2031-06-30"]
          : ["2030-10-01", "2030-12-31", "2030-06-01", "2030-09-30", devEnd, null],
    });
    for (let i = 0; i < signals; i++) {
      const d = `2030-03-${String((i % 28) + 1).padStart(2, "0")}`;
      const code = `ZZ${String(i).padStart(2, "0")}`;
      const id = `sig:AU:${d}:F4:F4.v1:F4:${code}`;
      await db.execute({
        sql: `INSERT INTO signal (id, market, d, family, rule_version, variant, code, regime,
                rank_score, rules_json, evidence_json, classes, group_key, partial, schema_version,
                agent_version, inputs_ref, decided_at)
              VALUES (?, 'AU', ?, 'F4', 'F4.v1', 'F4', ?, 'RISK-ON', '0', '[]', '{}', NULL, NULL,
                0, 1, 'a', 'r', ?)`,
        args: [id, d, code, `${d}T07:00:00.000Z`],
      });
      await db.execute({
        sql: `INSERT INTO ledger_row (id, signal_id, group_key, entry_d, qty, fill_in_micro,
                brok_in_micro, stress_in_micro, timed, forward)
              VALUES (?, ?, NULL, ?, 100, 1000000, 0, 1000000, 1, 0)`,
        args: [`lr:${id}`, id, d],
      });
      await db.execute({
        sql: `UPDATE ledger_row SET exit_d = ?, exit_tag = 'CS', fill_out_micro = ?,
                brok_out_micro = 0, stress_out_micro = 1000000, gross_num = 1, gross_den = 1
              WHERE id = ?`,
        args: [d, 1_000_000 + (i + 1) * 10_000, `lr:${id}`],
      });
    }
  }
  const q = { market: "AU", family: "F4", ruleVersion: "F4.v1", variant: "F4" };

  it("n = 12 development rows: insufficient history", async () => {
    const db = await freshReplayDb();
    await seed(db, 12, "2030-09-30");
    const scen = await loadScenarioInput(db, q);
    expect(scen.nets).toHaveLength(12);
    expect(scen.split).toMatchObject({ version: 1, asOfD: "2030-12-31" });
    const card = buildCard(inputs({ scenario: scen }));
    expect(card.scenario).toMatchObject({ insufficient_history: true, n: 12, reason: "n < 30" });
  });

  it("n = 36: percentiles of the exact net returns; other variants and later rows are excluded", async () => {
    const db = await freshReplayDb();
    await seed(db, 36, "2030-09-30");
    const scen = await loadScenarioInput(db, q);
    expect(scen.nets).toHaveLength(36);
    const s = buildScenario(scen, "F4", "F4.v1", 30);
    // net of row i = (100 x (1,000,000 + 10,000 i) - 100 x 1,000,000) / (100 x 1,000,000) = i %
    // nearest ranks 4, 18, 33 of 36 -> 4 %, 18 %, 33 %
    expect([s.p10_ppm, s.p50_ppm, s.p90_ppm]).toEqual([40_000, 180_000, 330_000]);
    expect((await loadScenarioInput(db, { ...q, variant: "F4-other" })).nets).toHaveLength(0);
  });

  it("rows entered after the development end are not development rows; no split / deferred split", async () => {
    const db = await freshReplayDb();
    await seed(db, 36, "2030-03-10"); // only entries up to 10 March count
    const scen = await loadScenarioInput(db, q);
    expect(scen.nets.length).toBeGreaterThan(0);
    expect(scen.nets.length).toBeLessThan(36);
    const none = await freshReplayDb();
    expect(await loadScenarioInput(none, q)).toEqual({ split: null, nets: [] });
    const deferred = await freshReplayDb();
    await seed(deferred, 3, null);
    const d = await loadScenarioInput(deferred, q);
    expect(d.nets).toHaveLength(0);
    expect(buildScenario(d, "F4", "F4.v1", 30).reason).toBe("splits deferred until 2031-06-30");
  });
});
