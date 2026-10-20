// @vitest-environment node
// M5 T14 (TST-103, EML-033, PLT-019, NFR-012; D-059, D-060, D-096 decisions 11/14/26, D-106, D-107,
// D-108): every M5 slot on the days around both Sydney clock changes (2026-10-04 AEST->AEDT and
// 2027-04-04 AEDT->AEST), checked as pure arithmetic against the Intl-based calendar library.
//  - the UTC instants of each slot (Worker table, routeSlotsDue / pollDue) per day, with literal
//    expected values and an independent Intl oracle (localToUtc);
//  - a 23-hour and a 25-hour day lose and repeat no minute, and no M5 slot fires twice or is missed;
//  - catch-up windows; trading-day vs every-day behaviour; the YAML watchdog cron lines; and
//    the NFR-012 median over a series of simulated alerts through the real P0 delivery path.
// The Worker integration (runRoutes, TST-123 matrix, TST-124 CPU) is worker/test/m5Slots.test.ts.
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { cronLines, cronLinesFor, slotForSchedule } from "../../scripts/time/genWatchdogCron.mjs";
import { localToUtc, marketDate, isTradingDay, type CalendarRow } from "@/lib/data/calendar";
import { processAssessments, type AlertCtx } from "@/lib/alerts/deliver";
import { createMockProvider } from "@/lib/email/mock";
import { pollDue } from "../../worker/src/asx/slots";
import { sydneyLocal, isWeekend } from "../../worker/src/localtime";
import { routeSlotsDue } from "../../worker/src/routes";
import { AU_SLOTS, type Slot } from "../../worker/src/schedule";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const MIN = 60_000;
const TZ = "Australia/Sydney";
const ALL: Slot[] = AU_SLOTS.map((s) =>
  s.runner === "route" ? { ...s, enabled: true, requiresListing: false } : s,
);
// The table without the odd-minute alert-flush slot, for checks on the slots that sit on odd minutes.
const NF: Slot[] = ALL.filter((s) => s.id !== "alert-flush");
const M5 = [
  "alert-flush",
  "pre-open",
  "pre-open-retry",
  "evening-review",
  "evening-review-late",
  "morning",
];
const hm = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** `offset` = hours from UTC in force after the small-hours change on that Sydney date. */
const DAYS: { date: string; offset: 10 | 11; what: string; weekend: boolean }[] = [
  { date: "2026-10-02", offset: 10, what: "Fri before the AEDT start", weekend: false },
  { date: "2026-10-03", offset: 10, what: "Sat before the AEDT start", weekend: true },
  { date: "2026-10-04", offset: 11, what: "Sun, spring forward 02:00->03:00", weekend: true },
  { date: "2026-10-05", offset: 11, what: "Mon after the AEDT start", weekend: false },
  { date: "2027-04-02", offset: 11, what: "Fri before the AEST start", weekend: false },
  { date: "2027-04-03", offset: 11, what: "Sat before the AEST start", weekend: true },
  { date: "2027-04-04", offset: 10, what: "Sun, fall back 03:00->02:00", weekend: true },
  { date: "2027-04-05", offset: 10, what: "Mon after the AEST start", weekend: false },
];

type Tick = { t: number; l: ReturnType<typeof sydneyLocal> };
/** Every UTC minute whose Sydney date is `date`, with the Worker's own local clock. */
function ticksOf(date: string): Tick[] {
  const [y, m, d] = date.split("-").map(Number);
  const out: Tick[] = [];
  const from = Date.UTC(y, m - 1, d) - 14 * 60 * MIN;
  for (let t = from; t < from + 52 * 60 * MIN; t += MIN) {
    const l = sydneyLocal(t);
    if (l.date === date) out.push({ t, l });
  }
  return out;
}

const utc = (date: string, time: string, offset: number) => {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h - offset, mi)).toISOString();
};

describe("the shipped M5 slots (D-096 #41): all disabled, route runner, defined local times", () => {
  it("the six M5 route slots exist, are disabled, and sit on the documented local times", () => {
    const route = AU_SLOTS.filter((s) => s.runner === "route");
    expect(route.map((s) => s.id).sort()).toEqual([...M5].sort());
    // M8 T8 (D-155): disabled, or a go-live slot that runs only once the Owner lists it
    for (const s of route) expect(!s.enabled || s.requiresListing === true).toBe(true);
    const by = Object.fromEntries(route.map((s) => [s.id, s]));
    expect(by["alert-flush"]).toMatchObject({ time: "07:01", until: "20:59", everyMin: 2 });
    expect(by["pre-open"]).toMatchObject({ time: "09:54", catchUpMin: 3, maxAttempts: 1 });
    expect(by["pre-open-retry"]).toMatchObject({ time: "09:58", catchUpMin: 1, after: "pre-open" });
    expect(by["evening-review"]).toMatchObject({ time: "20:00", until: "20:45", everyMin: 5 });
    expect(by["evening-review-late"]).toMatchObject({
      time: "21:00",
      until: "22:00",
      everyMin: 15,
    });
    expect(by["morning"]).toMatchObject({ time: "08:00", catchUpMin: 30 });
    for (const id of ["alert-flush", "pre-open", "pre-open-retry"]) {
      expect(by[id].tradingDaysOnly).toBe(true);
    }
    for (const id of ["evening-review", "evening-review-late", "morning"]) {
      expect(by[id].tradingDaysOnly).toBe(false);
      expect(by[id].marketBound).toBe(false);
    }
    // no window starts or ends inside the 02:00-02:59 local hour that vanishes or repeats
    for (const s of route) {
      const end = s.until ?? s.time;
      const endMin = Number(end.slice(0, 2)) * 60 + Number(end.slice(3)) + s.catchUpMin;
      expect(s.minute >= 180 && endMin >= 180).toBe(true);
    }
  });
});

describe("TST-103: UTC instants of every M5 slot around both clock changes (2026-27)", () => {
  // Expected local fire minutes of a slot on a day it is due.
  const times = (id: string): string[] => {
    if (id === "alert-flush") {
      const out: string[] = [];
      for (let m = 7 * 60 + 1; m <= 20 * 60 + 59; m += 2) out.push(hm(m));
      return out;
    }
    if (id === "pre-open") return ["09:54", "09:55", "09:56", "09:57"]; // window incl. catch-up
    if (id === "pre-open-retry") return ["09:58", "09:59"];
    if (id === "evening-review") {
      return [
        "20:00",
        "20:05",
        "20:10",
        "20:15",
        "20:20",
        "20:25",
        "20:30",
        "20:35",
        "20:40",
        "20:45",
      ];
    }
    if (id === "evening-review-late") return ["21:00", "21:15", "21:30", "21:45", "22:00"];
    return Array.from({ length: 31 }, (_, i) => hm(8 * 60 + i)); // morning + 30 min catch-up
  };

  for (const day of DAYS) {
    it(`${day.date} (${day.what}): each slot fires at the stated local times and UTC offset ${day.offset}`, () => {
      const ticks = ticksOf(day.date);
      // a 23-hour and a 25-hour day: no Sydney minute is lost or repeated beyond the clock change
      const len = day.date === "2026-10-04" ? 1380 : day.date === "2027-04-04" ? 1500 : 1440;
      expect(ticks).toHaveLength(len);
      for (const id of M5) {
        const slot = ALL.find((s) => s.id === id)!;
        const fired = ticks.filter(({ l }) => routeSlotsDue(l, ALL).some((s) => s.id === id));
        if (slot.tradingDaysOnly && day.weekend) {
          expect(fired, `${id} on ${day.date}`).toEqual([]);
          continue;
        }
        expect(
          fired.map(({ l }) => hm(l.minute)),
          `${id} on ${day.date}`,
        ).toEqual(times(id));
        expect(fired.map(({ t }) => new Date(t).toISOString())).toEqual(
          times(id).map((x) => utc(day.date, x, day.offset)),
        );
        // the Intl-based library agrees with the Worker's arithmetic
        expect(localToUtc(day.date, times(id)[0], TZ).toISOString()).toBe(
          utc(day.date, times(id)[0], day.offset),
        );
        expect(marketDate(new Date(fired[0].t), TZ)).toBe(day.date);
      }
    });
  }

  it("the 20:00 Evening Review email: 09:00Z in AEDT, 10:00Z in AEST; the review date never shifts", () => {
    const want: Record<string, string> = {
      "2026-10-03": "2026-10-03T10:00:00.000Z",
      "2026-10-04": "2026-10-04T09:00:00.000Z",
      "2026-10-05": "2026-10-05T09:00:00.000Z",
      "2027-04-03": "2027-04-03T09:00:00.000Z",
      "2027-04-04": "2027-04-04T10:00:00.000Z",
      "2027-04-05": "2027-04-05T10:00:00.000Z",
    };
    for (const [date, iso] of Object.entries(want)) {
      const t = Date.parse(iso);
      expect(sydneyLocal(t)).toMatchObject({ date, minute: 20 * 60 });
      expect(routeSlotsDue(sydneyLocal(t), NF).map((s) => s.id)).toEqual(["evening-review"]);
      expect(routeSlotsDue(sydneyLocal(t - MIN), NF)).toEqual([]);
      expect(sydneyLocal(t + 2 * 60 * MIN).date).toBe(date); // 22:00 is the same review date
    }
  });

  it("08:00 morning and 09:54/09:58 pre-open keep their local minute across both changes (even minutes, D-061)", () => {
    for (const day of DAYS) {
      for (const [id, time] of [
        ["morning", "08:00"],
        ["pre-open", "09:54"],
        ["pre-open-retry", "09:58"],
      ] as const) {
        const t = Date.parse(utc(day.date, time, day.offset));
        const l = sydneyLocal(t);
        expect(l.date).toBe(day.date);
        expect(hm(l.minute)).toBe(time);
        const due = routeSlotsDue(l, ALL).map((s) => s.id);
        expect(due.includes(id)).toBe(id === "morning" || !day.weekend);
        expect(l.minute % 2).toBe(0);
      }
    }
  });

  it("catch-up windows are local minutes of the same day, also on the change days", () => {
    for (const day of [DAYS[2], DAYS[6]]) {
      const open = (time: string) =>
        routeSlotsDue(sydneyLocal(Date.parse(utc(day.date, time, day.offset))), NF).map(
          (s) => s.id,
        );
      expect(open("08:30")).toContain("morning");
      expect(open("08:31")).not.toContain("morning");
      expect(open("09:57")).toEqual([]); // trading-day-only slots skip the weekend
    }
    const mon = DAYS[3];
    const open = (time: string) =>
      routeSlotsDue(sydneyLocal(Date.parse(utc(mon.date, time, mon.offset))), NF).map((s) => s.id);
    expect(open("09:53")).toEqual([]);
    expect(open("09:54")).toEqual(["pre-open"]);
    expect(open("09:57")).toEqual(["pre-open"]);
    expect(open("09:58")).toEqual(["pre-open-retry"]);
    expect(open("09:59")).toEqual(["pre-open-retry"]);
    expect(open("10:00")).toEqual([]);
  });
});

describe("no double fire across the fall-back hour, no miss across the spring-forward gap", () => {
  it("2027-04-04 02:00-02:59 local happens twice; no M5 slot window is open inside it", () => {
    const hour2 = ticksOf("2027-04-04").filter(({ l }) => l.minute >= 120 && l.minute < 180);
    expect(hour2).toHaveLength(120);
    expect(new Set(hour2.map(({ l }) => l.minute)).size).toBe(60);
    for (const { l } of hour2) expect(routeSlotsDue(l, ALL)).toEqual([]);
    expect(hour2.slice(0, 60).every(({ l }) => l.dst)).toBe(true); // first pass AEDT
    expect(hour2.slice(60).every(({ l }) => !l.dst)).toBe(true); // second pass AEST
  });

  it("2026-10-04 02:00-02:59 local does not exist; the day still has exactly one fire per slot minute", () => {
    const ticks = ticksOf("2026-10-04");
    expect(ticks.filter(({ l }) => l.minute >= 120 && l.minute < 180)).toEqual([]);
    const counts = new Map<string, number>();
    for (const { l } of ticks) {
      for (const s of routeSlotsDue(l, ALL)) counts.set(s.id, (counts.get(s.id) ?? 0) + 1);
    }
    expect(Object.fromEntries(counts)).toEqual({
      morning: 31,
      "evening-review": 10,
      "evening-review-late": 5,
    });
  });

  it("a synthetic slot at 02:30 opens once at 03:00 in the gap, and in both passes of the overlap (one state key per date)", () => {
    const base = AU_SLOTS.find((s) => s.id === "morning")!;
    const syn: Slot = {
      ...base,
      id: "syn",
      time: "02:30",
      minute: 150,
      catchUpMin: 60,
      enabled: true,
    };
    const gap = ticksOf("2026-10-04").filter(({ l }) => routeSlotsDue(l, [syn]).length > 0);
    expect(hm(gap[0].l.minute)).toBe("03:00");
    expect(gap[0].t).toBe(Date.parse("2026-10-03T16:00:00Z")); // 03:00 AEDT
    expect(gap).toHaveLength(31); // 03:00..03:30: the 60-minute window closes at 03:30
    const over = ticksOf("2027-04-04").filter(({ l }) => routeSlotsDue(l, [syn]).length > 0);
    expect(over[0].t).toBe(Date.parse("2027-04-03T15:30:00Z")); // first 02:30 is AEDT
    expect(new Set(over.map(({ l }) => l.date))).toEqual(new Set(["2027-04-04"]));
    expect(over.length).toBeGreaterThan(60);
  });
});

describe("trading-day vs every-day behaviour (pure, incl. holidays and half days)", () => {
  const rows: CalendarRow[] = [
    { d: "2026-12-24", kind: "early_close", close_time: "14:10" },
    { d: "2026-12-25", kind: "holiday", close_time: null },
    { d: "2026-12-31", kind: "early_close", close_time: "14:10" },
    { d: "2027-01-01", kind: "holiday", close_time: null },
    { d: "2027-03-26", kind: "holiday", close_time: null },
  ];
  // The weekend gate is routeSlotsDue; the calendar gate is decideRoutes (`tradingDaysOnly && !tradingDay`).
  const fires = (date: string) => {
    const trading = isTradingDay(date, rows);
    const ids = new Set<string>();
    for (const { l } of ticksOf(date)) {
      for (const s of routeSlotsDue(l, ALL)) if (!s.tradingDaysOnly || trading) ids.add(s.id);
    }
    return [...ids].sort();
  };
  const EVERY = ["evening-review", "evening-review-late", "morning"];
  const TRADING = ["alert-flush", "pre-open", "pre-open-retry"];
  it.each([
    ["2026-10-05", "trading day", [...EVERY, ...TRADING]],
    ["2026-10-03", "Saturday", EVERY],
    ["2026-10-04", "Sunday (DST start)", EVERY],
    ["2026-12-25", "Christmas Day (holiday)", EVERY],
    ["2027-01-01", "New Year's Day (holiday)", EVERY],
    ["2027-03-26", "Good Friday (holiday)", EVERY],
    ["2026-12-24", "24 Dec half day (early close 14:10)", [...EVERY, ...TRADING]],
    ["2026-12-31", "31 Dec half day (early close 14:10)", [...EVERY, ...TRADING]],
  ])("%s %s", (date, _what, want) => {
    expect(fires(date)).toEqual([...want].sort());
  });
});

describe("Sentinel poll path (PLT-018, DAT-122): 07:00-19:30 every 4 minutes on even minutes, weekdays", () => {
  it.each(DAYS)("$date ($what)", (day) => {
    const polls = ticksOf(day.date).filter(({ l }) => pollDue(l));
    if (day.weekend) {
      expect(polls).toEqual([]);
      return;
    }
    expect(polls).toHaveLength(Math.floor((19 * 60 + 30 - 7 * 60) / 4) + 1); // 07:00..19:28
    expect(hm(polls[0].l.minute)).toBe("07:00");
    expect(polls[0].t).toBe(Date.parse(utc(day.date, "07:00", day.offset)));
    expect(hm(polls.at(-1)!.l.minute)).toBe("19:28");
    for (let i = 1; i < polls.length; i++) expect(polls[i].t - polls[i - 1].t).toBe(4 * MIN);
    expect(polls.every(({ l }) => l.minute % 2 === 0 && !isWeekend(l))).toBe(true);
    // never on the (odd) alert-flush minutes
    expect(polls.some(({ l }) => routeSlotsDue(l, ALL).some((s) => s.id === "alert-flush"))).toBe(
      false,
    );
  });

  it("at most 189 ASX requests a day (188 polls + the universe import), far below the 720 cap (TST-124)", () => {
    const polls = ticksOf("2026-10-05").filter(({ l }) => pollDue(l)).length;
    expect(polls + 1).toBeLessThanOrEqual(720);
    expect(polls).toBe(188);
  });
});

describe("watchdog cron generator (D-106, PLT-019): UTC lines cover the Sydney targets in both offsets", () => {
  it("prints the four expected lines for 20:40 and 21:50", () => {
    expect(cronLines()).toEqual(["40 9 * * *", "40 10 * * *", "50 10 * * *", "50 11 * * *"]);
    expect(cronLinesFor("20:40")).toEqual(["40 9 * * *", "40 10 * * *"]);
    expect(cronLinesFor("21:50")).toEqual(["50 10 * * *", "50 11 * * *"]);
  });

  it("on every day around the changes exactly one line per target matches the Sydney instant", () => {
    for (const day of DAYS) {
      for (const target of ["20:40", "21:50"]) {
        const t = Date.parse(utc(day.date, target, day.offset));
        const line = `${new Date(t).getUTCMinutes()} ${new Date(t).getUTCHours()} * * *`;
        expect(cronLinesFor(target)).toContain(line);
        expect(cronLines()).toContain(line);
        expect(slotForSchedule(line, t)).toBe(target.replace(":", ""));
        const other = cronLinesFor(target).find((x) => x !== line)!;
        expect(slotForSchedule(other, t)).toBeNull(); // the wrong-regime line exits 0
        expect(marketDate(new Date(t), TZ)).toBe(day.date); // the review date never shifts
      }
    }
  });

  it("the watchdog minutes are free of other route slots on a normal day", () => {
    for (const target of ["20:40", "21:50"]) {
      const due = routeSlotsDue(sydneyLocal(Date.parse(utc("2026-10-05", target, 11))), ALL);
      // 20:40 coincides with the evening-review tick by design (the watchdog checks the send); 21:50 is idle
      expect(due.map((s) => s.id)).toEqual(target === "20:40" ? ["evening-review"] : []);
    }
  });
});

// ---- NFR-012 ---------------------------------------------------------------------------------------

describe("NFR-012: median P0 latency over a series of simulated days (D-096 #26)", () => {
  // Publication instants of a halt on a held code over nine trading days, incl. the day after each
  // clock change; the Worker polls on the real 4-minute grid.
  const PUBLISHED = [
    "2026-10-05T00:03:10Z", // Mon 11:03:10 AEDT (day after the start)
    "2026-10-06T01:41:30Z",
    "2026-10-07T03:59:00Z",
    "2026-10-08T05:17:45Z",
    "2026-10-09T06:30:20Z",
    "2026-10-12T21:00:05Z", // Tue 08:00:05 AEDT
    "2026-10-13T08:22:00Z",
    "2026-10-14T07:59:59Z",
    "2027-04-05T01:12:00Z", // Mon 12:12 AEST (day after the end)
  ];
  const HAND_OFF_MS = 20_000; // simulated fetch + hand-off + route time after a poll (mock provider)

  it("median first-P0-email latency is within 9 min (ASX, 4-min poll) and no event waits more than one poll", async () => {
    const db: Client = await freshDb("main");
    const run = (sql: string, args: (string | number | null)[] = []) => db.execute({ sql, args });
    await run("UPDATE market SET mode = 'full' WHERE code = 'AU'");
    await run(
      `INSERT INTO worker_state (key, value_json, updated_at) VALUES ('email_mode', '"full"', 'x')
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
    );
    await run(
      `INSERT INTO execution (id, market, kind, family, variant, twin_group, rule_version, cost_profile)
       VALUES ('E01', 'AU', 'E', 'F1', 'U', 'T1', 'rv1', 'P5')`,
    );
    await run(
      `INSERT INTO cohort (id, execution_id, start_d, seed_micro, rule_version, params_json,
         cost_profile_version, rng_seed, live) VALUES ('KC', 'E01', '2026-10-01', 600000000, 'rv1', '{}', 1, 42, 1)`,
    );
    await run(
      `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty, status)
       VALUES ('OC', 'KC', '2026-10-01', 'ZZAA', 'buy', 'entry', 10, 'pending')`,
    );
    await run(
      `INSERT INTO fill (id, order_id, cohort_id, d, code, side, qty, rule, ref_price_micro,
         slip_micro, fill_price_micro, value_micro, brokerage_micro, cost_profile,
         bar_o_micro, bar_h_micro, bar_l_micro, bar_c_micro)
       VALUES ('FC', 'OC', 'KC', '2026-10-02', 'ZZAA', 'buy', 10, 'open', 1000000, 5000, 1005000,
         10050000, 30000000, 'P5', 1000000, 1100000, 900000, 1050000)`,
    );
    await run("UPDATE arena_order SET status = 'filled', fill_d = '2026-10-02' WHERE id = 'OC'");
    await run(
      "INSERT INTO trade (id, cohort_id, code, entry_fill_id, stop_micro) VALUES ('TC', 'KC', 'ZZAA', 'FC', 900000)",
    );
    await run(
      `INSERT INTO nav_daily (cohort_id, d, cash_settled_micro, recv_micro, pay_micro, positions_micro,
         div_recv_micro, sleeve_margin_micro, sleeve_unreal_micro, fin_accrued_micro, nav_micro,
         liq_nav_micro, open_positions, invariants_ok) VALUES ('KC', '2026-10-02', 0,0,0,120000000,0,0,0,0,1000000000,1000000000,1,1)`,
    );
    await run(
      `INSERT INTO nav_daily_pos (cohort_id, d, code, qty, close_micro, value_micro)
       VALUES ('KC', '2026-10-02', 'ZZAA', 10, 1000000, 120000000)`,
    );

    const mock = createMockProvider();
    let clock = new Date(0);
    const ctx: AlertCtx = {
      db,
      env: {
        EMAIL_PROVIDER: "mock",
        OWNER_EMAIL: "owner@example.test",
        APP_BASE_URL: "https://praxis-app.example.test",
        PII_HASH_KEY: "k".repeat(64),
        PRAXIS_ENV: "production",
      } as Record<string, string | undefined>,
      now: () => clock,
      provider: mock,
      sleep: async () => {},
    };

    const latencies: number[] = [];
    let n = 0;
    for (const iso of PUBLISHED) {
      const published = Date.parse(iso);
      let poll = Math.ceil(published / MIN) * MIN; // first Worker poll tick at or after publication
      while (!pollDue(sydneyLocal(poll))) poll += MIN;
      expect(poll - published).toBeLessThanOrEqual(4 * MIN);
      clock = new Date(poll + HAND_OFF_MS);
      const annId = `n${++n}`;
      await run(
        `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, price_sensitive, title, url, source)
         VALUES ('AU', 'ZZAA', ?, ?, ?, 'Trading Halt', 0, 'Trading halt pending an announcement', 'https://example.test/d.pdf', 'asx_announcements')`,
        [annId, new Date(published).toISOString(), clock.toISOString()],
      );
      await run(
        `INSERT INTO item_assessment (source, ann_id, market, code, materiality, rule_version, polarity,
           held, watch, candidate, tracked, assessed_at) VALUES ('asx_announcements', ?, 'AU', 'ZZAA', 3, 'materiality-v1', 0, 1, 0, 0, 1, ?)`,
        [annId, clock.toISOString()],
      );
      const r = await processAssessments(ctx);
      expect(r.p0).toHaveLength(1);
      expect(r.p0[0].action).toBe("sent");
      const att = await run("SELECT max(at) AS at FROM email_attempt WHERE outcome = 'accepted'");
      latencies.push(Date.parse(String(att.rows[0].at)) - published);
    }
    expect(latencies).toHaveLength(PUBLISHED.length);
    expect(latencies.length).toBeGreaterThanOrEqual(9); // a median needs a series (decision 26)
    const sorted = [...latencies].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    expect(median).toBeLessThanOrEqual(9 * MIN); // NFR-012: ASX items, 4-minute poll
    expect(Math.max(...latencies)).toBeLessThanOrEqual(4 * MIN + HAND_OFF_MS + 1000);
    expect(mock.outbox).toHaveLength(PUBLISHED.length);
  });
});
