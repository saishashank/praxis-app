// @vitest-environment node
// Steelman night stage (M11-lite WP4; PRD-029, AGT-133/133a; D-481..D-485, D-492, D-493): subjects in rank
// order, the night row, counts by reason, suggestions, idempotence, and that nothing here ever throws.
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "@/lib/llm/store";
import { steelmanNight, type NightOptions } from "@/lib/steelman/night";
import {
  listPacks,
  readNight,
  readOpenSuggestions,
  readPoints,
  readShownPoints,
} from "@/lib/steelman/store";
import { dismissSuggestion, expireSuggestions } from "@/lib/steelman/suggestions";
import { addUser, auditRows, KEY } from "../auth/helpers";
import { cleanupTempDbs, freshDb } from "../db/helpers";
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
} from "./nightHarness";

afterEach(cleanupTempDbs);

function opts(db: Client, over: Partial<NightOptions> = {}): NightOptions {
  void db;
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

describe("steelmanNight with a model (mock providers)", () => {
  it("writes orders by rank score then picks, stores the night row and lists suggestions", async () => {
    const db = await seedNight();
    const r = await steelmanNight(db, opts(db));
    expect(r).toMatchObject({ status: "done", requested: 3, written: 3, suggestions: 2 });
    expect(r.notWritten).toEqual({ limit: 0, budget: 0, noModel: 0, critic: 0 });
    expect(r.claimsTotal).toBe(12);
    expect(r.validityPpm).toBe(1_000_000);

    const packs = await listPacks(db, MARKET, D);
    expect(packs.map((p) => `${p.subjectKind}:${p.code}`).sort()).toEqual([
      "order:ZZA",
      "order:ZZB",
      "pick:ZZP",
    ]);
    const row = await readNight(db, MARKET, D);
    expect(row).toMatchObject({ requested: 3, written: 3, claimsTotal: 12, claimsValid: 12 });
    expect((await readOpenSuggestions(db, MARKET)).map((s) => s.family)).toEqual(["F3", "F3"]);
    expect((await db.execute("SELECT 1 FROM opinion_track")).rows).toHaveLength(3);
  });

  it("is idempotent: a second run is already_done and writes nothing", async () => {
    const db = await seedNight();
    await steelmanNight(db, opts(db));
    const author = scripted("alpha", genericAuthor());
    const again = await steelmanNight(
      db,
      opts(db, { llm: llmOf([author], [scripted("beta", criticAnswer())]) }),
    );
    expect(again).toMatchObject({ status: "already_done", requested: 3, written: 3 });
    expect(author.calls).toHaveLength(0);
    expect((await db.execute("SELECT 1 FROM steelman_night")).rows).toHaveLength(1);
  });

  it("resumes after a crash before the night row: written subjects are not paid for twice", async () => {
    const db = await seedNight();
    const crashing = new Proxy(db, {
      get(t, k, r) {
        if (k === "execute")
          return (q: { sql?: string } | string) =>
            typeof q === "object" && q.sql?.includes("INSERT INTO steelman_night")
              ? Promise.reject(new Error("crash"))
              : t.execute(q as never);
        const v = Reflect.get(t, k, r);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    expect((await steelmanNight(crashing, opts(db))).status).toBe("failed");
    expect(await readNight(db, MARKET, D)).toBeNull();
    const author = scripted("alpha", genericAuthor());
    const r = await steelmanNight(
      db,
      opts(db, { llm: llmOf([author], [scripted("beta", criticAnswer())]) }),
    );
    expect(r).toMatchObject({ status: "done", written: 3, requested: 3 });
    expect(author.calls).toHaveLength(0); // every subject was already on file
    expect(await readNight(db, MARKET, D)).toMatchObject({ written: 3 });
    expect((await db.execute("SELECT 1 FROM steelman_point")).rows).toHaveLength(12);
  });

  it("writes at most steelman_daily_cards, best rank first, and counts the rest as limit", async () => {
    const db = await seedNight();
    const r = await steelmanNight(db, opts(db, { keys: { ...KEYS, dailyCards: 1 } }));
    expect(r).toMatchObject({ requested: 3, written: 1 });
    expect(r.notWritten.limit).toBe(2);
    expect((await listPacks(db, MARKET, D)).map((p) => p.code)).toEqual(["ZZB"]); // rank 9.5
  });

  it("0 cards turns the stage off but still stores the night row", async () => {
    const db = await seedNight();
    const author = scripted("alpha", genericAuthor());
    const r = await steelmanNight(
      db,
      opts(db, {
        keys: { ...KEYS, dailyCards: 0 },
        llm: llmOf([author], [scripted("beta", criticAnswer())]),
      }),
    );
    expect(r).toMatchObject({ written: 0, requested: 3 });
    expect(r.notWritten.limit).toBe(3);
    expect(author.calls).toHaveLength(0);
    expect(await readNight(db, MARKET, D)).not.toBeNull();
  });

  it("critic-hidden points are counted and never become suggestions", async () => {
    const db = await seedNight();
    // hide point 3 (the monitorable bear point): the suggestion must not exist
    const r = await steelmanNight(
      db,
      opts(db, {
        llm: llmOf([scripted("alpha", genericAuthor())], [scripted("beta", criticAnswer([3]))]),
      }),
    );
    expect(r).toMatchObject({ written: 3, criticHidden: 3, suggestions: 0 });
    for (const p of await listPacks(db, MARKET, D)) {
      expect((await readShownPoints(db, p.packId)).some((x) => x.monitorable)).toBe(false);
      expect(
        (await readPoints(db, p.packId)).filter((x) => x.state === "hidden_critic"),
      ).toHaveLength(1);
    }
  });
});

describe("steelmanNight without a model: counted, stored, never thrown (AT-37, D-480, D-484)", () => {
  it("production rules-only: every subject is no_model and the night row says so", async () => {
    const db = await seedNight();
    const store = new MemoryStore();
    const r = await steelmanNight(
      db,
      opts(db, {
        llm: {
          authorRouter: routerOf([], store, "rules-only"),
          criticRouterFor: () => null,
          providers: [],
          store,
        },
      }),
    );
    expect(r).toMatchObject({ status: "done", requested: 3, written: 0 });
    expect(r.notWritten).toEqual({ limit: 0, budget: 0, noModel: 3, critic: 0 });
    expect(await readNight(db, MARKET, D)).toMatchObject({ notWrittenNoModel: 3, written: 0 });
    // packs are on file (the log), no point, no suggestion, no opinion
    expect(await listPacks(db, MARKET, D)).toHaveLength(3);
    expect((await db.execute("SELECT 1 FROM steelman_point")).rows).toHaveLength(0);
    expect(await readOpenSuggestions(db, MARKET)).toHaveLength(0);
    expect((await db.execute("SELECT 1 FROM opinion_track")).rows).toHaveLength(0);
  });

  it("spent R6 budget: every subject is `budget`", async () => {
    const db = await seedNight();
    const store = new MemoryStore();
    await store.recordCall({
      id: "u",
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
    const llm = llmOf(
      [scripted("alpha", genericAuthor())],
      [scripted("beta", criticAnswer())],
      store,
    );
    const r = await steelmanNight(db, opts(db, { llm }));
    expect(r.notWritten).toEqual({ limit: 0, budget: 3, noModel: 0, critic: 0 });
  });

  it("no critic provider: `critic` counts, nothing is shown", async () => {
    const db = await seedNight();
    const r = await steelmanNight(
      db,
      opts(db, { llm: llmOf([scripted("alpha", genericAuthor())], []) }),
    );
    expect(r.notWritten).toEqual({ limit: 0, budget: 0, noModel: 0, critic: 3 });
    expect(
      (await db.execute("SELECT 1 FROM steelman_point WHERE state = 'shown'")).rows,
    ).toHaveLength(0);
  });

  it("a database that fails on every call returns `failed`, it does not throw", async () => {
    const broken = { execute: () => Promise.reject(new Error("down")) } as unknown as Client;
    const r = await steelmanNight(broken, opts(broken));
    expect(r.status).toBe("failed");
  });

  it("a missing night table (migration not applied) is `failed`, not an exception", async () => {
    const db = await seedNight();
    await db.execute("DROP TABLE steelman_night");
    const r = await steelmanNight(db, opts(db));
    expect(r.status).toBe("failed");
  });
});

describe("suggestions: expiry by sessions and the audited dismissal (AGT-133a, D-492)", () => {
  async function withSuggestions() {
    const db = await seedNight();
    await steelmanNight(db, opts(db));
    return db;
  }

  it("expires an open suggestion after the configured number of trading sessions, not before", async () => {
    const db = await withSuggestions();
    // 2026-03-04 is a Wednesday: ten sessions later is Wednesday 2026-03-18.
    expect(await expireSuggestions(db, MARKET, "2026-03-17", CALENDAR, 10, NOW)).toBe(0);
    expect(await expireSuggestions(db, MARKET, "2026-03-18", CALENDAR, 10, NOW)).toBe(2);
    const rows = await db.execute("SELECT status, closed_by FROM steelman_suggestion");
    expect(rows.rows.every((r) => r.status === "expired" && r.closed_by === "system")).toBe(true);
    expect(await expireSuggestions(db, MARKET, "2026-03-19", CALENDAR, 10, NOW)).toBe(0);
  });

  it("the night stage expires old suggestions itself", async () => {
    const db = await withSuggestions();
    const r = await steelmanNight(db, opts(db, { d: "2026-03-18" }));
    expect(r.expired).toBe(2);
  });

  it("the Owner dismisses once, with an audit row; an Editor cannot", async () => {
    const db = await withSuggestions();
    const auth = await freshDb("auth");
    const owner = await addUser(auth, { email: "owner@example.test", role: "owner" });
    const editor = await addUser(auth, { email: "ed@example.test", role: "editor" });
    const id = (await readOpenSuggestions(db, MARKET))[0]!.suggestionId;
    const x = { mainDb: db, authDb: auth, env: { PII_HASH_KEY: KEY }, id };
    expect(await dismissSuggestion({ ...x, actorId: editor })).toEqual({ error: "forbidden" });
    expect(await dismissSuggestion({ ...x, actorId: owner })).toEqual({ ok: true });
    expect(await dismissSuggestion({ ...x, actorId: owner })).toEqual({ error: "not_open" });
    expect(await dismissSuggestion({ ...x, actorId: owner, id: "nope" })).toEqual({
      error: "not_found",
    });
    const audits = (await auditRows(auth)).filter(
      (a) => a.action === "steelman_suggestion_dismiss",
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ target_id: id, actor_user_id: owner });
    expect(await readOpenSuggestions(db, MARKET)).toHaveLength(1);
  });
});
