// @vitest-environment node
// M21 R1 (VAL-121, D-1228, D-1297; BLD-051, CXA-015): the hypothesis is evaluated once. Below the sample nothing is written,
// at the sample exactly one holdout_look row is, and a second evaluation is refused and computes nothing.
import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import { addDays } from "@/lib/data/calendar";
import {
  HYPOTHESIS_TEXT,
  MIN_SESSIONS,
  MIN_SETUPS,
  PREREG_SHA,
  SHORT_LINEAGE,
  evaluateShort,
} from "@/lib/shortShadow/evaluate";
import { insertShortOutcome } from "@/lib/shortShadow/store";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { MKT, WHEN, count } from "./shortHarness";

afterEach(cleanupTempDbs);

async function seedClosed(db: Client, n: number, ppm: (i: number) => number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await insertShortOutcome(db, {
      market: MKT,
      d: addDays("2029-01-01", i),
      code: `C${i % 7}`,
      origin: "lowest_rank",
      status: "closed",
      entryD: addDays("2029-01-01", i + 1),
      entryMicro: 10_000_000n,
      exitD: addDays("2029-01-01", i + 15),
      exitMicro: 9_000_000n,
      exitReason: "time",
      feesMicro: 1n,
      borrowMicro: 1n,
      netMicro: 1n,
      netPpm: ppm(i),
      scoredAt: WHEN,
    });
  }
}

describe("evaluateShort", () => {
  it("the hypothesis text is fixed and the pre-registration fingerprint is of that text", () => {
    expect(HYPOTHESIS_TEXT).toMatch(/one look; never re-looked/i);
    expect(PREREG_SHA).toMatch(/^[0-9a-f]{16}$/);
    expect(MIN_SETUPS).toBe(60);
    expect(MIN_SESSIONS).toBe(60);
  });

  it("refuses to look below the sample and writes nothing", async () => {
    const db = await freshDb("main");
    await seedClosed(db, MIN_SETUPS - 1, () => 20_000);
    const r = await evaluateShort(db, { market: MKT, now: () => WHEN });
    expect(r).toEqual({ status: "below_sample", setups: MIN_SETUPS - 1, sessions: MIN_SETUPS - 1 });
    expect(await count(db, "holdout_look")).toBe(0);
  });

  it("60 setups on fewer than 60 sessions is still below the sample", async () => {
    const db = await freshDb("main");
    for (let i = 0; i < 70; i += 1) {
      await insertShortOutcome(db, {
        market: MKT,
        d: addDays("2029-01-01", i % 30),
        code: `C${i}`,
        origin: "lowest_rank",
        status: "closed",
        entryD: "2029-02-01",
        entryMicro: 1n,
        exitD: "2029-02-20",
        exitMicro: 1n,
        exitReason: "time",
        feesMicro: 0n,
        borrowMicro: 0n,
        netMicro: 1n,
        netPpm: 1,
        scoredAt: WHEN,
      });
    }
    const r = await evaluateShort(db, { market: MKT, now: () => WHEN });
    expect(r.status).toBe("below_sample");
    expect(await count(db, "holdout_look")).toBe(0);
  });

  it("at the sample it takes the one look and records one row; a clear loss fails", async () => {
    const db = await freshDb("main");
    await seedClosed(db, MIN_SETUPS, (i) => -30_000 - (i % 5) * 1000);
    const r = await evaluateShort(db, { market: MKT, now: () => WHEN });
    expect(r.status).toBe("looked");
    if (r.status !== "looked") return;
    expect(r.verdict).toBe("fail");
    expect(r.setups).toBe(MIN_SETUPS);
    expect(r.meanNetPpm).toBeLessThan(0);
    const rows = (
      await db.execute("SELECT lineage, market, looked_at, prereg_sha, verdict FROM holdout_look")
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lineage).toBe(SHORT_LINEAGE);
    expect(rows[0]!.market).toBe(MKT);
    expect(rows[0]!.prereg_sha).toBe(PREREG_SHA);
    expect(rows[0]!.verdict).toBe("fail");
  });

  it("a second evaluation is refused, even with more data, and writes nothing", async () => {
    const db = await freshDb("main");
    await seedClosed(db, MIN_SETUPS, () => -20_000);
    expect((await evaluateShort(db, { market: MKT, now: () => WHEN })).status).toBe("looked");
    await seedClosed(db, 5, () => 90_000_000); // would flip a re-look; ignored
    const again = await evaluateShort(db, { market: MKT, now: () => "2031-01-01T00:00:00.000Z" });
    expect(again).toEqual({ status: "refused", reason: "already_looked" });
    expect(await count(db, "holdout_look")).toBe(1);
    expect(String((await db.execute("SELECT verdict FROM holdout_look")).rows[0]!.verdict)).toBe(
      "fail",
    );
  });

  it("a steady gain over the sample passes", async () => {
    const db = await freshDb("main");
    await seedClosed(db, 80, (i) => 40_000 + (i % 3) * 500);
    const r = await evaluateShort(db, { market: MKT, now: () => WHEN });
    expect(r.status === "looked" && r.verdict).toBe("pass");
  });
});
