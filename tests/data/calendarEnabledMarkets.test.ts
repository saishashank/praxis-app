// @vitest-environment node
// M20 S1 (D-1146 hand-off, D-1190): the next-year escalation of the health snapshot and the heartbeat reads the
// ENABLED members of calendarRuleMarkets(), not the migration-seeded CALENDAR_MARKETS: an enabled IN or US with an
// unconfirmed drafted year is escalated; a market that is off is never listed, so production (AU only) is unchanged.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import {
  CALENDAR_MARKETS,
  calendarRuleMarkets,
  enabledCalendarMarkets,
} from "@/lib/data/calendarAdmin";
import { readDraftedYears } from "@/lib/data/calendarEscalation";
import { ensureCalendarYears } from "@/lib/data/calendarEnable.mjs";
import { allowMarket, cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);
let db: Client;
beforeEach(async () => {
  db = await freshDb("main");
});

describe("enabledCalendarMarkets (D-1146)", () => {
  it("is AU alone in the production shape, although the rule list has three markets", async () => {
    expect([...calendarRuleMarkets()]).toEqual(["AU", "IN", "US"]);
    expect([...CALENDAR_MARKETS]).toEqual(["AU"]);
    expect(await enabledCalendarMarkets(db)).toEqual(["AU"]);
  });

  it("lists an enabled IN and its drafted, unconfirmed year, and drops it again when it is switched off", async () => {
    await allowMarket(db, "IN");
    await ensureCalendarYears(db, "IN", [2027], { now: () => new Date("2026-11-13T00:00:00Z") });
    expect(await enabledCalendarMarkets(db)).toEqual(["AU", "IN"]);
    const drafted = await readDraftedYears(db, await enabledCalendarMarkets(db), "2026-12-02");
    const india = drafted.filter((x) => x.market === "IN");
    expect(india).toHaveLength(1);
    expect(india[0]).toMatchObject({ year: 2027 });
    expect(india[0]!.unconfirmed).toBe(india[0]!.rows); // every drafted row is provisional
    await db.execute("UPDATE market SET enabled = 0, mode = 'off' WHERE code = 'IN'");
    expect(await enabledCalendarMarkets(db)).toEqual(["AU"]);
  });

  it("never lists a market without calendar rules, enabled or not", async () => {
    await allowMarket(db, "ZZ");
    expect(await enabledCalendarMarkets(db)).toEqual(["AU"]);
  });
});
