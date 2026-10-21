// @vitest-environment node
// DecisionView (M4 T6; TST-109 unit; design 2.3, 4.12): every read is bounded by D and by the
// cut-off; a later date or instant throws LookAheadError; a poisoned future row is never read, so
// every A2/A3 output for D is byte-identical with and without it. Synthetic data only.
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60000 });
import { defaultAgentParams } from "@/lib/agents/params";
import { LookAheadError, createDecisionView, decisionCutoffUtc } from "@/lib/agents/decisionView";
import { eventsForDecision } from "@/lib/agents/events";
import { insiderFlowFor } from "@/lib/agents/insiderFlow";
import { shortInterestFor } from "@/lib/agents/shortInterest";
import type { CalendarRow, MarketHours } from "@/lib/data/calendar";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const p = defaultAgentParams();
const D = "2026-10-15"; // Thursday, AEDT
const CUTOFF = decisionCutoffUtc(D, p.decisionCutoff);
const hours: MarketHours = { tz: "Australia/Sydney", open_time: "10:00", close_time: "16:00" };
const calendar: CalendarRow[] = [];
type V = string | number | null;

const run = (db: Client, sql: string, args: V[] = []) => db.execute({ sql, args });
const bar = (db: Client, code: string, d: string, c: number, ingested = `${d}T06:05:00.000Z`) =>
  run(
    db,
    `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
     VALUES ('AU', ?, ?, ?, ?, ?, ?, 1000, 'test', ?, ?)`,
    [code, d, c, c, c, c, `${d}T06:00:00.000Z`, ingested],
  );

describe("decisionCutoffUtc", () => {
  it("18:10 Melbourne on a DST day is 07:10Z; on a standard-time day 08:10Z", () => {
    expect(decisionCutoffUtc("2026-10-15", "18:10")).toBe("2026-10-15T07:10:00.000Z");
    expect(decisionCutoffUtc("2026-07-15", "18:10")).toBe("2026-07-15T08:10:00.000Z");
  });
});

describe("DecisionView guards", () => {
  it("throws LookAheadError for a date after D or an instant at or after the cut-off", async () => {
    const view = createDecisionView(await freshDb("main"), { market: "AU", d: D, cutoff: CUTOFF });
    expect(() => view.checkDate("2026-10-16")).toThrow(LookAheadError);
    expect(() => view.checkDate(D)).not.toThrow();
    expect(() => view.checkInstant(CUTOFF)).toThrow(LookAheadError);
    expect(() => view.checkInstant("2026-10-15T07:09:59.999Z")).not.toThrow();
    await expect(view.bars("AAA", 5, "2026-10-16")).rejects.toThrow(LookAheadError);
    await expect(view.indexBars("AXJO", 5, "2026-10-16")).rejects.toThrow(LookAheadError);
    await expect(view.announcements({ sinceIso: CUTOFF })).rejects.toThrow(LookAheadError);
    await expect(view.insiderNotices("AAA", "2026-10-16T00:00:00.000Z")).rejects.toThrow(
      LookAheadError,
    );
    expect(() => view.checkInstant("not a date")).toThrow(TypeError);
  });

  it("bars: never returns a row after D even when asked for the default horizon", async () => {
    const db = await freshDb("main");
    await bar(db, "AAA", "2026-10-13", 10);
    await bar(db, "AAA", "2026-10-14", 11);
    await bar(db, "AAA", "2026-10-15", 12);
    await bar(db, "AAA", "2026-10-16", 999); // poison
    const view = createDecisionView(db, { market: "AU", d: D, cutoff: CUTOFF });
    const bars = await view.bars("AAA", 10);
    expect(bars.map((b) => b.d)).toEqual(["2026-10-13", "2026-10-14", "2026-10-15"]);
    expect(bars.at(-1)!.close).toBe(12_000_000n);
  });

  it("bars: malformed bars are dropped; live runs skip bars ingested after the cut-off", async () => {
    const db = await freshDb("main");
    await bar(db, "AAA", "2026-10-14", 11);
    await run(
      db,
      `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
       VALUES ('AU', 'AAA', '2026-10-13', 10, 9, 11, 10, 1, 't', '2026-10-13T06:00:00.000Z', '2026-10-13T06:05:00.000Z')`,
    ); // high < low
    await bar(db, "AAA", "2026-10-15", 12, "2026-10-15T09:00:00.000Z"); // catch-up, after cut-off
    const replay = createDecisionView(db, { market: "AU", d: D, cutoff: CUTOFF });
    expect((await replay.bars("AAA", 10)).map((b) => b.d)).toEqual(["2026-10-14", "2026-10-15"]);
    const live = createDecisionView(db, {
      market: "AU",
      d: D,
      cutoff: CUTOFF,
      liveIngestBound: true,
    });
    expect((await live.bars("AAA", 10)).map((b) => b.d)).toEqual(["2026-10-14"]);
  });

  it("announcements: strictly before the cut-off; a date-only item is usable on its own day only", async () => {
    const db = await freshDb("main");
    const ann = (id: string, at: string) =>
      run(
        db,
        `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, price_sensitive, title, source)
         VALUES ('AU', 'AAA', ?, ?, ?, NULL, 0, 't', 'asx')`,
        [id, at, at],
      );
    await ann("early", "2026-10-15T07:09:59.999Z");
    await ann("at-cutoff", CUTOFF);
    await ann("after", "2026-10-15T07:30:00.000Z");
    await ann("untimed-today", "2026-10-15");
    await ann("untimed-tomorrow", "2026-10-16");
    const view = createDecisionView(db, { market: "AU", d: D, cutoff: CUTOFF });
    const got = (await view.announcements()).map((a) => a.ann_id).sort();
    expect(got).toEqual(["early", "untimed-today"]);
    expect((await view.announcements({ codes: [] })).length).toBe(0);
    expect(
      (await view.announcements({ sinceIso: "2026-10-15T00:00:00.000Z" })).map((a) => a.ann_id),
    ).toEqual(["early"]);
  });

  it("short interest and notices: as_of > D and published >= cut-off are invisible", async () => {
    const db = await freshDb("main");
    const si = (as_of: string, at: string) =>
      run(
        db,
        `INSERT INTO short_interest (market, code, as_of, short_ppm, published_at, ingested_at, assumed_time, source)
         VALUES ('AU', 'AAA', ?, 5, ?, ?, 0, 't')`,
        [as_of, at, at],
      );
    await si("2026-10-14", "2026-10-14T06:00:00.000Z");
    await si("2026-10-15", "2026-10-15T07:30:00.000Z"); // published after the cut-off
    await si("2026-10-16", "2026-10-16T06:00:00.000Z"); // as_of after D
    const view = createDecisionView(db, { market: "AU", d: D, cutoff: CUTOFF });
    expect((await view.shortInterest("AAA", 10)).map((x) => x.as_of)).toEqual(["2026-10-14"]);
    expect(await view.insiderCoverage()).toBe(false);
  });

  it("priorRegime is strictly before D; indicatorRow is the latest d <= D", async () => {
    const db = await freshDb("main");
    const reg = (d: string, state: string) =>
      run(
        db,
        `INSERT INTO regime_daily (market, d, version, close_micro, raw_state, state, exit_streak)
         VALUES ('AU', ?, 1, 1, ?, ?, 1)`,
        [d, state, state],
      );
    await reg("2026-10-13", "RISK-ON");
    await reg("2026-10-14", "NEUTRAL");
    await reg("2026-10-15", "SHOCK"); // today's own row is not "prior"
    await reg("2026-10-16", "SHOCK");
    const view = createDecisionView(db, { market: "AU", d: D, cutoff: CUTOFF });
    expect(await view.priorRegime(1)).toEqual({
      d: "2026-10-14",
      state: "NEUTRAL",
      exit_streak: 1,
    });
    expect(await view.priorRegime(2)).toBeNull();
    const ind = (d: string, close: number) =>
      run(
        db,
        `INSERT INTO indicator_daily (market, code, d, ind_version, close_adj_micro) VALUES ('AU', 'AAA', ?, 1, ?)`,
        [d, close],
      );
    await ind("2026-10-14", 111);
    await ind("2026-10-16", 999);
    const row = await view.indicatorRow("AAA", 1);
    expect(row?.d).toBe("2026-10-14");
  });
});

// ---- TST-109 unit: the whole A2 output for D is unchanged by every row after D / the cut-off ----

async function bundle(poison: boolean): Promise<string> {
  const db = await freshDb("main");
  const days = ["2026-10-09", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"];
  for (const [i, d] of days.entries()) {
    await bar(db, "AAA", d, 10 + (i === days.length - 1 ? 0 : 0));
    await run(
      db,
      `INSERT INTO index_bar (market, index_code, d, o_micro, h_micro, l_micro, c_micro, source, published_at, ingested_at)
       VALUES ('AU', 'AXJO', ?, 7000000000, 7000000000, 7000000000, 7000000000, 't', ?, ?)`,
      [d, `${d}T06:00:00.000Z`, `${d}T06:05:00.000Z`],
    );
  }
  const ann = (id: string, title: string, at: string) =>
    run(
      db,
      `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, price_sensitive, title, source)
       VALUES ('AU', 'AAA', ?, ?, ?, NULL, 1, ?, 'asx')`,
      [id, at, at, title],
    );
  await ann("e1", "Half Year Results", "2026-10-14T01:00:00.000Z");
  await run(
    db,
    `INSERT INTO insider_notice (market, ann_id, code, kind, value_micro, published_at, parser_version)
     VALUES ('AU', 'i1', 'AAA', 'sh_new', NULL, '2026-10-13T01:00:00.000Z', 'v1')`,
  );
  const si = (as_of: string, ppm: number, at = `${as_of}T06:00:00.000Z`) =>
    run(
      db,
      `INSERT INTO short_interest (market, code, as_of, short_ppm, published_at, ingested_at, assumed_time, source)
       VALUES ('AU', 'AAA', ?, ?, ?, ?, 0, 't')`,
      [as_of, ppm, at, at],
    );
  await si("2026-10-01", 50000);
  await si("2026-10-15", 30000);
  if (poison) {
    await bar(db, "AAA", "2026-10-16", 1);
    await bar(db, "AAA", "2026-10-19", 1);
    await run(
      db,
      `INSERT INTO index_bar (market, index_code, d, o_micro, h_micro, l_micro, c_micro, source, published_at, ingested_at)
       VALUES ('AU', 'AXJO', '2026-10-16', 1, 1, 1, 1, 't', '2026-10-16T06:00:00.000Z', '2026-10-16T06:05:00.000Z')`,
    );
    await ann("x1", "Profit warning", "2026-10-15T07:10:00.000Z");
    await ann("x2", "Company upgrades FY earnings guidance", "2026-10-15T08:00:00.000Z");
    await ann("x3", "Trading Halt", "2026-10-16");
    await run(
      db,
      `INSERT INTO insider_notice (market, ann_id, code, kind, value_micro, published_at, parser_version)
       VALUES ('AU', 'i2', 'AAA', 'director_sell', 5000000, '2026-10-15T09:00:00.000Z', 'v1')`,
    );
    await si("2026-10-16", 1);
    await si("2026-10-14", 1, "2026-10-15T07:10:00.000Z"); // published exactly at the cut-off
    await run(
      db,
      `INSERT INTO regime_daily (market, d, version, close_micro, raw_state, state, exit_streak)
       VALUES ('AU', '2026-10-16', 1, 1, 'SHOCK', 'SHOCK', 0)`,
    );
  }
  const view = createDecisionView(db, { market: "AU", d: D, cutoff: CUTOFF });
  const events = await eventsForDecision(view, { params: p, calendar, hours, indexCode: "AXJO" });
  const insider = await insiderFlowFor(view, "AAA", p, calendar, hours);
  const short = await shortInterestFor(view, "AAA", p, calendar);
  const prior = await view.priorRegime(1);
  const bars = (await view.bars("AAA", 50)).map((b) => `${b.d}:${b.close}`);
  return JSON.stringify({ events, insider, short, prior, bars });
}

describe("TST-109 unit: a poisoned future row is never read", () => {
  it("events, insider score, short interest, prior regime and bars are byte-identical", async () => {
    const clean = await bundle(false);
    const poisoned = await bundle(true);
    expect(poisoned).toBe(clean);
    const parsed = JSON.parse(clean) as {
      events: { ann_id: string }[];
      insider: { score_q: number };
    };
    expect(parsed.events.map((e) => e.ann_id)).toEqual(["e1"]);
    expect(parsed.insider.score_q).toBe(1);
  });

  it("is deterministic: two runs of the same inputs give identical bytes", async () => {
    expect(await bundle(true)).toBe(await bundle(true));
  });
});
