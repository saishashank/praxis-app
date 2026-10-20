// @vitest-environment node
// M6 T16 (TST-103, TST-123; D-110 #3/#23/#41, D-116, D-123, D-124): the M6 jobs around the Sydney clock
// changes (2026-10-04 AEST->AEDT, 2027-04-04 AEDT->AEST) and across day types.
//  - the `kb-archive` slot (22:15, the only new Worker slot): UTC instants, one fire per local day on
//    23-hour and 25-hour days, catch-up window, the Melbourne date the archive run stamps;
//  - the weekly learning run has no Worker slot (replay mode `learning` is dispatched by hand, D-124):
//    its idempotency unit, the ISO week, and its Friday data cut-off are checked on the switch weeks and
//    around a public holiday;
//  - the TST-123 matrix for `learn` and `words`: phase x trading day / weekend / holiday / half day x
//    market mode (full, data_only, off), with the status, variant and idempotency each cell must give.
// The Worker dispatch with the switches is worker/test/m6Slots.test.ts.
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { defaultAgentParams } from "@/lib/agents/params";
import { localToUtc, marketDate, previousTradingDay, type CalendarRow } from "@/lib/data/calendar";
import { melbourneDay } from "@/lib/kb/archiveCli";
import { learnDay } from "@/lib/learning/learnStage";
import { wordsDay, type WordsLlm } from "@/lib/learning/wordsStage";
import { MemoryStore } from "@/lib/llm/store";
import { learningRunId, learningWeek } from "@/lib/replay/learningMode";
import { candidateSlots } from "../../worker/src/clock";
import { sydneyLocal } from "../../worker/src/localtime";
import { AU_SLOTS } from "../../worker/src/schedule";
import { cleanupTempDbs } from "../db/helpers";
import { makeRouter } from "../llm/helpers";
import { MARKET, addNight, lightWorld, nowFor } from "./../learning/learnHelpers";

afterEach(cleanupTempDbs);

const MIN = 60_000;
const TZ = "Australia/Sydney";
const params = defaultAgentParams();

/** `offset` = hours from UTC in force after the small-hours change on that Sydney date. */
const DAYS: { date: string; offset: 10 | 11; what: string }[] = [
  { date: "2026-10-02", offset: 10, what: "Fri before the AEDT start" },
  { date: "2026-10-03", offset: 10, what: "Sat before the AEDT start" },
  { date: "2026-10-04", offset: 11, what: "Sun, spring forward 02:00->03:00 (23 h)" },
  { date: "2026-10-05", offset: 11, what: "Mon after the AEDT start" },
  { date: "2027-04-02", offset: 11, what: "Fri before the AEST start" },
  { date: "2027-04-03", offset: 11, what: "Sat before the AEST start" },
  { date: "2027-04-04", offset: 10, what: "Sun, fall back 03:00->02:00 (25 h)" },
  { date: "2027-04-05", offset: 10, what: "Mon after the AEST start" },
];

const utc = (date: string, time: string, offset: number): string => {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return new Date(Date.UTC(y!, mo! - 1, d!, h! - offset, mi)).toISOString();
};

/** Every UTC minute whose Sydney date is `date`, with the Worker's own local clock. */
function ticksOf(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  const out: { t: number; l: ReturnType<typeof sydneyLocal> }[] = [];
  const from = Date.UTC(y!, m! - 1, d!) - 14 * 60 * MIN;
  for (let t = from; t < from + 52 * 60 * MIN; t += MIN) {
    const l = sydneyLocal(t);
    if (l.date === date) out.push({ t, l });
  }
  return out;
}

const KB = AU_SLOTS.find((s) => s.id === "kb-archive")!;
// M8 T8 (D-155): "stays off until the Owner turns it on" = disabled, or a go-live slot that runs only once listed.
const offUntilOwner = (s: { enabled: boolean; requiresListing?: boolean }) =>
  !s.enabled || s.requiresListing === true;

describe("the M6 slots as shipped (D-116)", () => {
  it("kb-archive is the only M6 slot: 22:15, dispatch-only workflow, disabled, every day, not market-bound", () => {
    expect(KB).toMatchObject({
      time: "22:15",
      runner: "actions",
      workflow: "kb-archive.yml",
      tradingDaysOnly: false,
      marketBound: false,
      catchUpMin: 60,
    });
    expect(offUntilOwner(KB)).toBe(true);
    // no slot for learn, words or the weekly learning run: A6 rides the batch-3 workflow and replay
    // mode `learning` is dispatched by hand (D-123, D-124)
    expect(AU_SLOTS.filter((s) => /learn|words|lesson|critic/i.test(s.id))).toEqual([]);
    const replay = AU_SLOTS.find((s) => s.id === "replay")!;
    expect(replay).toMatchObject({ workflow: "replay.yml" });
    expect(offUntilOwner(replay)).toBe(true);
  });
});

describe("TST-103: kb-archive instants around both clock changes", () => {
  for (const day of DAYS) {
    it(`${day.date} ${day.what}: 22:15 local is one UTC instant, fired once, window 22:15-23:15`, () => {
      const expected = utc(day.date, "22:15", day.offset);
      // independent Intl oracle
      expect(localToUtc(day.date, "22:15", TZ).toISOString()).toBe(expected);
      // 22:15 is after the 02:00-03:00 change hour: the sweep sees the minute exactly once
      const ticks = ticksOf(day.date);
      expect(ticks.length).toBe(
        day.date === "2026-10-04" ? 23 * 60 : day.date === "2027-04-04" ? 25 * 60 : 24 * 60,
      );
      const fire = ticks.filter((x) => x.l.minute === KB.minute);
      expect(fire.map((x) => new Date(x.t).toISOString())).toEqual([expected]);
      // the open window (catch-up included) is 61 consecutive minutes, none repeated, on this date
      const on = AU_SLOTS.map((s) =>
        s.id === "kb-archive" ? { ...s, enabled: true, requiresListing: false } : s,
      );
      const open = ticks.filter((x) => candidateSlots(x.l, on).some((s) => s.id === "kb-archive"));
      expect(open.length).toBe(KB.catchUpMin + 1);
      expect(new Date(open[0]!.t).toISOString()).toBe(expected);
      expect(new Date(open.at(-1)!.t).toISOString()).toBe(utc(day.date, "23:15", day.offset));
      // the shipped table offers it only as a go-live slot: the clock holds it until the Owner
      // lists it in `slots_enabled` (M8 T8, D-155; the hold itself is tested in the Worker suite)
      expect(offUntilOwner(KB)).toBe(true);
    });
  }

  it("at 23:00 the nightly slots keep their order and the archive goes last (priority)", () => {
    const on = AU_SLOTS.map((s) =>
      s.id === "kb-archive" ? { ...s, enabled: true, requiresListing: false } : s,
    );
    for (const day of DAYS) {
      const l = sydneyLocal(Date.parse(utc(day.date, "23:00", day.offset)));
      expect(candidateSlots(l, on).map((s) => s.id)).toEqual([
        "maintenance",
        "backup",
        "kb-archive",
      ]);
    }
  });

  it("the archive stamps the Melbourne date of its start: the same date as the Sydney clock, on every instant of the window", () => {
    for (const day of DAYS) {
      for (const hm of ["22:15", "22:45", "23:15"]) {
        const at = new Date(utc(day.date, hm, day.offset));
        expect(melbourneDay(at)).toBe(day.date);
        expect(marketDate(at, TZ)).toBe(day.date);
        expect(sydneyLocal(at.getTime()).date).toBe(day.date);
      }
    }
  });
});

describe("weekly learning run: ISO week is the idempotency unit (D-124)", () => {
  const SATURDAYS = ["2026-10-03", "2027-04-03", "2026-10-17", "2027-03-27"];
  it("the Sunday after a Saturday run and the Friday before it share its week; the next Monday does not", () => {
    for (const sat of SATURDAYS) {
      const dayMs = Date.parse(`${sat}T00:00:00Z`);
      const at = (n: number): string => new Date(dayMs + n * 86_400_000).toISOString().slice(0, 10);
      expect(new Date(`${sat}T00:00:00Z`).getUTCDay()).toBe(6);
      expect(learningWeek(at(-1))).toBe(learningWeek(sat));
      expect(learningWeek(at(1))).toBe(learningWeek(sat)); // the clock-change Sunday is in the same week
      expect(learningWeek(at(2))).not.toBe(learningWeek(sat));
    }
  });

  it("the run id names market, week, snapshot and commit and nothing wall-clock", () => {
    expect(learningRunId("AU", learningWeek("2026-10-03"), "a".repeat(64), "c".repeat(40))).toBe(
      `replay:learning:AU:${learningWeek("2026-10-03")}:aaaaaaaa:cccccccc`,
    );
  });

  it("the data cut-off of a Saturday run is the last trading day before it: Friday, Thursday after a holiday Friday", () => {
    const hol: CalendarRow[] = [{ d: "2026-12-25", kind: "holiday", close_time: null }];
    expect(previousTradingDay("2026-10-03", [])).toBe("2026-10-02");
    expect(previousTradingDay("2027-04-03", [])).toBe("2027-04-02");
    expect(previousTradingDay("2026-12-26", hol)).toBe("2026-12-24"); // Christmas Day is a Friday in 2026
  });
});

// ---- TST-123: learn and words by phase x day type x market mode ---------------------------------

const CAL: CalendarRow[] = [
  { d: "2026-12-24", kind: "early_close", close_time: "14:10" },
  { d: "2026-12-25", kind: "holiday", close_time: null },
  { d: "2026-12-28", kind: "holiday", close_time: null },
];

type Kind = "trading" | "weekend" | "holiday" | "half";
const CASES: { d: string; kind: Kind; what: string }[] = [
  { d: "2026-10-02", kind: "trading", what: "Fri before AEDT" },
  { d: "2026-10-03", kind: "weekend", what: "Sat before AEDT" },
  { d: "2026-10-04", kind: "weekend", what: "Sun, AEDT starts" },
  { d: "2026-10-05", kind: "trading", what: "Mon after AEDT" },
  { d: "2027-04-02", kind: "trading", what: "Fri before AEST" },
  { d: "2027-04-03", kind: "weekend", what: "Sat before AEST" },
  { d: "2027-04-04", kind: "weekend", what: "Sun, AEST starts" },
  { d: "2027-04-05", kind: "trading", what: "Mon after AEST" },
  { d: "2026-12-25", kind: "holiday", what: "Christmas Day (Fri)" },
  { d: "2026-12-28", kind: "holiday", what: "Boxing Day substitute (Mon)" },
  { d: "2026-12-24", kind: "half", what: "early close 14:10" },
];

const llm = (): WordsLlm => {
  const store = new MemoryStore();
  return {
    r5Router: makeRouter("rules-only", [], store).router,
    providers: [],
    routerFor: () => makeRouter("rules-only", [], store).router,
    store,
  };
};

const learn = (db: Client, d: string, over: Record<string, unknown> = {}) =>
  learnDay(db, { market: MARKET, d, now: nowFor(d), params, calendar: CAL, ...over });
const words = (db: Client, d: string) =>
  wordsDay(db, { market: MARKET, d, now: nowFor(d), params, calendar: CAL, llm });
const count = async (db: Client, table: string): Promise<number> =>
  Number((await db.execute(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0]!.n);

describe("TST-123 matrix: learn and words by day type, market mode and predecessor", () => {
  for (const c of CASES) {
    const reduced = c.kind === "weekend" || c.kind === "holiday";

    it(`${c.d} (${c.what}, ${c.kind}) market full: ${reduced ? "reduced learn" : "learn full after batch 3, partial without it"}, then words, then both already_done`, async () => {
      const db = await lightWorld("full");
      if (!reduced) await addNight(db, c.d);
      const l = await learn(db, c.d);
      expect(l.status).toBe("success");
      expect(l.stats.variant).toBe(reduced ? "reduced" : "full");
      expect(l.stats.stepsFailed).toEqual([]);
      const w = await words(db, c.d);
      expect(["success", "degraded"]).toContain(w.status);
      expect((await learn(db, c.d)).status).toBe("already_done");
      expect((await words(db, c.d)).status).toBe("already_done");
      const jobs = (
        await db.execute("SELECT job FROM run_record WHERE job IN ('arena-learn','arena-words')")
      ).rows.map((r) => String(r.job));
      expect(jobs.sort()).toEqual(["arena-learn", "arena-words"]);
    });

    if (!reduced) {
      it(`${c.d} (${c.what}) without batch 3: partial learn, degraded, reason batch3_missing`, async () => {
        const db = await lightWorld("full");
        const l = await learn(db, c.d);
        expect(l.status).toBe("degraded");
        expect(l.stats.variant).toBe("partial");
        expect(l.stats.partialReason).toBe("batch3_missing");
      });
    }

    it(`${c.d} (${c.what}) market data_only: both phases skip with data_only_guard and write no learning table`, async () => {
      const db = await lightWorld("data_only");
      const l = await learn(db, c.d);
      const w = await words(db, c.d);
      expect([l.status, l.reason]).toEqual(["skipped", "data_only_guard"]);
      expect(w.status).toBe("skipped");
      expect(w.reason).toBe("data_only_guard");
      for (const t of [
        "attribution",
        "comparison_result",
        "plan_item",
        "plan_review",
        "playbook_version",
        "critique",
      ]) {
        expect(await count(db, t), t).toBe(0);
      }
    });

    it(`${c.d} (${c.what}) market off: both phases skip with market_off`, async () => {
      const db = await lightWorld("full");
      await db.execute({ sql: "UPDATE market SET mode = 'off' WHERE code = ?", args: [MARKET] });
      expect((await learn(db, c.d)).reason).toBe("market_off");
      expect((await words(db, c.d)).reason).toBe("market_off");
    });
  }

  it("a replay may run learn on a data_only market (D-066 explicit replay), reduced on a Saturday", async () => {
    const db = await lightWorld("data_only");
    const l = await learn(db, "2026-10-03", { replay: true });
    expect(l.status).toBe("success");
    expect(l.stats.variant).toBe("reduced");
  });

  it("an exhausted loop budget stops the remaining steps, is logged, and the run still finishes without failing", async () => {
    const db = await lightWorld("full");
    await addNight(db, "2026-10-05");
    const step = (params.learning.learningLoopMinutes + 1) * MIN;
    let t = 0;
    const l = await learn(db, "2026-10-05", { clockMs: () => (t += step) });
    expect(l.stats.stoppedForBudget).toBe(true);
    expect(l.status).not.toBe("failed");
    const log = await db.execute(
      "SELECT message FROM app_log WHERE message LIKE '%loop budget spent%'",
    );
    expect(log.rows.length).toBeGreaterThan(0);
  });
});
