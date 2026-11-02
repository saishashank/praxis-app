// @vitest-environment node
// A2 events (M4 T6; AGT-020, ARN-020; design 2.3, decision 16): rule table, day-0 assignment by
// the continuous-trading end, exact abnormal return, polarity, event groups, DB reader through
// the cut-off view (a poisoned future row is never read), determinism. Synthetic data only.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60000 });
import { defaultAgentParams } from "@/lib/agents/params";
import {
  abnormalReturn,
  arOf,
  buildEventRow,
  classifyAnnouncement,
  day0Of,
  eventPolarity,
  eventsForDecision,
  groupEvents,
  EVENT_RULES_V1,
} from "@/lib/agents/events";
import { createDecisionView, decisionCutoffUtc } from "@/lib/agents/decisionView";
import type { CalendarRow, MarketHours } from "@/lib/data/calendar";
import { makeRational } from "@/lib/money/rational";
import { cleanupTempDbs, freshDb, ROOT } from "../db/helpers";

afterEach(cleanupTempDbs);

const p = defaultAgentParams();
const hours: MarketHours = { tz: "Australia/Sydney", open_time: "10:00", close_time: "16:00" };
// Oct 2026 is on AEDT (UTC+11): 15:50 local = 04:50Z, 16:00 = 05:00Z, 18:30 = 07:30Z.
const calendar: CalendarRow[] = [
  { d: "2026-10-14", kind: "early_close", close_time: "14:00" },
  { d: "2026-10-26", kind: "holiday", close_time: null },
];
const OFFSET = p.windows.day0CloseOffsetMin;

type Case = { type: string | null; title: string; category: string };
const cases = (
  JSON.parse(readFileSync(path.join(ROOT, "tests/fixtures/agents/events/rules.json"), "utf8")) as {
    cases: Case[];
  }
).cases;

describe("A2 events: rule table", () => {
  it("maps every fixture announcement to its category", () => {
    for (const c of cases) {
      expect(classifyAnnouncement(c.type, c.title).category, c.title).toBe(c.category);
    }
  });

  it("the ASX type code wins over the title; the first matching rule wins; unmatched is other", () => {
    expect(classifyAnnouncement("Trading Halt", "Company wins major contract").category).toBe(
      "halt_suspension",
    );
    expect(classifyAnnouncement(null, "Trading halt and capital raising").category).toBe(
      "halt_suspension",
    );
    expect(classifyAnnouncement("Whatever", "zzz").category).toBe("other");
    expect(classifyAnnouncement(null, "TRADING HALT").rule).toBe("title:halt");
    // word-bounded: "placementfoo" is not a placement
    expect(classifyAnnouncement(null, "placementfoo").category).toBe("other");
  });

  it("rule ids are unique and the table is versioned", () => {
    const ids = EVENT_RULES_V1.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("A2 events: day 0 (ARN-020)", () => {
  const at = (iso: string) => day0Of(iso, calendar, hours, OFFSET);

  it("published during the session: that session", () => {
    expect(at("2026-10-13T04:00:00.000Z")).toEqual({ day0: "2026-10-13", timed: true }); // 15:00
    expect(at("2026-10-12T23:30:00.000Z")).toEqual({ day0: "2026-10-13", timed: true }); // 10:30 pre-open? 10:30 local
  });

  it("published before the open on a trading day: that session", () => {
    expect(at("2026-10-12T20:00:00.000Z").day0).toBe("2026-10-13"); // 07:00 local Tue
  });

  it("at or after close minus the offset: the next session (boundary exact)", () => {
    expect(at("2026-10-13T04:49:59.999Z").day0).toBe("2026-10-13"); // 15:49:59.999
    expect(at("2026-10-13T04:50:00.000Z").day0).toBe("2026-10-14"); // 15:50
    expect(at("2026-10-13T05:00:00.000Z").day0).toBe("2026-10-14"); // 16:00 close
  });

  it("18:30 after D's close but before the cut-off has day 0 = D+1 (AC)", () => {
    const d = at("2026-10-13T07:30:00.000Z");
    expect(d.day0).toBe("2026-10-14");
    expect(
      new Date("2026-10-13T07:30:00.000Z").toISOString() <
        decisionCutoffUtc("2026-10-13", p.decisionCutoff),
    ).toBe(false);
  });

  it("an 18:00 item is before the 18:10 cut-off yet still day 0 = D+1", () => {
    const iso = "2026-10-13T07:00:00.000Z"; // 18:00 AEDT
    expect(iso < decisionCutoffUtc("2026-10-13", p.decisionCutoff)).toBe(true);
    expect(at(iso).day0).toBe("2026-10-14");
  });

  it("early-close day: continuous trading ends at 13:50", () => {
    expect(at("2026-10-14T02:49:00.000Z").day0).toBe("2026-10-14"); // 13:49
    expect(at("2026-10-14T02:50:00.000Z").day0).toBe("2026-10-15"); // 13:50
  });

  it("non-trading day (weekend, holiday): the next trading day", () => {
    expect(at("2026-10-17T01:00:00.000Z").day0).toBe("2026-10-19"); // Saturday noon
    expect(at("2026-10-26T01:00:00.000Z").day0).toBe("2026-10-27"); // holiday Monday
  });

  it("date-only (assumed time): its date if a trading day, else the next; flagged untimed", () => {
    expect(at("2026-10-13")).toEqual({ day0: "2026-10-13", timed: false });
    expect(at("2026-10-17")).toEqual({ day0: "2026-10-19", timed: false });
    expect(at("2026-10-26")).toEqual({ day0: "2026-10-27", timed: false });
  });

  it("the offset is a parameter, not a constant", () => {
    expect(day0Of("2026-10-13T04:30:00.000Z", calendar, hours, 0).day0).toBe("2026-10-13");
    expect(day0Of("2026-10-13T04:30:00.000Z", calendar, hours, 60).day0).toBe("2026-10-14");
  });
});

describe("A2 events: abnormal return and polarity", () => {
  it("AR is exact: 5 % stock move less 0.5 % index move is 9/200", () => {
    const ar = abnormalReturn(10_500_000n, 10_000_000n, 7_035_000_000n, 7_000_000_000n)!;
    expect(ar).toEqual(makeRational(9n, 200n));
  });

  it("a non-positive base gives null", () => {
    expect(abnormalReturn(1n, 0n, 1n, 1n)).toBeNull();
    expect(abnormalReturn(1n, 1n, 1n, 0n)).toBeNull();
  });

  it("fixed polarities by category regardless of AR", () => {
    const t = p.eventPolarityThreshold;
    const big = makeRational(-1n, 2n);
    expect(eventPolarity("guidance_up", big, t)).toBe(1);
    expect(eventPolarity("contract_win", null, t)).toBe(1);
    expect(eventPolarity("takeover_target", big, t)).toBe(1);
    expect(eventPolarity("guidance_down", makeRational(1n, 2n), t)).toBe(-1);
    expect(eventPolarity("capital_raising", null, t)).toBe(-1);
    expect(eventPolarity("exchange_query", null, t)).toBe(-1);
    expect(eventPolarity("halt_suspension", null, t)).toBe(-1);
  });

  it("results and others take sign(AR) only when |AR| is strictly above the threshold", () => {
    const t = p.eventPolarityThreshold; // 2 %
    expect(t).toEqual(makeRational(1n, 50n));
    expect(eventPolarity("results", makeRational(1n, 50n), t)).toBe(0); // exactly 2 %
    expect(eventPolarity("results", makeRational(1n, 49n), t)).toBe(1);
    expect(eventPolarity("results", makeRational(-1n, 49n), t)).toBe(-1);
    expect(eventPolarity("other", makeRational(-1n, 50n), t)).toBe(0);
    expect(eventPolarity("director_trade", null, t)).toBe(0);
    expect(eventPolarity("dividend_change", makeRational(3n, 100n), t)).toBe(1);
  });
});

describe("A2 events: row and groups", () => {
  const ann = (id: string, title: string, published: string, code = "AAA") => ({
    source: "asx",
    ann_id: id,
    code,
    published_at: published,
    type: null,
    title,
    price_sensitive: 1 as const,
  });

  it("builds the row with exact AR text, ppm, volume ratio and rule version", () => {
    const volumes = [...Array.from({ length: 20 }, () => 1000n), 3000n];
    const row = buildEventRow(
      "AU",
      ann("a1", "Full Year Results", "2026-10-13T01:00:00.000Z"),
      { day0: "2026-10-13", timed: true },
      {
        close0: 10_500_000n,
        closePrev: 10_000_000n,
        index0: 7_035_000_000n,
        indexPrev: 7_000_000_000n,
        volumes,
      },
      p,
    );
    expect(row).toMatchObject({
      category: "results",
      day0_d: "2026-10-13",
      group_key: "AAA:2026-10-13",
      timed: 1,
      ar_num: "9",
      ar_den: "200",
      ar_ppm: 45000,
      vol_ratio_ppm: 3_000_000,
      polarity: 1,
      rule_version: "events-v2",
      category_llm: null,
      polarity_llm: null,
    });
    expect(arOf(row)).toEqual(makeRational(9n, 200n));
  });

  it("without a day-0 bar the AR and ratio are NULL and results get polarity 0", () => {
    const row = buildEventRow(
      "AU",
      ann("a2", "Half Year Results", "2026-10-13T01:00:00.000Z"),
      { day0: "2026-10-13", timed: true },
      null,
      p,
    );
    expect([row.ar_num, row.ar_den, row.ar_ppm, row.vol_ratio_ppm]).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(row.polarity).toBe(0);
  });

  it("several announcements of one code on one day 0 form one group; keys are sorted", () => {
    const mk = (id: string, code: string, day0: string) =>
      buildEventRow(
        "AU",
        ann(id, "x", "2026-10-13T01:00:00.000Z", code),
        { day0, timed: true },
        null,
        p,
      );
    const groups = groupEvents([
      mk("b", "AAA", "2026-10-13"),
      mk("a", "AAA", "2026-10-13"),
      mk("c", "AAA", "2026-10-14"),
      mk("d", "BBB", "2026-10-13"),
    ]);
    expect(groups.map((g) => g.key)).toEqual([
      "AAA:2026-10-13",
      "AAA:2026-10-14",
      "BBB:2026-10-13",
    ]);
    expect(groups[0]!.members).toEqual(["asx|a", "asx|b"]);
  });
});

// ---- DB: eventsForDecision through the cut-off view ----

const D = "2026-10-15"; // Thursday
const CUTOFF = decisionCutoffUtc(D, p.decisionCutoff);

async function seed(db: Awaited<ReturnType<typeof freshDb>>, poison: boolean): Promise<void> {
  const stmts: { sql: string; args: (string | number)[] }[] = [];
  const bar = (code: string, d: string, c: number, v: number) =>
    stmts.push({
      sql: `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
            VALUES ('AU', ?, ?, ?, ?, ?, ?, ?, 'test', ?, ?)`,
      args: [code, d, c, c, c, c, v, `${d}T06:00:00.000Z`, `${d}T06:05:00.000Z`],
    });
  const idx = (d: string, c: number) =>
    stmts.push({
      sql: `INSERT INTO index_bar (market, index_code, d, o_micro, h_micro, l_micro, c_micro, source, published_at, ingested_at)
            VALUES ('AU', 'AXJO', ?, ?, ?, ?, ?, 'test', ?, ?)`,
      args: [d, c, c, c, c, `${d}T06:00:00.000Z`, `${d}T06:05:00.000Z`],
    });
  // 22 weekday sessions ending 2026-10-14 for AAA (volume 1000, day 0 3000), index flat then +0.5 %
  const days: string[] = [];
  for (let i = 0; i < 40; i++) {
    const d = new Date(Date.UTC(2026, 9, 14 - i));
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    if (days.length < 22) days.unshift(d.toISOString().slice(0, 10));
  }
  days.forEach((d, i) => {
    const last = i === days.length - 1;
    bar("AAA", d, last ? 10.5 : 10, last ? 3000 : 1000);
    idx(d, last ? 7_035_000_000 : 7_000_000_000);
  });
  const ann = (id: string, code: string, title: string, published: string) =>
    stmts.push({
      sql: `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, price_sensitive, title, source)
            VALUES ('AU', ?, ?, ?, ?, NULL, 1, ?, 'asx')`,
      args: [code, id, published, published, title],
    });
  ann("n1", "AAA", "Full Year Results", "2026-10-14T01:00:00.000Z"); // Wed 12:00 -> day 0 Wed
  ann("n2", "AAA", "Company wins major contract", "2026-10-14"); // untimed -> Wed
  ann("n3", "AAA", "Trading update", "2026-10-15T07:00:00.000Z"); // Thu 18:00: before cut-off, day 0 Fri
  if (poison) {
    ann("p1", "AAA", "Company upgrades FY earnings guidance", "2026-10-15T07:10:00.000Z"); // exactly the cut-off
    ann("p2", "AAA", "Profit warning", "2026-10-15T07:30:00.000Z");
    ann("p3", "AAA", "Profit warning", "2026-10-16");
    bar("AAA", "2026-10-15", 99, 99999);
    bar("AAA", "2026-10-16", 1, 1);
    idx("2026-10-15", 1);
    idx("2026-10-16", 1);
  }
  await db.batch(stmts);
}

async function run(poison: boolean) {
  const db = await freshDb("main");
  await seed(db, poison);
  const view = createDecisionView(db, { market: "AU", d: D, cutoff: CUTOFF });
  return eventsForDecision(view, { params: p, calendar, hours, indexCode: "AXJO" });
}

describe("A2 events: reader (TST-109 unit: a poisoned future row is never read)", () => {
  it("records events with day 0 <= D and skips the D+1 item", async () => {
    const rows = await run(false);
    expect(rows.map((r) => r.ann_id).sort()).toEqual(["n1", "n2"]);
    const n1 = rows.find((r) => r.ann_id === "n1")!;
    expect(n1).toMatchObject({ day0_d: "2026-10-14", timed: 1, category: "results", polarity: 1 });
    expect([n1.ar_num, n1.ar_den]).toEqual(["9", "200"]);
    expect(n1.vol_ratio_ppm).toBe(3_000_000);
    const n2 = rows.find((r) => r.ann_id === "n2")!;
    expect(n2).toMatchObject({
      timed: 0,
      day0_d: "2026-10-14",
      category: "contract_win",
      polarity: 1,
    });
    expect(n1.group_key).toBe(n2.group_key);
    expect(groupEvents(rows)).toHaveLength(1);
  });

  it("rows after the cut-off, at the cut-off, and bars/index after D change nothing", async () => {
    const clean = await run(false);
    const poisoned = await run(true);
    expect(JSON.stringify(poisoned)).toBe(JSON.stringify(clean));
  });

  it("is deterministic across runs", async () => {
    expect(JSON.stringify(await run(true))).toBe(JSON.stringify(await run(true)));
  });

  it("already-recorded events are not produced again", async () => {
    const db = await freshDb("main");
    await seed(db, false);
    await db.execute({
      sql: `INSERT INTO event (market, source, ann_id, code, published_at, timed, day0_d, group_key, category, price_sensitive, polarity, rule_version)
            VALUES ('AU', 'asx', 'n1', 'AAA', '2026-10-14T01:00:00.000Z', 1, '2026-10-14', 'AAA:2026-10-14', 'results', 1, 0, 'events-v1')`,
      args: [],
    });
    const view = createDecisionView(db, { market: "AU", d: D, cutoff: CUTOFF });
    const rows = await eventsForDecision(view, { params: p, calendar, hours, indexCode: "AXJO" });
    expect(rows.map((r) => r.ann_id)).toEqual(["n2"]);
  });

  it("restricts to tracked codes", async () => {
    const db = await freshDb("main");
    await seed(db, false);
    const view = createDecisionView(db, { market: "AU", d: D, cutoff: CUTOFF });
    expect(
      await eventsForDecision(view, {
        params: p,
        calendar,
        hours,
        indexCode: "AXJO",
        codes: ["ZZZ"],
      }),
    ).toEqual([]);
  });

  it("an item whose day-0 bar is missing is recorded with NULL AR", async () => {
    const db = await freshDb("main");
    await seed(db, false);
    await db.execute({
      sql: `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, price_sensitive, title, source)
            VALUES ('AU', 'NOBAR', 'q1', '2026-10-14T01:00:00.000Z', '2026-10-14T01:00:00.000Z', NULL, 0, 'Half Year Results', 'asx')`,
      args: [],
    });
    const view = createDecisionView(db, { market: "AU", d: D, cutoff: CUTOFF });
    const rows = await eventsForDecision(view, { params: p, calendar, hours, indexCode: "AXJO" });
    const q1 = rows.find((r) => r.ann_id === "q1")!;
    expect([q1.ar_num, q1.polarity]).toEqual([null, 0]);
  });
});
