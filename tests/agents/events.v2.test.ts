// @vitest-environment node
// M14 WP5 (AGT-135, AGT-138, DAT-232, DAT-237; D-236, D-240, D-241): events-v2 details, the
// reversal flag, split-adjusted day-0 volume, no event for a duplicate announcement, and the
// split-frequency summary. Synthetic data only.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDecisionView, decisionCutoffUtc } from "@/lib/agents/decisionView";
import {
  buildEventRow,
  classifyAnnouncement,
  eventsForDecision,
  EVENT_RULE_VERSION,
  splitAdjustedVolumes,
  type EventContext,
} from "@/lib/agents/events";
import { eventFactFromRow, reversedNextClose } from "@/lib/agents/families/facts";
import { defaultAgentParams } from "@/lib/agents/params";
import type { CalendarRow, MarketHours } from "@/lib/data/calendar";
import { makeRational } from "@/lib/money/rational";
import { summarise } from "../../scripts/data/split-frequency.mjs";
import { cleanupTempDbs, freshDb, ROOT } from "../db/helpers";

vi.setConfig({ testTimeout: 60000 });
afterEach(cleanupTempDbs);

const p = defaultAgentParams();
const hours: MarketHours = { tz: "Australia/Sydney", open_time: "10:00", close_time: "16:00" };
const calendar: CalendarRow[] = [];

type Case = { type: string | null; title: string; category: string; detail: string | null };
const cases = (
  JSON.parse(readFileSync(path.join(ROOT, "tests/fixtures/agents/events/detail.json"), "utf8")) as {
    cases: Case[];
  }
).cases;

const ann = (title: string) => ({
  source: "asx",
  ann_id: "x",
  code: "AAA",
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

describe("events-v2: category_detail (AGT-135, AGT-138)", () => {
  it("the rule version is events-v2", () => {
    expect(EVENT_RULE_VERSION).toBe("events-v2");
  });

  it("every fixture title gets its category and detail", () => {
    for (const c of cases) {
      const r = classifyAnnouncement(c.type, c.title);
      expect([r.category, r.detail], c.title).toEqual([c.category, c.detail]);
    }
  });

  it("a query response stays polarity -1; guidance maintained takes the AR sign", () => {
    const q = buildEventRow("AU", ann("Response to ASX price query"), day0, null, p);
    expect([q.category, q.category_detail, q.polarity, q.rule_version]).toEqual([
      "exchange_query",
      "query_response",
      -1,
      "events-v2",
    ]);
    const up = buildEventRow("AU", ann("Reaffirms FY guidance"), day0, market(10_500_000n), p);
    const down = buildEventRow("AU", ann("Reaffirms FY guidance"), day0, market(9_500_000n), p);
    expect([up.category, up.category_detail, up.polarity]).toEqual([
      "other",
      "guidance_maintained",
      1,
    ]);
    expect(down.polarity).toBe(-1);
    expect(buildEventRow("AU", ann("Full Year Results"), day0, null, p).category_detail).toBeNull();
  });
});

describe("reversal flag (AGT-135, display only)", () => {
  const up = makeRational(9n, 200n);
  const down = makeRational(-9n, 200n);
  it("is true when the next close moves against the day-0 AR", () => {
    expect(reversedNextClose(up, 10_500_000n, 10_000_000n)).toBe(true);
    expect(reversedNextClose(down, 9_500_000n, 9_900_000n)).toBe(true);
  });
  it("is false when it continues, and null when unknown or flat", () => {
    expect(reversedNextClose(up, 10_500_000n, 10_900_000n)).toBe(false);
    expect(reversedNextClose(up, 10_500_000n, null)).toBeNull();
    expect(reversedNextClose(up, 10_500_000n, 10_500_000n)).toBeNull();
    expect(reversedNextClose(null, 10_500_000n, 10_000_000n)).toBeNull();
  });
  it("reaches the fact only when the closes are passed; detail comes from the row", () => {
    const row = buildEventRow(
      "AU",
      ann("Response to ASX price query"),
      day0,
      market(10_500_000n),
      p,
    );
    const plain = eventFactFromRow(row, null);
    expect(plain.categoryDetail).toBe("query_response");
    expect("reversedNextClose" in plain).toBe(false);
    const withNext = eventFactFromRow(row, null, {
      day0Close: 10_500_000n,
      nextClose: 10_100_000n,
    });
    expect(withNext.reversedNextClose).toBe(true);
  });
});

describe("split-adjusted volume (DAT-232)", () => {
  it("multiplies bars before the ex-date by the ratio and leaves later bars alone", () => {
    const bars = [
      { d: "2026-10-01", volume: 1000n },
      { d: "2026-10-05", volume: 1000n },
      { d: "2026-10-06", volume: 1000n },
    ];
    const out = splitAdjustedVolumes(bars, [{ exDate: "2026-10-05", ratio: makeRational(2n) }]);
    expect(out).toEqual([2000n, 1000n, 1000n]); // the ex-date bar itself is post-split
    expect(splitAdjustedVolumes(bars, [])).toEqual([1000n, 1000n, 1000n]);
  });
});

const D = "2026-10-15";
const CUTOFF = decisionCutoffUtc(D, p.decisionCutoff);
type Titles = [string, string, string][];

async function seed(db: Awaited<ReturnType<typeof freshDb>>, titles: Titles) {
  const stmts: { sql: string; args: (string | number)[] }[] = [];
  const days: string[] = [];
  for (let i = 0; i < 40; i++) {
    const d = new Date(Date.UTC(2026, 9, 14 - i));
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    if (days.length < 22) days.unshift(d.toISOString().slice(0, 10));
  }
  days.forEach((d, i) => {
    const last = i === days.length - 1;
    const c = last ? 10.5 : 10;
    stmts.push({
      sql: `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
            VALUES ('AU', 'AAA', ?, ?, ?, ?, ?, ?, 'test', ?, ?)`,
      args: [d, c, c, c, c, last ? 3000 : 1000, `${d}T06:00:00.000Z`, `${d}T06:05:00.000Z`],
    });
    const x = last ? 7_035_000_000 : 7_000_000_000;
    stmts.push({
      sql: `INSERT INTO index_bar (market, index_code, d, o_micro, h_micro, l_micro, c_micro, source, published_at, ingested_at)
            VALUES ('AU', 'AXJO', ?, ?, ?, ?, ?, 'test', ?, ?)`,
      args: [d, x, x, x, x, `${d}T06:00:00.000Z`, `${d}T06:05:00.000Z`],
    });
  });
  for (const [id, title, published] of titles) {
    stmts.push({
      sql: `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, price_sensitive, title, source)
            VALUES ('AU', 'AAA', ?, ?, ?, NULL, 1, ?, 'asx')`,
      args: [id, published, published, title],
    });
  }
  await db.batch(stmts);
}

const LONG = "Company announces full year results and final dividend for the year ended June";

async function run(titles: Titles, extra: Partial<EventContext> = {}) {
  const db = await freshDb("main");
  await seed(db, titles);
  const view = createDecisionView(db, { market: "AU", d: D, cutoff: CUTOFF });
  return eventsForDecision(view, { params: p, calendar, hours, indexCode: "AXJO", ...extra });
}

describe("eventsForDecision: duplicates and splits", () => {
  it("an exact repost and a near-duplicate title give no second event", async () => {
    const rows = await run([
      ["d1", LONG, "2026-10-13T01:00:00.000Z"],
      ["d2", LONG, "2026-10-13T02:00:00.000Z"], // exact repost
      ["d3", `${LONG} 2026`, "2026-10-14T01:00:00.000Z"], // near-duplicate, next day
      ["d4", "Trading update on the ASX", "2026-10-14T02:00:00.000Z"],
    ]);
    expect(rows.map((r) => r.ann_id).sort()).toEqual(["d1", "d4"]);
  });

  it("a duplicate of an already recorded event gives no event either", async () => {
    const db = await freshDb("main");
    await seed(db, [
      ["d1", LONG, "2026-10-13T01:00:00.000Z"],
      ["d2", LONG, "2026-10-14T01:00:00.000Z"],
    ]);
    await db.execute({
      sql: `INSERT INTO event (market, source, ann_id, code, published_at, timed, day0_d, group_key, category, price_sensitive, polarity, rule_version)
            VALUES ('AU', 'asx', 'd1', 'AAA', '2026-10-13T01:00:00.000Z', 1, '2026-10-13', 'AAA:2026-10-13', 'other', 1, 0, 'events-v1')`,
      args: [],
    });
    const view = createDecisionView(db, { market: "AU", d: D, cutoff: CUTOFF });
    const rows = await eventsForDecision(view, { params: p, calendar, hours, indexCode: "AXJO" });
    expect(rows).toEqual([]);
  });

  it("is deterministic", async () => {
    const t: Titles = [["d1", LONG, "2026-10-13T01:00:00.000Z"]];
    expect(JSON.stringify(await run(t))).toBe(JSON.stringify(await run(t)));
  });

  it("a split inside the window changes the day-0 volume ratio to the adjusted one", async () => {
    const t: Titles = [["d1", "Full Year Results", "2026-10-14T01:00:00.000Z"]];
    const raw = (await run(t))[0]!;
    const adj = (
      await run(t, { splitsFor: () => [{ exDate: "2026-10-05", ratio: makeRational(2n) }] })
    )[0]!;
    expect(raw.vol_ratio_ppm).toBe(3_000_000);
    expect(adj.vol_ratio_ppm).toBeLessThan(raw.vol_ratio_ppm!);
    expect(adj.vol_ratio_ppm).toBeGreaterThan(0);
  });
});

describe("split-frequency summary (DAT-232)", () => {
  it("counts per year, share of codes and of windows touched", () => {
    const dates = Array.from({ length: 30 }, (_, i) => `2026-01-${String(i + 1).padStart(2, "0")}`);
    const out = summarise(
      [
        { code: "AAA", exDate: "2026-01-15", type: "split" },
        { code: "AAA", exDate: "2026-01-16", type: "dividend" },
      ],
      new Map([
        ["AAA", dates],
        ["BBB", dates],
      ]),
      20,
    );
    expect(out.actions).toBe(1);
    expect(out.perYear).toEqual({ "2026": 1 });
    expect(out.codesWithBars).toBe(2);
    expect(out.codesWithSplitPct).toBe(50);
    // 11 windows per code (ending day 20..30); every AAA window contains day 15
    expect(out.windows).toBe(22);
    expect(out.windowsTouched).toBe(11);
    expect(out.windowsTouchedPct).toBe(50);
  });
});
