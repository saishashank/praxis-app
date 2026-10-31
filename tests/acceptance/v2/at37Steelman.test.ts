// @vitest-environment node
// AT-37 steelman part (M11-lite WP4; LLM-050, LLM-062, LLM-063; D-480..D-484): a provider chain that is
// exhausted gives `no_model`, a spent R6 budget gives `budget`, the Evening Review keeps its reservation
// (drop order), and production, which has no model wired, reads "not written tonight (no model
// available)" and changes nothing else. The night stage and the CLI never fail the night.
import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateUp } from "@/lib/db/migrate-core.mjs";
import { allowance, scaledCap } from "@/lib/llm/budget";
import { DROP_ORDER, reserveAfter } from "@/lib/llm/dropOrder";
import { MemoryStore } from "@/lib/llm/store";
import { steelmanMain } from "@/lib/steelman/cli";
import { steelmanNight, type NightOptions } from "@/lib/steelman/night";
import { readNight } from "@/lib/steelman/store";
import { cleanupTempDbs, MIGRATIONS, tempDbUrl, track } from "../../db/helpers";
import {
  CALENDAR,
  criticAnswer,
  D,
  genericAuthor,
  KEYS,
  llmOf,
  MARKET,
  NOW,
  params,
  routerOf,
  scripted,
  seedNight,
} from "../../steelman/nightHarness";

afterEach(cleanupTempDbs);

function base(over: Partial<NightOptions>): NightOptions {
  return {
    market: MARKET,
    d: D,
    llmParams: params.llm,
    keys: KEYS,
    llm: llmOf([scripted("alpha", genericAuthor())], [scripted("beta", criticAnswer())]),
    calendar: CALENDAR,
    now: NOW,
    ...over,
  };
}

describe("AT-37: the steelman shrinks first and says why", () => {
  it("an exhausted provider chain: every subject is no_model, nothing is called", async () => {
    const db = await seedNight();
    const down = scripted("alpha", genericAuthor(), { available: () => false });
    const store = new MemoryStore();
    const r = await steelmanNight(
      db,
      base({
        llm: {
          authorRouter: routerOf([down], store),
          criticRouterFor: () => null,
          providers: [down],
          store,
        },
      }),
    );
    expect(r.notWritten).toEqual({ limit: 0, budget: 0, noModel: 3, critic: 0 });
    expect(down.calls).toHaveLength(0);
    expect(await readNight(db, MARKET, D)).toMatchObject({ written: 0, notWrittenNoModel: 3 });
  });

  it("a spent R6 budget: every subject is `budget`; the author is not called", async () => {
    const db = await seedNight();
    const store = new MemoryStore();
    await store.recordCall({
      id: "spent",
      role: "R6",
      provider: "alpha",
      modelId: "m",
      fallbackDepth: "0",
      tokensIn: params.llm.roleDailyTokens.R6,
      tokensOut: 0,
      cached: 0,
      outcome: "ok",
      injectionFiltered: 0,
      market: MARKET,
      d: D,
    });
    const author = scripted("alpha", genericAuthor());
    const r = await steelmanNight(
      db,
      base({ llm: llmOf([author], [scripted("beta", criticAnswer())], store) }),
    );
    expect(r.notWritten).toEqual({ limit: 0, budget: 3, noModel: 0, critic: 0 });
    expect(author.calls).toHaveLength(0);
  });

  it("drop order: the steelman goes before the Evening Review, which keeps its reservation", async () => {
    expect(DROP_ORDER.indexOf("steelman")).toBeLessThan(DROP_ORDER.indexOf("evening_review"));
    expect(DROP_ORDER[DROP_ORDER.length - 1]).toBe("evening_review");
    expect(reserveAfter("steelman", params.llm)).toBe(params.llm.roleDailyTokens.R5);
    // Lift the per-night cap so the daily total is what binds, spend all but the R5 share plus a little.
    const lp = { ...params.llm, nightlyTokensPerMarket: params.llm.dailyTotal };
    const share = lp.marketShare[MARKET];
    const r5 = scaledCap(lp.roleDailyTokens.R5, share);
    const store = new MemoryStore();
    await store.recordCall({
      id: "other",
      role: "R1",
      provider: "p",
      modelId: "m",
      fallbackDepth: "0",
      tokensIn: scaledCap(lp.dailyTotal, share) - r5 - 50, // 50 tokens above the R5 share
      tokensOut: 0,
      cached: 0,
      outcome: "ok",
      injectionFiltered: 0,
      market: MARKET,
      d: D,
    });
    const db = await seedNight();
    const author = scripted("alpha", genericAuthor());
    const r = await steelmanNight(
      db,
      base({
        llmParams: lp,
        llm: llmOf([author], [scripted("beta", criticAnswer())], store, lp),
      }),
    );
    expect(r.notWritten.budget).toBe(3); // 50 tokens cannot hold a reservation
    expect(author.calls).toHaveLength(0);
    // and the R5 allowance is whole: the steelman took nothing from it
    const u = await store.usage("R5", MARKET, D);
    expect(allowance(lp, "R5", MARKET, true, u).allowed).toBeGreaterThanOrEqual(r5);
  });

  it("the night stage never throws, even on a broken database", async () => {
    const broken = { execute: () => Promise.reject(new Error("down")) } as unknown as Client;
    await expect(steelmanNight(broken, base({}))).resolves.toMatchObject({ status: "failed" });
  });
});

describe("AT-37: production has no model wired (D-480)", () => {
  const TODAY = Date.parse("2026-03-04T08:00:00.000Z");

  async function fullNight() {
    const url = tempDbUrl();
    const db = track(createClient({ url }));
    await migrateUp(db, await loadMigrations(MIGRATIONS("main")));
    await db.execute("UPDATE market SET mode = 'full' WHERE code = 'AU'");
    await seedNight(db);
    await db.execute({
      sql: `INSERT INTO run_record (job, market, concurrency_key, scheduled_for, started_at, ended_at, status)
            VALUES ('arena-review', 'AU', ?, ?, ?, ?, 'success')`,
      args: [`arena-3:AU:${D}`, D, `${D}T08:00:00.000Z`, `${D}T08:05:00.000Z`],
    });
    return { url, db };
  }
  const run = async (url: string, args: string[] = ["--date", D]) => {
    const lines: string[] = [];
    const code = await steelmanMain(
      args,
      { TURSO_MAIN_URL: url, TURSO_MAIN_TOKEN: "secret-token-do-not-print" },
      { nowMs: () => TODAY, out: (s) => lines.push(s), openDb: (u) => createClient({ url: u }) },
    );
    return { code, lines };
  };
  const count = async (db: Client, t: string) =>
    Number((await db.execute(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0]!.n);

  it("reads 'not written tonight (no model available)', exits 0, and changes no order, fill or card", async () => {
    const { url, db } = await fullNight();
    const before = [
      await count(db, "arena_order"),
      await count(db, "fill"),
      await count(db, "decision_card"),
      await count(db, "signal"),
    ];
    const r = await run(url);
    expect(r.code).toBe(0);
    expect(r.lines.join("\n")).toContain("not written tonight (no model available)");
    expect(r.lines.join("\n")).not.toContain("secret-token");
    expect(await readNight(db, MARKET, D)).toMatchObject({
      requested: 3,
      written: 0,
      notWrittenNoModel: 3,
    });
    expect(await count(db, "steelman_point")).toBe(0);
    expect(await count(db, "opinion_track")).toBe(0);
    expect([
      await count(db, "arena_order"),
      await count(db, "fill"),
      await count(db, "decision_card"),
      await count(db, "signal"),
    ]).toEqual(before);
    // a re-run writes nothing new and still exits 0
    expect((await run(url)).code).toBe(0);
    expect(await count(db, "steelman_night")).toBe(1);
  });

  it("writes nothing without a reviewed night, in a replay, or outside the review phases", async () => {
    const { url, db } = await fullNight();
    const noReview = await run(url, ["--date", "2026-03-05"]);
    expect(noReview).toEqual({
      code: 0,
      lines: ["arena-steelman AU 2026-03-05: skipped (no reviewed night)"],
    });
    expect(await run(url, ["--date", D, "--replay"])).toEqual({ code: 0, lines: [] });
    expect(await run(url, ["--date", D, "--phase", "2b"])).toEqual({ code: 0, lines: [] });
    expect(await count(db, "steelman_night")).toBe(0);
  });

  it("a failure in the stage exits 0 with `degraded` (D-484)", async () => {
    const { url, db } = await fullNight();
    await db.execute("DROP TABLE steelman_night");
    const r = await run(url);
    expect(r.code).toBe(0);
    expect(r.lines.join("\n")).toContain("degraded");
  });

  it("an unconfigured database exits 0 with `degraded`", async () => {
    const lines: string[] = [];
    const code = await steelmanMain([], {}, { out: (s) => lines.push(s) });
    expect({ code, lines }).toEqual({
      code: 0,
      lines: ["arena-steelman: degraded (database not configured)"],
    });
  });
});
