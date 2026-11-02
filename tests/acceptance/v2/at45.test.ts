// @vitest-environment node
// AT-45 Data additions (M14; docs/M14_design.md 5; DAT-231, DAT-232, DAT-233, DAT-234, DAT-237,
// AGT-135, AGT-138; decisions D-236, D-237, D-238, D-240, D-241).
//
//   1 DAT-231  the vendor split and dividend rows come from the one nightly Yahoo file batch 1 is
//              handed (the M8.1 path: `runBatch1` with `actionsText`); no extra request, no second write
//   2 DAT-232  a 2-for-1 split 10 sessions before day 0: the event's day-0 volume ratio
//              (`eventsForDecision` with the production `splitsFor` built from `splitActionsByCode` +
//              `splitsKnownOn`) and the indicator ratio (`adjustBars` + `volumeRatio`) both equal the
//              hand value on adjusted volume (3.0); the raw ratio (4.0) differs
//   3 DAT-234  an F3-qualifying results event on a code added to an index the same day is blocked with
//              `index_change` and tagged on the card; the same code without the CSV row is taken
//   4 DAT-233  a dividend (price) factor whose stored reference close no longer matches is queued for
//              the Owner as `ref_close_mismatch` and not applied
//   5 DAT-237  an exact repost and a near-duplicate title on the next day give one event
//   6 AGT-135/138  `category_detail` on the row and the fact, the plain words, the reversal flag
//
// Fixtures: tests/fixtures/m14/split-day.json and indexChange.ts (new), the M8.1 vendor-action
// shapes of tests/ingest/ and the corporate-action helpers (reused). Synthetic ZZ codes only (SEC-110).
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adjustBars, splitActionsByCode, splitsKnownOn } from "@/lib/agents/candidates";
import { createDecisionView, decisionCutoffUtc } from "@/lib/agents/decisionView";
import {
  buildEventRow,
  eventsForDecision,
  EVENT_RULE_VERSION,
  splitAdjustedVolumes,
  type EventContext,
} from "@/lib/agents/events";
import { runFamilies } from "@/lib/agents/families";
import { eventFactFromRow, reversedNextClose } from "@/lib/agents/families/facts";
import { volumeRatio } from "@/lib/agents/indicators";
import { defaultAgentParams } from "@/lib/agents/params";
import type { CorpActionRecord } from "@/lib/arena/corpActions";
import { adjustedBars, UNBOUNDED } from "@/lib/data/adjusted";
import type { CalendarRow, MarketHours } from "@/lib/data/calendar";
import { loadActions, runCorporateActions, settle } from "@/lib/data/corporateActions/engine.mjs";
import { carryTiers, noopQualityHook, runBatch1 } from "@/lib/data/pipeline/batch1";
import { importIndexChanges, loadIndexChanges } from "@/lib/data/referenceData";
import { makeRational, type Rational } from "@/lib/money/rational";
import { eventDetailText, flagText, notTakenText } from "@/lib/ui/loaders/cardParts";
import {
  parseVendorActionsText,
  readVendorActions,
} from "../../../src/lib/data/vendorActions/vendorActions.mjs";
import {
  announced,
  caDb,
  D0,
  D1,
  D2,
  io,
  nowOf,
  putBar,
  rows,
} from "../../corporateActions/helpers";
import { cleanupTempDbs, freshDb, ROOT } from "../../db/helpers";
import {
  dayAgo,
  DOLLAR,
  ev,
  factsOf,
  inputsOf,
  makeBars,
  override,
  wobble,
  D as FAMILY_D,
} from "../../fixtures/agents/families/builders";
import { INDEX_CHANGE_CSV } from "../../fixtures/m14/indexChange";
import { at1730, barsFor, count, pipelineDb, runs, text } from "../../pipeline/helpers";

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });
afterEach(cleanupTempDbs);

const p = defaultAgentParams();
const hours: MarketHours = { tz: "Australia/Sydney", open_time: "10:00", close_time: "16:00" };
const calendar: CalendarRow[] = [];
const MICRO = 1_000_000;
const fx = (name: string): string => path.join(ROOT, "tests", "fixtures", "m14", name);

type SplitDay = {
  market: string;
  code: string;
  indexCode: string;
  day0: string;
  decisionD: string;
  split: { exDate: string; new: number; old: number };
  hand: { rawRatio: string; adjustedRatio: string; rawRatioPpm: number; adjustedRatioPpm: number };
  index: { close: number; day0Close: number };
  bars: { d: string; close: number; volume: number }[];
};
const SPLIT_DAY = JSON.parse(readFileSync(fx("split-day.json"), "utf8")) as SplitDay;
const INDEX_CSV = INDEX_CHANGE_CSV;
// loaded before the night: a reference row is known only from its load time (D-285)
const NOW = "2026-10-01T00:00:00.000Z";
const CUT = `${FAMILY_D}T23:59:59.999Z`;

// ---- 1 DAT-231 vendor rows without an extra request --------------------------------------------------------

describe("AT-45 1: DAT-231 vendor rows from the one nightly Yahoo file", () => {
  const TUE = "2026-10-13";
  const fetchedAt = "2026-10-13T07:30:00.000Z";
  const split = {
    code: "ZZA",
    ex_date: "2026-10-12",
    kind: "split",
    ratio: 2,
    currency: "AUD",
    source: "yahoo",
    fetched_at: fetchedAt,
  };
  const div = {
    code: "ZZB",
    ex_date: TUE,
    kind: "dividend",
    amount: 0.35,
    currency: "AUD",
    source: "yahoo",
    fetched_at: fetchedAt,
  };

  it("one bars file and one actions file -> the split and the dividend rows, written once", async () => {
    const db = await pipelineDb();
    const actionsText = text([split, div]);
    // the parser is the one batch 1 uses on the file the single yfinance job fetched
    expect(parseVendorActionsText(actionsText).rows).toHaveLength(2);
    const go = () =>
      runBatch1(db, {
        nowMs: () => at1730(TUE),
        barsText: text(barsFor(["2026-10-12", TUE])),
        actionsText,
        qualityHook: noopQualityHook,
        tiersHook: carryTiers,
      } as never);
    const res = await go();
    expect(res.exit).toBe(0);
    expect(await count(db, "vendor_action")).toBe(2);
    const got = await rows(
      db,
      "SELECT code, ex_date, kind, ratio, amount_micro, source FROM vendor_action ORDER BY code",
    );
    expect(got).toEqual([
      {
        code: "ZZA",
        ex_date: "2026-10-12",
        kind: "split",
        ratio: 2,
        amount_micro: null,
        source: "yahoo",
      },
      {
        code: "ZZB",
        ex_date: TUE,
        kind: "dividend",
        ratio: null,
        amount_micro: 350000,
        source: "yahoo",
      },
    ]);
    const rec = (await runs(db)).find((x) => x.status === "success")!;
    const stage = JSON.parse(String(rec.details_json)).stages.macro_and_other.vendor_actions;
    expect(stage).toMatchObject({ rows: 2, written: 2 });
    // the reader the corporate-action engine uses sees the same two rows
    expect(
      (await readVendorActions(db, "ZZA", "2026-10-01", "2026-10-31")).map((x) => x.kind),
    ).toEqual(["split"]);
    // a second run of the same night changes nothing (no second request, no duplicate)
    await go();
    expect(await count(db, "vendor_action")).toBe(2);
  });
});

// ---- 2 DAT-232 split-adjusted volume ratio ----------------------------------------------------------------------

const toMicro = (v: number): bigint => BigInt(Math.round(v * MICRO));

function viewBars(): {
  d: string;
  open: bigint;
  high: bigint;
  low: bigint;
  close: bigint;
  volume: bigint;
}[] {
  return SPLIT_DAY.bars.map((b) => {
    const c = toMicro(b.close);
    return { d: b.d, open: c, high: c, low: c, close: c, volume: BigInt(b.volume) };
  });
}

const splitRecord: CorpActionRecord = {
  id: "ca-split-1",
  code: SPLIT_DAY.code,
  type: "split",
  exDate: SPLIT_DAY.split.exDate,
  payload: { new: SPLIT_DAY.split.new, old: SPLIT_DAY.split.old },
  knownAt: `${SPLIT_DAY.split.exDate}T00:00:00.000Z`,
};

async function seedSplitDay(
  db: Awaited<ReturnType<typeof freshDb>>,
  titles: readonly [string, string, string][],
): Promise<void> {
  const stmts: { sql: string; args: (string | number)[] }[] = [];
  for (const b of SPLIT_DAY.bars) {
    stmts.push({
      sql: `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'test', ?, ?)`,
      args: [
        SPLIT_DAY.market,
        SPLIT_DAY.code,
        b.d,
        b.close,
        b.close,
        b.close,
        b.close,
        b.volume,
        `${b.d}T06:00:00.000Z`,
        `${b.d}T06:05:00.000Z`,
      ],
    });
    const x = (b.d === SPLIT_DAY.day0 ? SPLIT_DAY.index.day0Close : SPLIT_DAY.index.close) * MICRO;
    stmts.push({
      sql: `INSERT INTO index_bar (market, index_code, d, o_micro, h_micro, l_micro, c_micro, source, published_at, ingested_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'test', ?, ?)`,
      args: [
        SPLIT_DAY.market,
        SPLIT_DAY.indexCode,
        b.d,
        x,
        x,
        x,
        x,
        `${b.d}T06:00:00.000Z`,
        `${b.d}T06:05:00.000Z`,
      ],
    });
  }
  for (const [id, title, published] of titles) {
    stmts.push({
      sql: `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, price_sensitive, title, source)
            VALUES (?, ?, ?, ?, ?, NULL, 1, ?, 'asx')`,
      args: [SPLIT_DAY.market, SPLIT_DAY.code, id, published, published, title],
    });
  }
  await db.batch(stmts);
}

async function eventsOn(
  titles: readonly [string, string, string][],
  extra: Partial<EventContext> = {},
) {
  const db = await freshDb("main");
  await seedSplitDay(db, titles);
  const D = SPLIT_DAY.decisionD;
  const view = createDecisionView(db, {
    market: SPLIT_DAY.market,
    d: D,
    cutoff: decisionCutoffUtc(D, p.decisionCutoff),
  });
  return eventsForDecision(view, {
    params: p,
    calendar,
    hours,
    indexCode: SPLIT_DAY.indexCode,
    ...extra,
  });
}

const ratText = (r: Rational | null): string => (r === null ? "null" : `${r.num}/${r.den}`);
const RESULTS: [string, string, string] = [
  "r1",
  "Full Year Results",
  `${SPLIT_DAY.day0}T01:00:00.000Z`,
];

describe("AT-45 2: DAT-232 split-adjusted volume ratio", () => {
  it("the fixture is as described: 22 sessions, the ex-date 10 sessions before day 0, window 20", () => {
    expect(SPLIT_DAY.bars).toHaveLength(p.windows.volumeRatio + 2);
    const i0 = SPLIT_DAY.bars.findIndex((b) => b.d === SPLIT_DAY.day0);
    const ix = SPLIT_DAY.bars.findIndex((b) => b.d === SPLIT_DAY.split.exDate);
    expect(i0 - ix).toBe(10);
    expect(p.windows.volumeRatio).toBe(20);
  });

  it("the production split record gives the ex-date and the 2/1 ratio, known by day 0", () => {
    const { byCode, bad } = splitActionsByCode([splitRecord]);
    expect(bad.size).toBe(0);
    const known = splitsKnownOn(byCode.get(SPLIT_DAY.code)!, SPLIT_DAY.day0, p.decisionCutoff);
    expect(known).toHaveLength(1);
    expect(known[0]!.exDate).toBe(SPLIT_DAY.split.exDate);
    expect(ratText(known[0]!.ratio)).toBe("2/1");
  });

  it("indicator volume ratio: adjusted = the hand value 3.0, raw = 4.0", () => {
    const bars = viewBars();
    const known = splitsKnownOn(
      splitActionsByCode([splitRecord]).byCode.get(SPLIT_DAY.code)!,
      SPLIT_DAY.day0,
      p.decisionCutoff,
    );
    const adj = adjustBars(bars, known);
    expect(adj.map((b) => b.close).every((c) => c === adj[0]!.close || c === toMicro(10.5))).toBe(
      true,
    );
    expect(adj[0]!.close).toBe(toMicro(10)); // pre-split prices halved
    expect(adj[0]!.volume).toBe(2000n); // pre-split volumes doubled
    const adjusted = volumeRatio(
      adj.map((b) => b.volume),
      p.windows.volumeRatio,
    )!;
    const raw = volumeRatio(
      bars.map((b) => b.volume),
      p.windows.volumeRatio,
    )!;
    expect(ratText(adjusted)).toBe(`${SPLIT_DAY.hand.adjustedRatio}/1`);
    expect(ratText(raw)).toBe(`${SPLIT_DAY.hand.rawRatio}/1`);
    expect(ratText(adjusted)).not.toBe(ratText(raw));
    // the event builder's volume adjustment is the same arithmetic
    const evVolumes = splitAdjustedVolumes(bars, [
      { exDate: known[0]!.exDate, ratio: known[0]!.ratio },
    ]);
    expect(evVolumes).toEqual(adj.map((b) => b.volume));
  });

  it("event volume ratio: with the production splitsFor it is the hand value on adjusted volume; raw differs", async () => {
    const byCode = splitActionsByCode([splitRecord]).byCode;
    const splitsFor: EventContext["splitsFor"] = (code, day0) =>
      splitsKnownOn(byCode.get(code) ?? [], day0, p.decisionCutoff).map((s) => ({
        exDate: s.exDate,
        ratio: s.ratio,
      }));
    const [adjusted] = await eventsOn([RESULTS], { splitsFor });
    const [raw] = await eventsOn([RESULTS]);
    expect(adjusted!.day0_d).toBe(SPLIT_DAY.day0);
    expect(adjusted!.vol_ratio_ppm).toBe(SPLIT_DAY.hand.adjustedRatioPpm);
    expect(raw!.vol_ratio_ppm).toBe(SPLIT_DAY.hand.rawRatioPpm);
    expect(adjusted!.vol_ratio_ppm).not.toBe(raw!.vol_ratio_ppm);
    // the price part is unchanged by the volume basis: the AR is the same
    expect(adjusted!.ar_ppm).toBe(raw!.ar_ppm);
    expect(adjusted!.ar_ppm).toBe(45_000); // 5 % share move less 0.5 % index move
    expect(adjusted!.rule_version).toBe(EVENT_RULE_VERSION);
  });
});

// ---- 3 DAT-234 index change excluded from F3 and tagged ------------------------------------------------------

describe("AT-45 3: DAT-234 index change excluded from F3 and tagged", () => {
  const CODE = "ZZE";
  const INDEX = "S&P/ASX 200";
  const resultsEvent = () =>
    ev({ code: CODE, category: "results", polarity: 1, ar: "0.04", vol: "2" });
  const run = async (withCsv: boolean) => {
    const db = await freshDb("main");
    if (withCsv)
      expect(await importIndexChanges(db, INDEX_CSV, NOW)).toEqual({
        ok: true,
        inserted: 2,
        ignored: 0,
      });
    const changes = await loadIndexChanges(db, "AU", FAMILY_D, CUT);
    const base = factsOf(CODE, "U1", makeBars({ close: wobble(2n * DOLLAR) }), p);
    const facts = changes.has(CODE) ? override(base, { indexChanges: changes.get(CODE)! }) : base;
    return runFamilies(inputsOf([facts], { events: [resultsEvent()] }), p);
  };

  it("the CSV fixture loads: ZZE is added to the index effective on the decision day, announced 8 sessions before", async () => {
    const db = await freshDb("main");
    await importIndexChanges(db, INDEX_CSV, NOW);
    const changes = await loadIndexChanges(db, "AU", FAMILY_D, CUT);
    expect(changes.get("ZZE")).toEqual([
      { indexName: INDEX, kind: "add", announced: "2026-10-06", effective: FAMILY_D },
    ]);
    expect(changes.get("ZZE")![0]!.announced).toBe(dayAgo(8));
    // ZZF's delete is months old: visible but nowhere near a day 0 of this night
    expect(changes.get("ZZF")![0]!.kind).toBe("delete");
  });

  it("with the row: blocked with reason index_change, the tag is on the card; without it: taken", async () => {
    const blocked = await run(true);
    expect(blocked.candidates.some((c) => c.family === "F3" && c.code === CODE)).toBe(false);
    const b = blocked.blocked.find((x) => x.family === "F3" && x.code === CODE)!;
    expect(b).toBeDefined();
    expect(b.reasons).toEqual(["index_change"]);
    expect(b.flags).toContain(`index_change:${INDEX}`);
    expect(notTakenText("index_change")).toMatch(/joining or leaving a stock-market index/);

    const taken = await run(false);
    expect(taken.candidates.some((c) => c.family === "F3" && c.code === CODE)).toBe(true);
    expect(taken.blocked.some((x) => x.family === "F3" && x.code === CODE)).toBe(false);
  });
});

// ---- 4 DAT-233 reference-close mismatch queued -------------------------------------------------------------

describe("AT-45 4: DAT-233 a price factor whose reference close changed is queued, not applied", () => {
  it("ref_close_mismatch goes to the Owner queue and the series stays unadjusted", async () => {
    const db = await caDb();
    await putBar(db, "ZZA", D0, 10);
    await putBar(db, "ZZA", D1, 7.4);
    await runCorporateActions({
      db,
      market: "AU",
      d: D1,
      io: io(),
      now: nowOf(D1),
      candidates: [announced("ZZA", "spin_off", D1, { retained: { num: 3, den: 4 } })] as never,
    });
    const [a] = await loadActions(db, io(), "AU");
    expect(a?.state).toBe("confirmed");
    const before = await adjustedBars(db, "ZZA", D0, D1, { knownBy: UNBOUNDED });
    expect([before[0]?.priceFactor, before[0]?.splitFactor]).toEqual([0.75, 1]);
    const f = await rows(
      db,
      "SELECT factor_kind, ref_close_micro FROM adjustment_factor WHERE code = 'ZZA' ORDER BY computed_at",
    );
    expect(f).toEqual([{ factor_kind: "price", ref_close_micro: 10_000_000 }]);
    // a newer factor row (append-only) carries another reference close than the stored close before the ex-date
    await db.execute({
      sql: `INSERT INTO adjustment_factor (market, code, ex_date, factor, corporate_action_id, computed_at,
              factor_kind, ref_close_micro) VALUES ('AU','ZZA',?,0.75,?,?,'price',9000000)`,
      args: [D1, a!.id, "2026-10-14T00:00:00.000Z"],
    });
    const s = await settle(db, { market: "AU", now: nowOf(D2), io: io(), today: D2 });
    expect(s.factors).toBe(1); // the neutral row that undoes the factor
    const [b] = await loadActions(db, io(), "AU");
    expect(b?.state).toBe("owner");
    expect(b?.note.reasons).toEqual(["ref_close_mismatch"]);
    const after = await adjustedBars(db, "ZZA", D0, D1, { knownBy: UNBOUNDED });
    expect(after[0]?.priceFactor).toBe(1);
    expect(after[0]?.c).toBe(10);
  });
});

// ---- 5 DAT-237 exact repost and near-duplicate -> one event ------------------------------------------------

describe("AT-45 5: DAT-237 an exact repost and a near-duplicate next-day title give one event", () => {
  const LONG = "Company announces full year results and final dividend for the year ended June";
  const day0 = SPLIT_DAY.day0; // 2026-10-14
  const dayBefore = "2026-10-13";

  it("three items, one event; an unrelated title the same day is its own event", async () => {
    const evs = await eventsOn([
      ["a1", LONG, `${dayBefore}T01:00:00.000Z`],
      ["a2", LONG, `${dayBefore}T02:30:00.000Z`], // exact repost
      ["a3", `${LONG} 2026`, `${day0}T01:00:00.000Z`], // near-duplicate, next day
      ["a4", "Trading update on the ASX", `${day0}T02:00:00.000Z`],
    ]);
    expect(evs.map((e) => e.ann_id).sort()).toEqual(["a1", "a4"]);
    expect(evs.find((e) => e.ann_id === "a1")!.day0_d).toBe(dayBefore);
  });

  it("the same three duplicates alone give exactly one event, and the result is deterministic", async () => {
    const t: [string, string, string][] = [
      ["a1", LONG, `${dayBefore}T01:00:00.000Z`],
      ["a2", LONG, `${dayBefore}T02:30:00.000Z`],
      ["a3", `${LONG} 2026`, `${day0}T01:00:00.000Z`],
    ];
    const once = await eventsOn(t);
    expect(once).toHaveLength(1);
    expect(once[0]!.ann_id).toBe("a1");
    expect(JSON.stringify(await eventsOn(t))).toBe(JSON.stringify(once));
  });
});

// ---- 6 AGT-135 / AGT-138 details and the reversal flag ---------------------------------------------------------

describe("AT-45 6: AGT-135 / AGT-138 details and the reversal flag", () => {
  const ann = (title: string) => ({
    source: "asx",
    ann_id: "x",
    code: "ZZQ",
    published_at: "2026-10-14T01:00:00.000Z",
    type: null,
    title,
    price_sensitive: 1 as const,
  });
  const day0 = { day0: "2026-10-14", timed: true };
  const market = (close0: bigint) => ({
    close0,
    closePrev: 10_000_000n,
    index0: 7_000_000_000n,
    indexPrev: 7_000_000_000n,
    volumes: [1000n, 1000n],
  });

  it("a query response is exchange_query / query_response at polarity -1; guidance maintained is other / guidance_maintained with the AR sign", () => {
    const q = buildEventRow("AU", ann("Response to ASX price query"), day0, market(10_500_000n), p);
    expect([q.category, q.category_detail, q.polarity]).toEqual([
      "exchange_query",
      "query_response",
      -1,
    ]);
    const up = buildEventRow(
      "AU",
      ann("Guidance reaffirmed for FY27"),
      day0,
      market(10_500_000n),
      p,
    );
    const down = buildEventRow(
      "AU",
      ann("Guidance reaffirmed for FY27"),
      day0,
      market(9_500_000n),
      p,
    );
    expect([up.category, up.category_detail, up.polarity]).toEqual([
      "other",
      "guidance_maintained",
      1,
    ]);
    expect([down.category_detail, down.polarity]).toEqual(["guidance_maintained", -1]);
    expect(q.rule_version).toBe("events-v2");
    expect(eventDetailText(q.category_detail)).toBe("Response to an ASX query");
    expect(eventDetailText(up.category_detail)).toBe("Guidance maintained");
    expect(eventDetailText(null)).toBeNull();
  });

  it("the reversal flag: set from the day-0 and next closes only, shown on the card, never a rule input", () => {
    const row = buildEventRow(
      "AU",
      ann("Response to ASX price query"),
      day0,
      market(10_500_000n),
      p,
    );
    const ar = makeRational(9n, 200n); // +5 % share less +0 % index = 0.05 - 0.005
    expect(row.ar_ppm).toBe(50_000);
    const plain = eventFactFromRow(row, null);
    expect(plain.categoryDetail).toBe("query_response");
    expect("reversedNextClose" in plain).toBe(false);
    const reversed = eventFactFromRow(row, null, {
      day0Close: 10_500_000n,
      nextClose: 10_100_000n,
    });
    expect(reversed.reversedNextClose).toBe(true);
    const continued = eventFactFromRow(row, null, {
      day0Close: 10_500_000n,
      nextClose: 10_900_000n,
    });
    expect(continued.reversedNextClose).toBe(false);
    expect(
      eventFactFromRow(row, null, { day0Close: 10_500_000n, nextClose: null }).reversedNextClose,
    ).toBeNull();
    expect(reversedNextClose(ar, 10_500_000n, 10_000_000n)).toBe(true);
    expect(flagText("event_reversed_next_close")).toMatch(/reversed at the next close/);
    // the F3 rule reads the same facts with or without the flag: it is display only
    const facts = factsOf("ZZQ", "U1", makeBars({ close: wobble(2n * DOLLAR) }), p);
    const base = ev({ code: "ZZQ", category: "results", polarity: 1, ar: "0.04", vol: "2" });
    const a = runFamilies(inputsOf([facts], { events: [base] }), p);
    const b = runFamilies(inputsOf([facts], { events: [{ ...base, reversedNextClose: true }] }), p);
    expect(a.candidates.map((c) => [c.family, c.code])).toEqual(
      b.candidates.map((c) => [c.family, c.code]),
    );
    expect(a.candidates.some((c) => c.family === "F3")).toBe(true);
  });
});
