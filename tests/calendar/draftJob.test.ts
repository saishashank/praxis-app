// @vitest-environment node
// OPS-103 (D-961; AT-83 "calendar" clause): the yearly trading-calendar draft job on a clock fixture:
// 2027-11-01 draft written, Owner item raised, idempotent on re-run; confirmation clears it; 2027-12-01
// unconfirmed -> S2 `calendar_unconfirmed`; 2028-01-01 -> the provisional rows are in use, flagged, S2
// `calendar_unconfirmed_in_use`. Parameterised over every market in CALENDAR_MARKETS so M19 adds a market
// without a test change (each needs an entry in CALENDAR_RULE_MODULES and a `market` row).
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addUser, KEY } from "../auth/helpers";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { run as draftRun } from "../../scripts/calendar/draft.mjs";
import { CALENDAR_MARKETS, confirmCalendar } from "@/lib/data/calendarAdmin";
import {
  calendarEscalation,
  DRAFT_READY_TEXT,
  readDraftedYears,
} from "@/lib/data/calendarEscalation";
import { CALENDAR_RULE_MODULES, DRAFT_SOURCE_PREFIX } from "@/lib/data/calendarRules.mjs";
import { computeComponents } from "@/lib/health/components";
import { gatherHealthFacts } from "@/lib/health/snapshot";
import { runChecks } from "@/lib/heartbeat/checks";

afterEach(cleanupTempDbs);

let main: Client;
let auth: Client;
let ownerId: number;
const ENV = { PII_HASH_KEY: KEY } as Record<string, string | undefined>;
const DB_ENV = { TURSO_MAIN_URL: "libsql://fixture", TURSO_MAIN_TOKEN: "t" };

// Melbourne mornings; the draft year is the Melbourne year after `now`
const NOV_1 = new Date("2027-11-01T09:00:00+11:00");
const DEC_1 = new Date("2027-12-01T09:00:00+11:00");
const JAN_1 = new Date("2028-01-01T09:00:00+11:00");
const YEAR = 2028;

beforeEach(async () => {
  main = await freshDb("main");
  auth = await freshDb("auth");
  ownerId = await addUser(auth, { email: "owner@example.test", role: "owner" });
});

const out: string[] = [];
// the job closes the client it opened; the test keeps its own connection open
const conn = async () => ({
  execute: (q: Parameters<Client["execute"]>[0]) => main.execute(q),
  batch: (s: Parameters<Client["batch"]>[0], m?: Parameters<Client["batch"]>[1]) =>
    main.batch(s, m),
});
const draft = (market: string, now: Date) =>
  draftRun(["--market", market, "--now", now.toISOString()], DB_ENV, (l: string) => out.push(l), {
    connect: conn,
  });
const rowsOf = async (market: string, year: number) =>
  (
    await main.execute({
      sql: "SELECT d, confirmed, source FROM trading_calendar WHERE market = ? AND d LIKE ? ORDER BY d",
      args: [market, `${year}-%`],
    })
  ).rows;
const findings = async (today: string) =>
  calendarEscalation(today, await readDraftedYears(main, CALENDAR_MARKETS, today));
const marketData = async (now: Date, today: string) => {
  const facts = await gatherHealthFacts(main, now, today, ENV);
  return computeComponents(facts).find((c) => c.id === "market_data")!;
};
const problemKinds = async (now: Date) =>
  (await runChecks("morning", main, now)).problems.map((p) => p.kind);
const confirm = (market: string) =>
  confirmCalendar({
    mainDb: main,
    authDb: auth,
    env: ENV,
    actorId: ownerId,
    market,
    year: YEAR,
    now: NOV_1,
  });

describe.each([...CALENDAR_MARKETS])("calendar draft job, market %s", (market) => {
  const rules = CALENDAR_RULE_MODULES[market as keyof typeof CALENDAR_RULE_MODULES];

  it("has a rule module (a market without one cannot be drafted)", () => {
    expect(rules).toBeTruthy();
  });

  it("2027-11-01: drafts next year as provisional rows, once, and writes a run record", async () => {
    expect(await draft(market, NOV_1)).toBe(0);
    const rows = await rowsOf(market, YEAR);
    expect(rows).toHaveLength(rules.yearRows(YEAR).length);
    expect(rows.every((r) => Number(r.confirmed) === 0)).toBe(true);
    expect(rows.every((r) => String(r.source) === `${DRAFT_SOURCE_PREFIX}${rules.source}`)).toBe(
      true,
    );
    expect(out.at(-1)).toBe(`calendar-draft: ${market} ${YEAR} drafted rows=${rows.length}`);
    const rec = await main.execute({
      sql: "SELECT status, rows_written, details_json FROM run_record WHERE concurrency_key = ?",
      args: [`calendar-draft:${market}:${YEAR}`],
    });
    expect(rec.rows).toHaveLength(1);
    expect(rec.rows[0]).toMatchObject({ status: "success", rows_written: rows.length + 1 });
    // idempotent: a second run finds the year and writes nothing
    expect(await draft(market, NOV_1)).toBe(0);
    expect(out.at(-1)).toBe(`calendar-draft: ${market} ${YEAR} exists rows=0`);
    expect(await rowsOf(market, YEAR)).toHaveLength(rows.length);
  });

  it("2027-11-01: the Owner item is raised with the plain line, and it is not an incident", async () => {
    await draft(market, NOV_1);
    expect(await findings("2027-11-01")).toEqual([
      { kind: "draft_ready", market, year: YEAR, text: DRAFT_READY_TEXT },
    ]);
    expect(DRAFT_READY_TEXT).toBe(
      "Next year's trading calendar is drafted. Check it against the ASX calendar and confirm it on System Health.",
    );
    const comp = await marketData(NOV_1, "2027-11-01");
    const it = comp.items.find((i) => i.key === `calendar.draft_ready.${market}.${YEAR}`);
    expect(it).toMatchObject({ state: "attention", label: DRAFT_READY_TEXT });
    const kinds = await problemKinds(NOV_1);
    expect(kinds).not.toContain("calendar_unconfirmed");
    expect(kinds).not.toContain("calendar_unconfirmed_in_use");
  });

  it("confirmation through confirmCalendar clears the item and every escalation", async () => {
    await draft(market, NOV_1);
    expect(await confirm(market)).toMatchObject({ ok: true });
    for (const [now, today] of [
      [NOV_1, "2027-11-01"],
      [DEC_1, "2027-12-01"],
      [JAN_1, "2028-01-01"],
    ] as const) {
      expect(await findings(today)).toEqual([]);
      expect(
        (await marketData(now, today)).items.filter((i) => i.key.startsWith("calendar.")),
      ).toEqual([]);
      const kinds = await problemKinds(now);
      expect(kinds).not.toContain("calendar_unconfirmed");
      expect(kinds).not.toContain("calendar_unconfirmed_in_use");
    }
  });

  it("2027-12-01 unconfirmed: S2 calendar_unconfirmed (the notice before it was an Owner item only)", async () => {
    await draft(market, NOV_1);
    expect(await findings("2027-11-30")).toMatchObject([{ kind: "draft_ready" }]);
    expect(await findings("2027-12-01")).toMatchObject([
      { kind: "unconfirmed_next", market, year: YEAR },
    ]);
    expect(await problemKinds(DEC_1)).toContain("calendar_unconfirmed");
    const comp = await marketData(DEC_1, "2027-12-01");
    expect(
      comp.items.find((i) => i.key === `calendar.unconfirmed_next.${market}.${YEAR}`),
    ).toMatchObject({
      state: "down",
    });
  });

  it("2028-01-01 unconfirmed: the provisional rows are in use, flagged, with an S2 incident", async () => {
    await draft(market, NOV_1);
    expect(await findings("2028-01-01")).toMatchObject([
      { kind: "in_use_unconfirmed", market, year: YEAR },
    ]);
    // the provisional rows are what the day status reads (a computed trading day is still a trading day)
    const day = rules.yearRows(YEAR).find((r) => r[1] === "session")!;
    const stored = await main.execute({
      sql: "SELECT kind, confirmed FROM trading_calendar WHERE market = ? AND d = ?",
      args: [market, day[0]],
    });
    expect(stored.rows[0]).toMatchObject({ kind: "session", confirmed: 0 });
    expect(await problemKinds(JAN_1)).toContain("calendar_unconfirmed_in_use");
    const comp = await marketData(JAN_1, "2028-01-01");
    const flag = comp.items.find((i) => i.key === `calendar.in_use_unconfirmed.${market}.${YEAR}`);
    expect(flag).toMatchObject({ state: "down" });
    expect(flag!.label).toMatch(/2028 use a calendar that is not confirmed/);
  });

  it("never touches a year that already has rows, and refuses past years", async () => {
    // the seed holds 2026 and 2027 rows: nothing is written for them
    const before = (await rowsOf(market, 2027)).length;
    expect(before).toBeGreaterThan(0);
    await draftRun(
      ["--market", market, "--year", "2027", "--now", "2026-11-01T09:00:00+11:00"],
      DB_ENV,
      (l: string) => out.push(l),
      { connect: conn },
    );
    expect(out.at(-1)).toBe(`calendar-draft: ${market} 2027 exists rows=0`);
    expect((await rowsOf(market, 2027)).length).toBe(before);
    const code = await draftRun(
      ["--market", market, "--year", "2020", "--now", NOV_1.toISOString()],
      DB_ENV,
      (l: string) => out.push(l),
      { connect: conn },
    );
    expect(code).toBe(1);
    expect(out.at(-1)).toBe(`calendar-draft: ${market} 2020 bad_year rows=0`);
  });
});

describe("calendar draft job, refusals", () => {
  it("a market without rules or without a market row is refused, nothing is written", async () => {
    const before = Number(
      (await main.execute("SELECT COUNT(*) AS n FROM trading_calendar")).rows[0].n,
    );
    // M19 (D-1050): a market with no enabled row is refused before anything is read or written (exit 2)
    expect(await draft("ZZ", NOV_1)).toBe(2);
    expect(out.at(-1)).toBe("calendar-draft: refused: market not enabled");
    expect(
      Number((await main.execute("SELECT COUNT(*) AS n FROM trading_calendar")).rows[0].n),
    ).toBe(before);
  });

  it("without --market it drafts every market that has rules, and a missing database setting fails", async () => {
    expect(
      await draftRun(["--now", NOV_1.toISOString()], DB_ENV, (l: string) => out.push(l), {
        connect: conn,
      }),
    ).toBe(0);
    expect(out.some((l) => l.includes(`${YEAR} drafted`))).toBe(true);
    expect(await draftRun([], {}, (l: string) => out.push(l))).toBe(1);
    expect(await draftRun(["--now", "nonsense"], DB_ENV, () => {})).toBe(2);
    expect(await draftRun(["--year", "20x8"], DB_ENV, () => {})).toBe(2);
  });

  it("the seed generator still produces its migrations byte for byte (the rules moved, not changed)", async () => {
    const { renderMigration, renderHistoryMigration } =
      (await import("../../scripts/data/make-au-calendar.mjs")) as unknown as {
        renderMigration: () => string;
        renderHistoryMigration: () => string;
      };
    const { readFileSync } = await import("node:fs");
    const disk = (f: string) =>
      readFileSync(`db/migrations/main/${f}`, "utf8").replace(/\r\n/g, "\n");
    expect(renderMigration()).toBe(disk("0005_au_calendar_seed.sql"));
    expect(renderHistoryMigration()).toBe(disk("0013_au_calendar_history.sql"));
  });
});
