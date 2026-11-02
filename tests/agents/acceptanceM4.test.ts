// @vitest-environment node
// M4 acceptance tests AT-14, AT-15, AT-16 and AT-17, TST-109 over batch 2b (M4 T17).
// One describe per AT. Each test asserts the criterion of the AT row in spec/14_system_acceptance.md
// with the existing harnesses (the batch 2b night harness, the family builders, the ledger world,
// the statistics library) and, where a heavier test already covers the same criterion in depth, the
// title names that test. Everything is synthetic (ZZ codes, a calendar in 2030, invented numbers).
// Real-data null runs and the staging run (TST-115) are not CI tests: see docs/M4_exit_evidence.md.
import type { Client } from "@libsql/client";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { reviewDay, type ReviewResult } from "@/lib/agents/batch3";
import { buildScenario, checkCard, type DecisionCard } from "@/lib/agents/cards";
import { LookAheadError, createDecisionView, decisionCutoffUtc } from "@/lib/agents/decisionView";
import { evaluateExit, gapCancelLevel, runFamilies } from "@/lib/agents/families";
import { compareToFixture, parseTaLibFixture } from "@/lib/agents/indicators";
import { defaultAgentParams } from "@/lib/agents/params";
import { stepRegime } from "@/lib/agents/regime";
import { effectiveN } from "@/lib/arena/cohort";
import { mapPlanForControl } from "@/lib/replay/controlLibrary";
import { aalenJohansen } from "@/lib/replay/cif";
import { replayLedger, type LedgerResult } from "@/lib/replay/ledger";
import {
  INJECTED_SPEC,
  fewBlocksCheck,
  sizeReport,
  syntheticBatch,
  syntheticRows,
  testRows,
} from "@/lib/replay/nullRuns";
import { runReplay } from "@/lib/replay/runner";
import { buildSnapshot } from "@/lib/replay/snapshot";
import {
  bootstrapReplications,
  deflatedSharpeRatio,
  minimumDetectableEffect,
  probabilityOfBacktestOverfitting,
  scopedPrng,
  uniform01,
  validationLevel,
} from "@/lib/stats";
import { delistingSensitivity, survivorshipSeries } from "@/lib/stats/survivorship";
import { cleanupTempDbs } from "../db/helpers";
import {
  CENT,
  DOLLAR,
  dayAgo,
  ev,
  factsOf,
  inputsOf,
  makeBars,
  override,
  peers,
  position,
  rising,
  volumes,
  wobble,
} from "../fixtures/agents/families/builders";
import { buildWorld, SESSIONS, type WorldCode } from "../fixtures/replay/ledgerWorld";
import { PARAMS as STATS_PARAMS, weekdayCalendar } from "../fixtures/stats/t13";
import { makeRouter, mockProvider } from "../llm/helpers";
import {
  DATES,
  MARKET,
  NOW,
  buildNight,
  dump,
  freshReplayDb,
  runNights,
  setMode,
  startCohortsAt,
  testParams,
} from "./batch2bHarness";
import { D, goldenCodes } from "./batch2bScenario";

vi.setConfig({ testTimeout: 120000, hookTimeout: 240000 });
afterAll(cleanupTempDbs);

type Row = Record<string, unknown>;
const rows = async (db: Client, sql: string, args: (string | number)[] = []): Promise<Row[]> =>
  (await db.execute({ sql, args })).rows.map((r) => ({ ...r }));
const d = (i: number): string => DATES[i]!;

// ---------------------------------------------------------------------------------------------
// The night: ten synthetic U1 codes of the batch 2b golden scenario (F4 dips on ZZD1/ZZD2, an F1
// breakout on ZZUP), 330 sessions of bars, the decision night is session 300 (D).
// A: clean future, every LLM off (rules-only router).      -> AT-14, AT-16
// M: clean future, the LLM mock router (no recorded answer). -> AT-14 identity with A
// P: every row after D poisoned, mock router.               -> TST-109 (compared with A)
// ---------------------------------------------------------------------------------------------
const params = testParams();
const KEEP = ["E01", "E07", "C2-F1", "C2-F4"];
const FILLERS = ["ZZ00", "ZZ01", "ZZ02", "ZZ03", "ZZ04", "ZZ05"];
const NIGHT_CODES = goldenCodes().filter((c) =>
  ["ZZD1", "ZZD2", "ZZD3", "ZZUP", ...FILLERS].includes(c.code),
);
const DECISION_TABLES = [
  "signal",
  "arena_order",
  "stop_level",
  "c2_selection",
  "regime_daily",
  "decision_card",
  "card_note",
  "event",
  "insider_flow_score",
  "trade",
  "fill",
];
const snapshot = (db: Client): Promise<string[]> =>
  Promise.all(DECISION_TABLES.map((t) => dump(db, `SELECT * FROM ${t} ORDER BY 1, 2, 3`)));

type Night = {
  readonly db: Client;
  readonly tables: string[];
  readonly reviews: Map<string, ReviewResult>;
  readonly signalStatus: string[];
  readonly llmRows: readonly { provider: string; fallbackDepth: string | null }[];
};

async function night(opts: {
  mode: "rules-only" | "mock";
  poisonAfter?: number;
  review?: boolean;
}): Promise<Night> {
  const db = await freshReplayDb();
  await buildNight(db, { codes: NIGHT_CODES, poisonAfter: opts.poisonAfter });
  if (opts.poisonAfter !== undefined) {
    // an announcement and a short-interest point published after D's cut-off, and a split whose
    // ex-date is after D: none of them may reach a decision for D
    await db.execute({
      sql: `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, price_sensitive, title, url, source)
            VALUES (?, 'ZZ05', 'POISON-1', ?, ?, NULL, 1, 'Upgrades earnings guidance', NULL, 'synthetic')`,
      args: [MARKET, `${d(D)}T09:00:00.000Z`, `${d(D)}T09:01:00.000Z`],
    });
    await db.execute({
      sql: `INSERT INTO short_interest (market, code, as_of, short_ppm, published_at, ingested_at, assumed_time, source)
            VALUES (?, 'ZZ05', ?, 90000, ?, ?, 0, 'synthetic')`,
      args: [MARKET, d(D - 1), `${d(D)}T09:00:00.000Z`, `${d(D)}T09:01:00.000Z`],
    });
  }
  await setMode(db, "full");
  await startCohortsAt(db, 295, KEEP);
  const { router, store } = makeRouter(opts.mode, opts.mode === "mock" ? [mockProvider({})] : []);
  const reviews = new Map<string, ReviewResult>();
  const run = await runNights(
    db,
    params,
    295,
    D,
    opts.review === true
      ? async (day) => {
          reviews.set(
            day,
            await reviewDay(db, { market: MARKET, d: day, replay: true, now: NOW, params }),
          );
        }
      : undefined,
    { llm: router },
  );
  return {
    db,
    tables: await snapshot(db),
    reviews,
    signalStatus: [...run.signals.values()].map((s) => s.status),
    llmRows: store.rows.map((r) => ({ provider: r.provider, fallbackDepth: r.fallbackDepth })),
  };
}

let A: Night;
let M: Night;
let P: Night;
beforeAll(async () => {
  A = await night({ mode: "rules-only", review: true });
  M = await night({ mode: "mock" });
  P = await night({ mode: "mock", poisonAfter: D });
});

// ---------------------------------------------------------------------------------------------
describe("AT-14: rules-only mode (AGT-001, LLM-002)", () => {
  it("with every LLM off a full night produces signals, orders, Decision Cards and review numbers", async () => {
    expect(A.signalStatus.every((s) => s === "success")).toBe(true);
    const n = async (sql: string): Promise<bigint> => (await rows(A.db, sql))[0]!.n as bigint;
    expect(await n("SELECT COUNT(*) AS n FROM signal")).toBeGreaterThan(0n);
    expect(await n("SELECT COUNT(*) AS n FROM arena_order WHERE kind = 'entry'")).toBeGreaterThan(
      0n,
    );
    expect(await n("SELECT COUNT(*) AS n FROM decision_card")).toBeGreaterThan(0n);
    const review = A.reviews.get(d(D))!;
    expect(review.status).toBe("success"); // batch 3: the review numbers
    expect(review.stats.statRows).toBeGreaterThan(0);
    expect(await n("SELECT COUNT(*) AS n FROM replay_stat")).toBeGreaterThan(0n);
  });

  it("the router answered rules-only everywhere (provider and fallback depth recorded)", () => {
    expect(A.llmRows.length).toBeGreaterThan(0);
    for (const r of A.llmRows)
      expect(r).toEqual({ provider: "rules-only", fallbackDepth: "rules-only" });
  });

  it("the LLM mock changes no signal, order, stop, control, card or note byte (AGT-011a; covered in depth by tests/llm/router.test.ts 'AT-14: mock vs off identity' and batch2bCards 'LLM router wired in')", () => {
    expect(M.signalStatus).toEqual(A.signalStatus);
    expect(M.tables).toEqual(A.tables);
    expect(A.tables[0]).not.toBe("[]"); // not vacuous
  });

  it("the cards and notes are stored with no provider: LLM text is never a decision input", async () => {
    const notes = await rows(A.db, "SELECT provider, fallback_depth FROM card_note");
    expect(notes.length).toBeGreaterThan(0);
    for (const n of notes) expect(n).toEqual({ provider: null, fallback_depth: "rules-only" });
  });
});

// ---------------------------------------------------------------------------------------------
describe("AT-15: family rules and regime gates (spec 7.4, AGT-101)", () => {
  const p = defaultAgentParams();
  type Regime = "RISK-ON" | "NEUTRAL" | "RISK-OFF" | "SHOCK";
  const ALL: Regime[] = ["RISK-ON", "NEUTRAL", "RISK-OFF", "SHOCK"];

  // One golden world per family (the same builders and numbers as tests/agents/families/*).
  const oversold = (i: number): bigint => {
    const base = rising(CENT)(Math.min(i, 296));
    return (base * (100n - 4n * BigInt(Math.max(0, i - 296)))) / 100n;
  };
  const f5Bars = factsOf(
    "ZZS",
    "U2",
    makeBars({
      close: () => DOLLAR,
      volume: volumes(1_000_000n, 4_000_000n),
      spread: 2n * CENT,
      last: { open: DOLLAR, high: 1_060_000n, low: DOLLAR, close: 1_050_000n },
    }),
    p,
  );
  const eventCode = () => factsOf("ZZE", "U1", makeBars({ close: wobble(2n * DOLLAR) }), p);
  const leader = (extra = {}) =>
    override(
      factsOf(
        "ZZA",
        "U1",
        makeBars({ close: rising(CENT), volume: volumes(1_000_000n, 2_000_000n) }),
        p,
      ),
      extra,
    );
  const GOLDEN = {
    F1: (regime: Regime) =>
      inputsOf(
        [
          factsOf(
            "ZZA",
            "U1",
            makeBars({ close: rising(CENT), volume: volumes(1_000_000n, 2_000_000n) }),
            p,
          ),
          ...peers("ZZP", "U1", 9, p),
        ],
        { regime },
      ),
    F2: (regime: Regime) =>
      inputsOf([eventCode()], {
        regime,
        events: [
          ev({ code: "ZZE", category: "results", polarity: 1, ar: "0.03", day0: dayAgo(2) }),
        ],
      }),
    F3: (regime: Regime) =>
      inputsOf([eventCode()], {
        regime,
        events: [ev({ code: "ZZE", category: "results", polarity: 1, ar: "0.04", vol: "2" })],
      }),
    F4: (regime: Regime) =>
      inputsOf([factsOf("ZZD", "U1", makeBars({ close: oversold }), p)], { regime }),
    F5: (regime: Regime) =>
      inputsOf([f5Bars], {
        regime,
        events: [ev({ code: "ZZS", category: "contract_win", polarity: 1, ar: "0.05", vol: "4" })],
      }),
    F6: (regime: Regime) =>
      inputsOf([...[leader({ insiderScoreQ: 2, shortDrop: true })], ...peers("ZZP", "U1", 9, p)], {
        regime,
      }),
  } as const;
  // spec 7.4 "Regime gate" column: the states in which the family may open a position
  const OPEN_IN: Record<keyof typeof GOLDEN, readonly Regime[]> = {
    F1: ["RISK-ON", "NEUTRAL"],
    F2: ["RISK-ON", "NEUTRAL", "RISK-OFF"],
    F3: ["RISK-ON", "NEUTRAL", "RISK-OFF"],
    F4: ALL,
    F5: ["RISK-ON", "NEUTRAL"],
    F6: ["RISK-ON", "NEUTRAL"],
  };
  // spec 7.4 "Exits" column: the close-signal time exit of each family (sessions) and its rule id
  const TIME_EXIT: Record<keyof typeof GOLDEN, readonly [number, string]> = {
    F1: [120, "max_hold"],
    F2: [60, "time_stop"],
    F3: [20, "time_stop"],
    F4: [10, "time_stop"],
    F5: [30, "time_stop"],
    F6: [20, "time_stop"],
  };

  for (const fam of Object.keys(GOLDEN) as (keyof typeof GOLDEN)[]) {
    it(`${fam}: the golden world gives exactly one ${fam} entry and the time exit fires on its session only (tests/agents/families/*)`, () => {
      const out = runFamilies(GOLDEN[fam]("RISK-ON"), p);
      const mine = out.candidates.filter((c) => c.family === fam);
      expect(mine).toHaveLength(1);
      const [n, rule] = TIME_EXIT[fam];
      const plan = mine[0]!.plan;
      // a deep winner so the F1 40-session weak-return rule cannot fire first
      const held = (sessionsHeld: number) =>
        evaluateExit(
          position(plan, {
            family: fam,
            sessionsHeld,
            fillMicro: 2n * DOLLAR,
            closeMicro: 4n * DOLLAR,
          }),
        ).cs;
      expect(held(n)?.rule).toBe(rule);
      expect(held(n - 1)).toBeNull();
    });

    it(`${fam}: the regime gate opens in ${OPEN_IN[fam].join(", ")} and blocks the rest, logging the reason`, () => {
      for (const regime of ALL) {
        const out = runFamilies(GOLDEN[fam](regime), p);
        const entered = out.candidates.some((c) => c.family === fam);
        expect(entered, `${fam} in ${regime}`).toBe(OPEN_IN[fam].includes(regime));
        if (!entered) {
          expect(out.blocked.find((b) => b.family === fam)?.reasons).toEqual([`regime_${regime}`]);
        }
      }
    });
  }

  it("F4 trades at half size in SHOCK and at full size elsewhere", () => {
    const half = (r: Regime) =>
      runFamilies(GOLDEN.F4(r), p).candidates.find((c) => c.family === "F4")!.halfSize;
    expect(half("SHOCK")).toBe(true);
    expect(["RISK-ON", "NEUTRAL", "RISK-OFF"].map((r) => half(r as Regime))).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("F3 cancels at the fill when the open gaps 8 % above the day-0 close (exactly, rounded against the buyer)", () => {
    const c = runFamilies(GOLDEN.F3("RISK-ON"), p).candidates.find((x) => x.family === "F3")!;
    expect(c.maxOpenMicro).toBe(gapCancelLevel(eventCode().bar.close, p.f3.maxGap));
    expect(gapCancelLevel(1_234_567n, p.f3.maxGap)).toBe(1_333_333n);
  });

  it("AGT-101: SHOCK is entered at once; leaving a state takes 3 sessions (tests/agents/regime.test.ts)", () => {
    let c = stepRegime(null, "RISK-ON", 3);
    c = stepRegime(c, "SHOCK", 3);
    expect(c.state).toBe("SHOCK");
    c = stepRegime(c, "NEUTRAL", 3);
    c = stepRegime(c, "RISK-ON", 3);
    expect(c.state).toBe("SHOCK"); // two sessions of a different raw state are not enough
    c = stepRegime(c, "RISK-ON", 3);
    expect(c.state).toBe("RISK-ON");
  });

  it("the night run applies the F4 gate and FAM-001 on a real database: one leg, the top-ranked (covered by batch2b.test.ts)", async () => {
    const regime = await rows(A.db, "SELECT state FROM regime_daily WHERE d = ?", [d(D)]);
    expect(regime).toEqual([{ state: "RISK-ON" }]);
    const e07 = await rows(
      A.db,
      `SELECT o.code FROM arena_order o JOIN cohort c ON c.id = o.cohort_id
       WHERE c.execution_id = 'E07' AND o.kind = 'entry' AND o.decided_d = ? AND o.status <> 'rejected'`,
      [d(D)],
    );
    expect(e07).toEqual([{ code: "ZZD1" }]);
  });

  it("indicators match the committed TA-Lib reference fixture to its tolerance (talibFixtures.test.ts; the real TA-Lib run is pending, see M4_exit_evidence.md)", () => {
    const fx = parseTaLibFixture(
      JSON.parse(
        readFileSync(
          path.join(process.cwd(), "tests/fixtures/agents/indicators/handverified_6bars.json"),
          "utf8",
        ),
      ),
    );
    const diffs = Object.values(compareToFixture(fx));
    expect(diffs.length).toBeGreaterThan(0);
    for (const diff of diffs) expect(diff).toBeLessThanOrEqual(fx.tolerance);
    expect(fx.tolerance).toBeLessThanOrEqual(1e-6);
  });
});

// ---------------------------------------------------------------------------------------------
describe("AT-16: Decision Cards (AGT-110, LLM-034)", () => {
  type Stored = { id: string; order: Row | null; card: DecisionCard };
  let cards: Stored[];
  beforeAll(async () => {
    const all = await rows(A.db, "SELECT id, card_json FROM decision_card ORDER BY id");
    cards = all.map((r) => ({
      id: String(r.id),
      order: null,
      card: JSON.parse(String(r.card_json)) as DecisionCard,
    }));
  });

  it("100 % of entry orders have a card (also the rejected ones), linked both ways", async () => {
    const orders = await rows(
      A.db,
      "SELECT o.id, o.card_id, o.status, c.id AS cid, c.order_id, c.taken FROM arena_order o LEFT JOIN decision_card c ON c.id = o.card_id WHERE o.kind = 'entry' AND o.cohort_id IN (SELECT id FROM cohort WHERE execution_id LIKE 'E%')",
    );
    expect(orders.length).toBeGreaterThan(0);
    for (const o of orders) {
      expect(o.card_id, String(o.id)).not.toBeNull();
      expect(o.cid, String(o.id)).toBe(o.card_id);
      if (o.status !== "rejected") expect([o.order_id, o.taken]).toEqual([o.id, 1n]);
    }
  });

  it("every card has 3 to 5 thesis-breakers and a scenario table or 'insufficient history', and passes the validator", () => {
    expect(cards.length).toBeGreaterThan(0);
    for (const { id, card } of cards) {
      expect(checkCard(card, params), id).toEqual([]);
      expect(card.thesis_breakers.length, id).toBeGreaterThanOrEqual(3);
      expect(card.thesis_breakers.length, id).toBeLessThanOrEqual(5);
      expect(card.scenario.insufficient_history || card.scenario.p50_ppm !== null, id).toBe(true);
      expect(card.footnote, id).toContain("n ");
    }
  });

  it("n = 12 shows 'insufficient history' with n; n = 30 shows the 10th/50th/90th percentiles (cards.test.ts)", () => {
    const split = { version: 1, devEndD: "2030-12-31", deferredUntilD: null, asOfD: "2030-12-31" };
    const nets = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ num: BigInt(i + 1), den: 100n }));
    const twelve = buildScenario({ split, nets: nets(12) }, "F4", "F4.v1", 30);
    expect(twelve).toMatchObject({ insufficient_history: true, n: 12, p50_ppm: null });
    const thirty = buildScenario({ split, nets: nets(30) }, "F4", "F4.v1", 30);
    expect([thirty.insufficient_history, thirty.p10_ppm, thirty.p50_ppm, thirty.p90_ppm]).toEqual([
      false,
      30_000,
      150_000,
      270_000,
    ]);
  });

  it("no LLM-produced number on a card: the schema refuses a probability or a note field, and notes live in their own table", () => {
    const { card } = cards[0]!;
    expect(checkCard({ ...card, probability_of_gain: 0.7 }, params).join()).toContain(
      "unknown field",
    );
    expect(checkCard({ ...card, note: "99 % sure" }, params).join()).toContain("unknown field");
    expect(JSON.stringify(card)).not.toMatch(/probabilit|confidence/i);
  });

  it("the LLM mock changes no card byte (card_json, card_sha) and its ungrounded answer cannot enter a card (cards.test.ts 'mock mode rejects an answer')", async () => {
    const q = "SELECT id, card_json, card_sha FROM decision_card ORDER BY id";
    expect(await dump(M.db, q)).toBe(await dump(A.db, q));
  });
});

// ---------------------------------------------------------------------------------------------
describe("TST-109: no look-ahead through batch 2b (DecisionView, A2-A5, cards)", () => {
  it("a database whose rows after D are poisoned (bars 1000x, index, late announcement, late short interest) gives byte-identical decisions for D and earlier", async () => {
    expect(P.tables).toEqual(A.tables);
    expect(A.tables[0]).not.toBe("[]");
    // the poison is real: the future bar of ZZD1 differs between the two databases
    const future = (db: Client) =>
      rows(db, "SELECT c FROM price_bar WHERE code = 'ZZD1' AND d = ?", [d(D + 1)]);
    expect((await future(P.db))[0]!.c).not.toBe((await future(A.db))[0]!.c);
  });

  it("DecisionView refuses any date after D and any instant at or after the cut-off, and never returns a later bar", async () => {
    const cutoff = decisionCutoffUtc(d(D), "18:10");
    const view = createDecisionView(P.db, { market: MARKET, d: d(D), cutoff });
    expect(() => view.checkDate(d(D + 1))).toThrow(LookAheadError);
    expect(() => view.checkInstant(cutoff)).toThrow(LookAheadError);
    await expect(view.bars("ZZD1", 5, d(D + 1))).rejects.toThrow(LookAheadError);
    const bars = await view.bars("ZZD1", 400);
    expect(bars.at(-1)!.d).toBe(d(D));
    expect(bars.every((b) => b.d <= d(D))).toBe(true);
    // the late announcement (published after the cut-off) is not visible
    const seen = await view.announcements({ codes: ["ZZ05"] });
    const stored = await rows(P.db, "SELECT 1 FROM announcement WHERE ann_id = 'POISON-1'");
    expect(stored).toHaveLength(1); // the row exists in the table, the view does not return it
    expect(seen.map((a) => a.ann_id)).not.toContain("POISON-1");
  });
});

// ---------------------------------------------------------------------------------------------
describe("AT-17: replay engine checks (ARN-071, ARN-080..087, ARN-100, DAT-125)", () => {
  const p = defaultAgentParams();

  it("a known injected edge is detected by the trade-level test (B reduced; the stated-power run is tests/replay/nullRuns.test.ts)", () => {
    const rowsIn = syntheticRows("injected", 0, INJECTED_SPEC, 0.015);
    const t = testRows("injected", 0, rowsIn, INJECTED_SPEC.sessions, INJECTED_SPEC.block, 2000);
    expect(t.p).toBeLessThanOrEqual(0.0025);
  });

  it("random-signal nulls: rejection rates at 0.05 and 0.01 inside the 99 % binomial bounds, uniform lower-tail p-values (60-run version; the 200-run check is nullRuns.test.ts, the >= 2,000 real-data runs are in the replay workflow)", () => {
    const batch = syntheticBatch("null", { runs: 60, B: 200 });
    const r = sizeReport(batch.tests, p);
    for (const l of r.levels) expect(l.within, JSON.stringify(l)).toBe(true);
    expect(r.uniformity.pass, JSON.stringify(r.uniformity)).toBe(true);
  });

  it("a window with fewer than 15 blocks returns 'insufficient independent blocks'", () => {
    const t = fewBlocksCheck();
    expect(t.insufficientBlocks).toBe(true);
    expect(t.blocks).toBeLessThan(15);
  });

  it("B = max(1,000, 20 / level): 1,000 at 0.05 and 48,000 at alpha / (m L) = 0.000417; MDE = (z(1-level) + z(0.8)) se", () => {
    expect(bootstrapReplications(0.05)).toBe(1000);
    expect(bootstrapReplications(validationLevel(0.05, 20, 6))).toBe(48000);
    const m = minimumDetectableEffect(0.05, 1);
    expect(Math.abs(m - (1.6448536269514722 + 0.8416212335729143))).toBeLessThan(1e-9);
  });

  it("DSR with one trial has SR0 = 0; PBO is n/a below 5 variants", () => {
    const base = {
      sharpe: 0.1,
      skew: 0,
      kurtosis: 3,
      observations: 500,
      trials: 1,
      srVariance: 0.0004,
    };
    expect(deflatedSharpeRatio(base).sr0).toBe(0);
    const r = scopedPrng("t17:pbo");
    const four = Array.from({ length: 100 }, () =>
      Array.from({ length: 4 }, () => uniform01(r) - 0.5),
    );
    expect(probabilityOfBacktestOverfitting(four).status).toBe("n/a");
    const eight = four.map((row) => [...row, ...row]);
    expect(probabilityOfBacktestOverfitting(eight).status).toBe("ok");
  });

  describe("signal ledger (ARN-080): de-duplication, one open row per code, one row per event, C2 exit mapping", () => {
    const leader: WorldCode = {
      code: "ZZA",
      tier: "U1",
      bars: makeBars({
        close: (i) => {
          let c = DOLLAR + BigInt(i) * CENT;
          if (i >= 283) c -= 20n * CENT;
          if (i >= 285) c += 70n * CENT;
          return c;
        },
        volume: (i) => (new Set([280, 282, 285, 288, 295]).has(i) ? 2_000_000n : 1_000_000n),
      }),
    };
    const crowd: WorldCode[] = Array.from({ length: 40 }, (_, i) => ({
      code: `ZZP${String(i).padStart(2, "0")}`,
      tier: "U1" as const,
      bars: makeBars({ close: wobble(2n * DOLLAR + BigInt(i) * 3n * CENT) }),
    }));
    const eventCode: WorldCode = {
      code: "ZZE",
      tier: "U1",
      bars: makeBars({ close: (i) => (i < 292 ? 2n * DOLLAR + BigInt(i % 2) * CENT : 1_500_000n) }),
    };
    const run = (
      codes: WorldCode[],
      family: "F1" | "F2",
      from: number,
      events = [],
    ): LedgerResult => {
      const world = buildWorld(codes, p, { events });
      return replayLedger(world, {
        params: p,
        from: SESSIONS[from]!,
        familyOptions: { families: [family] },
      });
    };

    it("never two open rows for one (family, code) and the live re-entry block after an IS exit (tests/replay/ledger.test.ts)", () => {
      const result = run([leader, ...crowd], "F1", 270);
      const byCode = new Map<string, LedgerResult["entries"]>();
      for (const e of result.entries) byCode.set(e.code, [...(byCode.get(e.code) ?? []), e]);
      expect(result.entries.length).toBeGreaterThan(0);
      for (const list of byCode.values()) {
        for (let i = 1; i < list.length; i++) {
          const prev = list[i - 1]!.row;
          expect(prev.exit_d).not.toBeNull();
          expect(list[i]!.row.entry_d > prev.exit_d!).toBe(true);
        }
      }
      const zza = byCode.get("ZZA")!;
      const reasons = new Map(
        result.skipped.filter((s) => s.code === "ZZA").map((s) => [s.d, s.reason]),
      );
      expect(reasons.get(SESSIONS[282]!)).toBe("open_row");
      expect(reasons.get(SESSIONS[285]!)).toBe("reentry_block");
      expect(zza.map((e) => e.decisionD)).toEqual([SESSIONS[280], SESSIONS[295]]);
    });

    it("an event that fires on 5 sessions creates one row only; each row carries 20 matched controls", () => {
      const event = ev({
        code: "ZZE",
        category: "results",
        polarity: 1,
        ar: "0.05",
        day0: SESSIONS[290]!,
        low: 1_950_000n,
      });
      const result = run([eventCode, ...crowd], "F2", 285, [event] as never);
      const mine = result.entries.filter((e) => e.code === "ZZE");
      expect(mine).toHaveLength(1);
      expect(mine[0]!.controls!.controls).toHaveLength(p.stats.c2ControlsPerRow);
      expect(result.skipped.filter((s) => s.code === "ZZE").map((s) => s.reason)).toEqual(
        Array(4).fill("duplicate_group"),
      );
    });

    it("C2 exit mapping: the F1 stop keeps its ATR multiple on the control's own ATR", () => {
      const f1 = runFamilies(
        inputsOf([
          factsOf(
            "ZZA",
            "U1",
            makeBars({ close: rising(CENT), volume: volumes(1_000_000n, 2_000_000n) }),
            p,
          ),
          ...peers("ZZP", "U1", 9, p),
        ]),
        p,
      ).candidates.find((c) => c.family === "F1")!;
      const mapped = mapPlanForControl({
        family: "F1",
        plan: f1.plan,
        entryOpenMicro: 20n * DOLLAR,
        atrMicro: 400_000n,
        anchors: [],
      })!;
      expect(mapped.initialStops[0]!.spec).toEqual({
        atr_micro: 400_000n,
        k: p.f1.initialStopAtr,
        cap: null,
        level_micro: null,
      });
    });
  });

  it("CIFs (target/bust/stalled/timeout) with censoring sum to one with survival, and effective N counts non-overlapping resolved cohorts only", () => {
    const o = (time: number, cause: "target" | "bust" | "stalled" | "timeout" | null) => ({
      time,
      cause,
    });
    const est = aalenJohansen(
      [o(1, "target"), o(1, "bust"), o(2, null), o(3, "target"), o(3, "target"), o(4, "stalled")],
      [4],
    )[0]!;
    expect(est.cif.target).toBeCloseTo(11 / 18, 12);
    expect(est.cif.stalled).toBeCloseTo(2 / 9, 12);
    expect(
      est.cif.target + est.cif.bust + est.cif.stalled + est.cif.timeout + est.survival,
    ).toBeCloseTo(1, 12);
    const c = (
      id: string,
      startD: string,
      terminalD: string | null,
      k: "target" | "bust" | null,
    ) => ({
      id,
      executionId: "E01",
      startD,
      terminalD,
      terminalKind: k,
    });
    const n = effectiveN([
      c("a", "2030-01-02", "2030-02-27", "target"),
      c("b", "2030-01-09", "2030-02-20", "bust"), // overlaps a
      c("c", "2030-03-01", "2030-07-19", "target"),
      c("d", "2030-09-02", null, null), // unresolved
    ]);
    expect(n).toEqual({ n: 2, counted: ["a", "c"] });
  });

  it("survivorship missing share per year (> 5 % is exposed) and the delisting sensitivity re-scoring", () => {
    const calendar = weekdayCalendar(520); // 2015-01-05 ..
    const mid = calendar.findIndex((x) => x.startsWith("2015-06-0"));
    const codes = Array.from({ length: 25 }, (_, i) => `C${String(i).padStart(2, "0")}`);
    const announcements = codes.flatMap((code) =>
      [0, 3, 6].map((k) => ({ code, d: calendar[mid + k]! })),
    );
    const year = (missing: number) =>
      survivorshipSeries({
        announcements,
        calendar,
        hasPrice: new Set(codes.slice(missing)),
        params: STATS_PARAMS,
      }).find((y) => y.year === 2015)!;
    expect(year(1).exposed).toBe(false); // 4 %
    expect(year(2).exposed).toBe(true); // 8 %
    const s = delistingSensitivity(
      [
        {
          id: "a",
          code: "AAA",
          entryD: "2016-01-04",
          exitD: "2016-03-01",
          net: 0.05,
          lastTradedNet: -0.3,
        },
        { id: "b", code: "BBB", entryD: "2016-01-04", exitD: "2016-03-01", net: 0.01 },
      ],
      new Map([["AAA", "2016-02-10"]]),
    );
    expect(s.affected).toBe(1);
    expect(s.baseMean).toBeCloseTo(0.03, 12);
    expect(s.wipeoutMean).toBeCloseTo((-1 + 0.01) / 2, 12);
  });

  it("a light replay writes a measured compute report that is within the ARN-100 budget (full, evidence and over-budget runs: tests/replay/runner.test.ts)", () => {
    const cal = weekdayCalendar(640, "2027-01-04");
    let seed = 777;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const bars: Record<string, unknown>[] = [];
    const universe: Record<string, unknown>[] = [];
    for (const code of ["ZZA", "ZZB", "ZZC", "ZZD", "ZZE", "ZZF", "ZZG", "ZZH"]) {
      let c = 5 + rnd() * 5;
      universe.push({
        d: cal[0],
        code,
        status: "active",
        tier: "U1",
        mcap_est: 1e9,
        adv: 5e6,
        halted: 0,
      });
      for (const day of cal) {
        const o = c;
        c = Math.max(0.5, c * (1 + (rnd() - 0.48) * 0.04));
        bars.push({
          code,
          d: day,
          o: Number(o.toFixed(2)),
          h: Number((Math.max(o, c) * 1.005).toFixed(2)),
          l: Number((Math.min(o, c) * 0.995).toFixed(2)),
          c: Number(c.toFixed(2)),
          volume: Math.round(500_000 * (0.5 + rnd())),
        });
      }
    }
    let idx = 7000;
    const index_bars = cal.map((day) => {
      idx *= 1 + (rnd() - 0.48) * 0.01;
      const m = Math.round(idx * 1e6);
      return { index_code: "AXJO", d: day, o_micro: m, h_micro: m, l_micro: m, c_micro: m };
    });
    const calendar = cal.map((day) => ({
      d: day,
      kind: "session",
      close_time: null,
      confirmed: 1,
    }));
    const { bytes } = buildSnapshot({
      from: cal[0]!,
      to: cal[cal.length - 1]!,
      inputs: { calendar, universe, bars, index_bars, corporate_actions: [], announcements: [] },
    });
    const r = runReplay({
      mode: "light",
      d: "2029-06-29",
      since: "2029-03-01",
      params: p,
      commitSha: "a".repeat(40),
      nodeVersion: "v22",
      snapshotBytes: bytes,
      now: Date.now,
    });
    expect(r.report.status).toBe("complete");
    expect(r.report.within).toBe(true);
    expect(r.stats.some((s) => s.scope === "run" && s.metric === "compute_report")).toBe(true);
    expect(r.validation).toHaveLength(0); // light mode never touches validation or holdout
  });
});
