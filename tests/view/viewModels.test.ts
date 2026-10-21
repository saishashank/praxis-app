// @vitest-environment node
// The masked view models (DAT-124, ROL-107, UX-009; D-128): the card, the Evening Review and the alert
// inbox. Each test fails if an unmasked code, company name, price, link or exact date reaches a masked
// context, and checks that the unmasked context still shows the real values.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import type { DecisionCard } from "@/lib/agents/cards";
import type { AlertView } from "@/lib/alerts/api";
import type { ReviewFacts } from "@/lib/email/templates/review";
import {
  activeCodesByDate,
  activeCodesForDate,
  melbourneDate,
  orderCodesByDate,
  signalCodesByDate,
} from "@/lib/view/active";
import {
  isOpaqueAlertKey,
  maskAlertViews,
  publicAlertKey,
  resolveAlertKey,
} from "@/lib/view/alerts";
import { cardViewModel } from "@/lib/view/cards";
import {
  findLeaks,
  loadMaskLookup,
  StockAliases,
  UNKNOWN_STOCK,
  type MaskLookup,
} from "@/lib/view/mask";
import { factCodes, maskedReview, parseFacts, reviewLeaks } from "@/lib/view/reviews";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const CODES = ["ZZUP", "ZZDN", "ZZOTH"];
const NAMES = ["Zed Upward Holdings", "Zed Downward Mining", "Zed Other Group"];
const lookup: MaskLookup = {
  known: new Set(CODES),
  names: new Map(CODES.map((c, i) => [c, NAMES[i]!])),
};
const aliases = new StockAliases(["ZZUP", "ZZDN"]);

function card(over: Partial<DecisionCard> = {}): DecisionCard {
  return {
    v: 1,
    market: "AU",
    d: "2026-10-19",
    code: "ZZUP",
    family: "F1",
    execution: "E01",
    rule_version: "F1.v1",
    variant: "F1",
    regime: "NEUTRAL",
    taken: false,
    not_taken_reason: "ZZDN is held; see https://x.example.test/a",
    thesis: "Zed Upward Holdings (ZZUP) broke out at A$12.34 on 2026-10-16.",
    rules_fired: [{ rule: "R1 vs ZZDN", value: "A$3.20", threshold: "$2", pass: true }],
    rank_score: "1",
    evidence: {
      events: [],
      insider_flow: "unknown",
      short_interest: "unknown",
      data_quality_flags: [],
      other_flags: [],
    },
    thesis_breakers: [{ id: "TB-NEG", check: "ZZOTH announces a halt" }],
    exit_plan: [{ rule: "stop at A$11.00", tag: "IS", via: null, kind: "stop", detail: {} }],
    sizing: {
      available: true,
      accepted: true,
      reasons: [],
      qty: "100",
      fill_price_micro: "12340000",
      order_value_micro: "1234000000",
      half_size: false,
    },
    cost: {
      available: true,
      reason: null,
      entry_brokerage_micro: "9500000",
      entry_slippage_micro: "0",
      exit_brokerage_micro: "9500000",
      exit_slippage_micro: "0",
      cost_estimate_micro: "19000000",
      order_value_micro: "1234000000",
      break_even_ppm: 15_400,
    },
    scenario: {
      insufficient_history: false,
      n: 41,
      reason: null,
      p10_ppm: -50_000,
      p50_ppm: 12_000,
      p90_ppm: 90_000,
      split_version: 1,
      as_of_roll_d: "2026-10-16",
      variant: "F1",
      rule_version: "F1.v1",
    },
    footnote: "Simulation only; ZZUP data to 2026-10-16.",
    ...over,
  } as DecisionCard;
}

describe("cardViewModel", () => {
  const note = { text: "ZZUP looks strong at $12.34.", provider: "x" };

  it("masked: no code, name, price, amount, link or exact date anywhere in the view", () => {
    const v = cardViewModel(card(), note, { masked: true }, aliases, lookup);
    expect(findLeaks(v, CODES, NAMES)).toEqual([]);
    const text = JSON.stringify(v);
    expect(text).not.toMatch(/12\.34|1,234|11\.00|A\$3\.20|\$2\b|example\.test|2026-10-1/);
    expect(v.title).toBe("Decision Card: Stock B (E01)");
    expect(v.stock).toBe("Stock B");
    expect(v.subtitle).toContain("2026-W43");
    expect(v.thesis).toContain("Stock B");
    expect(v.sizing).toContain("Quantity 100");
    expect(v.sizing).toContain("Break-even 1.54%");
    expect(v.note?.wording).toBe("(AI wording.)");
    expect(v.scenario).toContain("p10 -5.00%");
  });

  it("masked: a code outside the active set is never lettered by guesswork", () => {
    const v = cardViewModel(card({ code: "ZZOTH" }), null, { masked: true }, aliases, lookup);
    expect(v.stock).toBe(UNKNOWN_STOCK);
    expect(v.title).not.toContain("ZZOTH");
  });

  it("masked: insufficient history and unavailable sizing/cost keep their wording", () => {
    const v = cardViewModel(
      card({
        scenario: { ...card().scenario, insufficient_history: true, reason: "n < 30" },
        sizing: { ...card().sizing, available: false },
        cost: { ...card().cost, available: false, reason: "no ZZDN price" },
      }),
      null,
      { masked: true },
      aliases,
      lookup,
    );
    expect(v.scenario).toBe("Insufficient history (n < 30).");
    expect(v.sizing).toContain("Sizing was not available.");
    expect(v.sizing).toContain("Cost not available (no Stock A price)");
    expect(findLeaks(v, CODES, NAMES)).toEqual([]);
  });

  it("unmasked: the real values, amounts and date", () => {
    const v = cardViewModel(card(), note, { masked: false }, aliases, lookup);
    expect(v.title).toBe("Decision Card: ZZUP (E01)");
    expect(v.subtitle).toContain("2026-10-19");
    expect(v.thesis).toContain("ZZUP");
    expect(v.sizing).toContain("A$12.34");
    expect(v.sizing).toContain("A$1,234.00");
    expect(v.sizing).toContain("A$19.00");
    expect(v.note?.text).toContain("ZZUP");
  });

  it("missing numbers show n/a, never zero", () => {
    const v = cardViewModel(
      card({
        sizing: { ...card().sizing, qty: null, fill_price_micro: null, order_value_micro: null },
        scenario: { ...card().scenario, p10_ppm: null, p50_ppm: null, p90_ppm: null },
      }),
      null,
      { masked: false },
      aliases,
      lookup,
    );
    expect(v.sizing).toContain("Quantity n/a at n/a");
    expect(v.scenario).toContain("p10 n/a");
  });
});

describe("maskedReview", () => {
  const facts = {
    variant: "full",
    env: "production",
    date: "2026-10-19",
    appUrl: "https://praxis.example.test",
    arenaActive: true,
    executions: [
      { id: "E01", label: "F1 U", currency: "AUD", dayPlCents: 12345, navCents: 1 },
      { id: "E02", label: "ZZUP follower", currency: "AUD", dayPlCents: -50, navCents: 1 },
    ],
    scorecard: { healthyComponents: 9, totalComponents: 10, attention: [] },
    orders: [
      {
        executionId: "E01",
        state: "filled",
        side: "buy",
        code: "ZZUP",
        qty: 100,
        priceCents: 1234,
        costsCents: 950,
        currency: "AUD",
        stopCents: 1100,
        targetCents: 1500,
        reason: "ZZUP broke out; Zed Upward Holdings at $12.34",
        cardPath: "/cards/card%3Asig%3A2026-10-19%3AZZUP%3AE01",
      },
    ],
    narrative: {
      kind: "rules",
      s4: ["ZZDN fell on 2026-10-19"],
      s5: ["Zed Downward Mining recovered"],
      s6: ["Review https://news.example.test/x"],
    },
    stats: null,
    alerts: [
      {
        tier: "P1",
        code: "ZZOTH",
        title: "Zed Other Group halt",
        time: "10:00",
        effect: "ZZOTH held",
        url: "https://ann.example.test/1",
      },
    ],
    breakerHits: [{ execution: "E01", breaker: "TB-NEG on ZZUP", effect: "exit ZZUP" }],
    health: [{ label: "Prices", status: "ok", detail: "ZZDN feed ok" }],
    suppressedEmails: 0,
    regimeNotice: "Regime for ZZUP changed",
  } as unknown as ReviewFacts;

  it("lists every code of the facts for the active set", () => {
    expect(factCodes(facts).sort()).toEqual(["ZZOTH", "ZZUP"]);
  });

  it("masked view has no code, name, price, stop, target, cost, link or exact date", () => {
    const al = new StockAliases(["ZZUP", "ZZDN", ...factCodes(facts)]);
    const v = maskedReview(facts, al, lookup);
    expect(findLeaks(v, CODES, NAMES)).toEqual([]);
    expect(reviewLeaks(v, al.codes(), NAMES)).toBe(false);
    const text = JSON.stringify(v);
    expect(text).not.toMatch(/12\.34|1234|1100|1500|950|example\.test|2026-10-19/);
    expect(text).toContain("BUY Stock C"); // ZZDN=A, ZZOTH=B, ZZUP=C
    expect(v.orders[0]).toContain("quantity 100 (filled)");
    expect(v.summary[0]).toBe("E01 F1 U: day profit/loss +A$123.45");
    expect(v.summary[1]).toBe("E02 Stock C follower: day profit/loss -A$0.50");
    expect(v.narrative.map((n) => n.heading)).toEqual([
      "What was learned today",
      "What worked better and why",
      "What needs improving for tomorrow",
    ]);
    expect(v.alerts[0]).toContain("P1 Stock B");
    expect(v.health[0]).toBe("Prices: ok. Stock A feed ok");
  });

  it("the backstop catches a code that slipped through", () => {
    const al = new StockAliases(["ZZUP"]);
    const v = maskedReview(facts, al, lookup);
    v.orders.push("Order for ZZUP");
    expect(reviewLeaks(v, ["ZZUP"], [])).toBe(true);
    expect(reviewLeaks(v, ["ZZUP"], ["order for"])).toBe(true);
  });

  it("survives garbage facts without throwing", () => {
    expect(parseFacts("nope")).toBeNull();
    expect(parseFacts("[1]")).toBeNull();
    const v = maskedReview(
      {
        orders: "x",
        alerts: [1, null],
        executions: [{}],
        narrative: 5,
        health: {},
      } as unknown as ReviewFacts,
      aliases,
      lookup,
    );
    expect(v.orders).toEqual([]);
    expect(v.alerts).toEqual([]);
  });
});

describe("alerts: active sets, opaque keys and masking", () => {
  let main: Client;
  beforeEach(async () => {
    main = await freshDb("main");
    await main.execute(
      "INSERT INTO instrument (market, code, name) VALUES ('AU','ZZUP','Zed Upward Holdings'), ('AU','ZZDN','Zed Downward Mining'), ('AU','ZZOTH','Zed Other Group')",
    );
    const sig = (id: string, d: string, code: string) =>
      main.execute({
        sql: `INSERT INTO signal (id, market, d, family, rule_version, variant, code, regime, rank_score, rules_json,
                evidence_json, schema_version, agent_version, inputs_ref, decided_at)
              VALUES (?, 'AU', ?, 'F1', 'F1.v1', 'F1', ?, 'NEUTRAL', '1', '[]', '{}', 1, 'a1', 'x', ?)`,
        args: [id, d, code, `${d}T08:00:00.000Z`],
      });
    await sig("s1", "2026-10-19", "ZZUP");
    await sig("s2", "2026-10-19", "ZZDN");
    await sig("s3", "2026-10-16", "ZZOTH");
  });

  const alertRow = (key: string, code: string | null, at: string, kind = "announcement") =>
    main.execute({
      sql: `INSERT INTO alert (alert_key, market, code, kind, tier, detected_at, facts_json)
            VALUES (?, 'AU', ?, ?, 'P1', ?, '{"rule":"r","why":"w","executions":[]}')`,
      args: [key, code, kind, at],
    });
  const view = (over: Partial<AlertView>): AlertView => ({
    key: "ann:AU:s:1",
    tier: "P1",
    kind: "announcement",
    market: "AU",
    code: "ZZUP",
    text: "P1: Announcement on ZZUP: Zed Upward Holdings update at https://a.example.test",
    why: "ZZDN is held",
    executions: [{ id: "E01", label: "ZZUP follower", weightPct: 10 }],
    detectedAt: "2026-10-19T01:00:00.000Z",
    publishedAt: null,
    ackedAt: null,
    snoozedUntil: null,
    ...over,
  });

  it("melbourneDate maps a UTC instant to the Melbourne calendar date", () => {
    expect(melbourneDate("2026-10-19T01:00:00.000Z")).toBe("2026-10-19");
    expect(melbourneDate("2026-10-19T14:00:00.000Z")).toBe("2026-10-20"); // AEDT is UTC+11
    expect(melbourneDate("2026-06-30T14:00:00.000Z")).toBe("2026-07-01"); // AEST is UTC+10
    expect(melbourneDate("x")).toBeNull();
    expect(melbourneDate(null)).toBeNull();
  });

  it("the active set of a date is its signals, orders and alerts, and no other date's", async () => {
    await alertRow("ann:AU:s:9", "ZZOTH", "2026-10-19T02:00:00.000Z");
    expect([...(await activeCodesForDate(main, "AU", "2026-10-19"))].sort()).toEqual([
      "ZZDN",
      "ZZOTH",
      "ZZUP",
    ]);
    expect([...(await activeCodesForDate(main, "AU", "2026-10-16"))]).toEqual(["ZZOTH"]);
    expect(
      [...(await signalCodesByDate(main, "AU", "2026-10-16", "2026-10-19")).keys()].sort(),
    ).toEqual(["2026-10-16", "2026-10-19"]);
    expect((await orderCodesByDate(main, "2026-10-01", "2026-10-31")).size).toBe(0);
    expect((await activeCodesByDate(main, "XX", "2026-10-19", "2026-10-19")).size).toBe(0);
  });

  it("letters follow the date: the same stock can have different letters on different dates, never two stocks one letter", async () => {
    await alertRow("ann:AU:s:1", "ZZUP", "2026-10-19T01:00:00.000Z");
    await alertRow("ann:AU:s:2", "ZZOTH", "2026-10-16T01:00:00.000Z");
    await alertRow("ann:AU:s:3", "ZZUP", "2026-10-16T02:00:00.000Z");
    const out = await maskAlertViews(main, [
      view({ key: "ann:AU:s:1", code: "ZZUP", detectedAt: "2026-10-19T01:00:00.000Z" }),
      view({ key: "ann:AU:s:2", code: "ZZOTH", detectedAt: "2026-10-16T01:00:00.000Z" }),
      view({ key: "ann:AU:s:3", code: "ZZUP", detectedAt: "2026-10-16T02:00:00.000Z" }),
    ]);
    // 19th: ZZDN=A, ZZUP=B. 16th: ZZOTH=A, ZZUP=B.
    expect(out.map((a) => a.code)).toEqual(["Stock B", "Stock A", "Stock B"]);
    expect(findLeaks(out, CODES, NAMES)).toEqual([]);
  });

  it("masks text, why and execution labels; drops links, names, prices", async () => {
    const out = await maskAlertViews(main, [view({})]);
    const a = out[0]!;
    expect(a.text).toBe("P1: Announcement on Stock B: Stock B update at [link hidden]");
    expect(a.why).toBe("Stock A is held");
    expect(a.executions[0]!.label).toBe("Stock B follower");
    expect(a.executions[0]!.weightPct).toBe(10);
    expect(findLeaks(out, CODES, NAMES)).toEqual([]);
    expect(await maskAlertViews(main, [])).toEqual([]);
  });

  it("a row with an unreadable date or a code outside the lookups never shows the code", async () => {
    const out = await maskAlertViews(main, [
      view({ code: "ZZGHOST", detectedAt: "garbage", text: "t ZZGHOST" }),
      view({ code: null, text: "regime change" }),
    ]);
    expect(out[0]!.code).toMatch(/^Stock [A-Z]+$/); // its own set holds at least itself
    expect(out[1]!.code).toBeNull();
  });

  it("code-bearing keys become opaque and resolve back; other keys are unchanged", async () => {
    const proxy = "proxy:AU:ZZUP:2026-10-19";
    const tb = "tb:sig-ZZUP:TB-NEG:2026-10-19";
    await alertRow(proxy, "ZZUP", "2026-10-19T01:00:00.000Z", "halt_proxy");
    await alertRow(tb, "ZZUP", "2026-10-19T01:00:00.000Z", "thesis_breaker");
    const now = new Date("2026-10-20T00:00:00.000Z");
    for (const k of [proxy, tb]) {
      const pub = publicAlertKey(k);
      expect(pub).toMatch(/^mk:[0-9a-f]{16}$/);
      expect(isOpaqueAlertKey(pub)).toBe(true);
      expect(pub).not.toContain("ZZ");
      expect(await resolveAlertKey(main, pub, now)).toBe(k);
    }
    expect(publicAlertKey(proxy)).not.toBe(publicAlertKey(tb));
    for (const k of ["ann:AU:s:1", "regime:AU:2026-10-19", "preopen:AU:2026-10-19"]) {
      expect(publicAlertKey(k)).toBe(k);
      expect(await resolveAlertKey(main, k, now)).toBe(k);
    }
    expect(await resolveAlertKey(main, "mk:0000000000000000", now)).toBeNull();
    // Older than the window: not resolvable.
    expect(
      await resolveAlertKey(main, publicAlertKey(proxy), new Date("2027-06-01T00:00:00Z")),
    ).toBeNull();
  });

  it("loadMaskLookup returns every instrument code and name of the market", async () => {
    const l = await loadMaskLookup(main, "AU");
    expect([...l.known].sort()).toEqual(["ZZDN", "ZZOTH", "ZZUP"]);
    expect(l.names.get("ZZUP")).toBe("Zed Upward Holdings");
    expect((await loadMaskLookup(main, "XX")).known.size).toBe(0);
  });
});
