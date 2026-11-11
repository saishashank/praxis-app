// @vitest-environment node
// M18 OPS-111 (D-977), the closed residuals of M11-lite that live in the night stage:
//   (3) a night that crashed before its row resumes with the same counters as an uninterrupted one;
//   (4) a critic that was never called leaves an llm_call row of its own (provider none);
//   (6) an unexpected error is counted apart from no_model and the card says so.
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "@/lib/llm/store";
import { steelmanNight, type NightOptions } from "@/lib/steelman/night";
import { readSteelmanForCard } from "@/lib/steelman/read";
import { readNight } from "@/lib/steelman/store";
import { cleanupTempDbs } from "../db/helpers";
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
  scripted,
  seedNight,
} from "./nightHarness";

afterEach(cleanupTempDbs);

const opts = (over: Partial<NightOptions> = {}): NightOptions => ({
  market: MARKET,
  d: D,
  llmParams: params.llm,
  keys: KEYS,
  llm: llmOf([scripted("alpha", genericAuthor())], [scripted("beta", criticAnswer())]),
  calendar: CALENDAR,
  now: NOW,
  ...over,
});

/** A critic that finds none of the points supported: every kept point is hidden, no card is shown. */
const hideAll = () => scripted("beta", criticAnswer([0, 1, 2, 3, 4, 5, 6, 7]));

const crashOnNightRow = (db: Awaited<ReturnType<typeof seedNight>>) =>
  new Proxy(db, {
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

const counters = (n: NonNullable<Awaited<ReturnType<typeof readNight>>>) => {
  const { createdAt, ...rest } = n;
  void createdAt;
  return rest;
};

describe("(3) the night counters resume from the stored points", () => {
  it("a crash before the night row, then a re-run: the row equals an uninterrupted run (all points hidden)", async () => {
    const clean = await seedNight();
    await steelmanNight(
      clean,
      opts({ llm: llmOf([scripted("alpha", genericAuthor())], [hideAll()]) }),
    );
    const want = counters((await readNight(clean, MARKET, D))!);
    expect(want).toMatchObject({ written: 0, notWrittenCritic: 3 });
    expect(want.claimsValid).toBeGreaterThan(0);

    const db = await seedNight();
    const first = await steelmanNight(
      crashOnNightRow(db),
      opts({ llm: llmOf([scripted("alpha", genericAuthor())], [hideAll()]) }),
    );
    expect(first.status).toBe("failed");
    const author = scripted("alpha", genericAuthor());
    const again = await steelmanNight(db, opts({ llm: llmOf([author], [hideAll()]) }));
    expect(again.status).toBe("done");
    expect(author.calls).toHaveLength(0); // nothing was paid for twice
    expect(counters((await readNight(db, MARKET, D))!)).toEqual(want);
  });

  it("with some subjects written and some hidden the resumed row still equals the clean one", async () => {
    // alpha writes a card for every subject; the critic hides everything for one run only
    const clean = await seedNight();
    await steelmanNight(clean, opts());
    const want = counters((await readNight(clean, MARKET, D))!);

    const db = await seedNight();
    await steelmanNight(crashOnNightRow(db), opts());
    await steelmanNight(db, opts());
    expect(counters((await readNight(db, MARKET, D))!)).toEqual(want);
  });
});

describe("(4) a critic that was never called is logged as a call with provider none", () => {
  it("one row per subject, no tokens, outcome critic_unavailable", async () => {
    const db = await seedNight();
    const store = new MemoryStore();
    const r = await steelmanNight(
      db,
      opts({ llm: llmOf([scripted("alpha", genericAuthor())], [], store) }),
    );
    expect(r.notWritten.critic).toBe(3);
    const rows = store.rows.filter((x) => x.provider === "none");
    expect(rows).toHaveLength(3);
    for (const x of rows) {
      expect(x).toMatchObject({
        role: "R6",
        outcome: "critic_unavailable",
        tokensIn: 0,
        tokensOut: 0,
        cached: 0,
        fallbackDepth: "rules-only",
        market: MARKET,
        d: D,
      });
    }
    // the author calls are still logged as before
    expect(store.rows.filter((x) => x.provider === "alpha")).toHaveLength(3);
  });

  it("a critic that did answer leaves no none row", async () => {
    const db = await seedNight();
    const store = new MemoryStore();
    await steelmanNight(
      db,
      opts({
        llm: llmOf([scripted("alpha", genericAuthor())], [scripted("beta", criticAnswer())], store),
      }),
    );
    expect(store.rows.filter((x) => x.provider === "none")).toHaveLength(0);
  });
});

describe("(6) an unexpected error is its own counter and its own words", () => {
  it("counts under error, not no_model; the card reads 'an unexpected error stopped this note'", async () => {
    const db = await seedNight();
    const store = new MemoryStore();
    const boom = {
      authorRouter: {
        mode: "mock" as const,
        route: () => Promise.reject(new Error("boom")),
      },
      criticRouterFor: () => null,
      providers: [],
      store,
    };
    const r = await steelmanNight(db, opts({ llm: boom as never }));
    expect(r.notWritten).toEqual({ limit: 0, budget: 0, noModel: 0, critic: 0, error: 3 });
    expect(await readNight(db, MARKET, D)).toMatchObject({
      notWrittenError: 3,
      notWrittenNoModel: 0,
    });
    const cardId = String(
      (await db.execute("SELECT card_id FROM steelman_pack WHERE card_id IS NOT NULL LIMIT 1"))
        .rows[0]!.card_id,
    );
    const view = await readSteelmanForCard(db, cardId);
    expect(view).toMatchObject({ state: "not_written", reason: "error" });
  });
});
