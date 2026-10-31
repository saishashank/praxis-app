// @vitest-environment node
// Steelman writer (M11-lite WP4; AGT-133, LLM-010, LLM-064/065; D-481..D-484, D-487, D-488): validation,
// critic, storage, opinion, and every way a subject ends up not written.
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { allowance, scaledCap } from "@/lib/llm/budget";
import { reserveAfter } from "@/lib/llm/dropOrder";
import { MemoryStore } from "@/lib/llm/store";
import { buildPack, type EvidencePack } from "@/lib/steelman/pack";
import { readPackForSubject, readPoints, readShownPoints } from "@/lib/steelman/store";
import type { Subject } from "@/lib/steelman/subjects";
import { hasRoom, writeSteelman, type WriteDeps } from "@/lib/steelman/write";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import {
  criticAnswer,
  CUT,
  D,
  genericAuthor,
  llmOf,
  MARKET,
  NOW,
  params,
  routerOf,
  scripted,
} from "./nightHarness";

afterEach(cleanupTempDbs);

const SUBJECT: Subject = { kind: "order", id: "c1", code: "ZZA", cardId: "c1", rankScore: 1 };
const PACK: EvidencePack = buildPack({
  cutoffAt: CUT,
  maxItems: 25,
  items: [
    { kind: "card", text: "Family F3 rule v1: drift after a contract win." },
    { kind: "rule", text: "Rule volume_surge value 2.4 threshold 2.0 passed" },
    { kind: "event", text: "Event contract polarity positive on 2026-03-03" },
    { kind: "scenario", text: "Similar past trades n 37 p10 -3 p50 5 p90 9 ppm" },
    { kind: "flag", text: "Flag thin" },
    { kind: "headline", text: "ZZA contract notice", at: "2026-03-04T02:00:00.000Z" },
  ],
});
// ids: E01 card, E02 rule, E03 event, E04 scenario, E05 flag, E06 headline

function deps(db: Client, over: Partial<WriteDeps> = {}): WriteDeps {
  const store = new MemoryStore();
  const llm = llmOf(
    [scripted("alpha", genericAuthor())],
    [scripted("beta", criticAnswer())],
    store,
  );
  return {
    db,
    market: MARKET,
    d: D,
    params: params.llm,
    now: NOW,
    authorRouter: llm.authorRouter,
    criticRouterFor: llm.criticRouterFor,
    providers: llm.providers,
    store,
    ...over,
  };
}

const stubRouter = (value: unknown, source = "alpha") =>
  ({
    mode: "mock",
    route: () =>
      Promise.resolve({
        value,
        source,
        llmUsed: true,
        cached: false,
        outcome: "ok",
        budgetExhausted: false,
        injectionFiltered: false,
        injectionRemoved: 0,
        attempts: [{ provider: source, outcome: "ok" }],
        call: { id: "x", promptShas: [], tokensIn: 0, tokensOut: 0, costMicro: 0 as const },
      }),
  }) as unknown as WriteDeps["authorRouter"];

describe("writeSteelman: the happy path", () => {
  it("stores the pack first, every point with its state, and one opinion", async () => {
    const db = await freshDb("main");
    const out = await writeSteelman(deps(db), SUBJECT, PACK);
    expect(out).toMatchObject({ state: "written", shown: 4, hidden: 0 });
    const pack = await readPackForSubject(db, MARKET, D, "order", "c1");
    expect(pack?.packId).toBe(PACK.packId);
    const pts = await readPoints(db, PACK.packId);
    expect(pts.map((p) => p.state)).toEqual(Array(4).fill("shown"));
    expect(pts.every((p) => p.authorProvider === "alpha" && p.criticProvider === "beta")).toBe(
      true,
    );
    expect(pts.find((p) => p.monitorable)?.side).toBe("bear");
    const op = await db.execute("SELECT kind, code, value_json, settled_d FROM opinion_track");
    expect(op.rows).toHaveLength(1);
    expect(op.rows[0]).toMatchObject({ kind: "steelman", code: "ZZA", settled_d: null });
    expect(JSON.parse(String(op.rows[0]!.value_json))).toEqual({
      bull: 2,
      bear: 2,
      monitorable: 1,
    });
  });

  it("a repeat writes nothing new (append-only, the opinion keeps the first)", async () => {
    const db = await freshDb("main");
    const d = deps(db);
    await writeSteelman(d, SUBJECT, PACK);
    await writeSteelman(d, SUBJECT, PACK);
    expect(await readPoints(db, PACK.packId)).toHaveLength(4);
    expect((await db.execute("SELECT 1 FROM opinion_track")).rows).toHaveLength(1);
  });
});

describe("writeSteelman: claims dropped app-side (defence in depth behind the router)", () => {
  const planted = {
    bull: [
      { text: "The rule passed with value 2.4 against 2.0.", citations: ["E02"] },
      { text: "A positive event was recorded on 2026-03-03.", citations: ["E03"] },
      { text: "Analysts see a gain of 701 percent.", citations: ["E02"] }, // number not in the item
      { text: "Read more at https://ratings.example.com/zz.", citations: ["E02"] }, // URL
    ],
    bear: [
      { text: "Past trades number 37, a wide range.", citations: ["E04"], monitorable: true },
      { text: "A thin data flag is on the card.", citations: ["E05"], monitorable: false },
      { text: "A claim from nowhere.", citations: ["E99"] }, // not in the pack
      { text: "This outcome is guaranteed.", citations: ["E03"] }, // certainty wording
    ],
  };

  it("keeps the valid points, stores each dropped one with its reason, shows only the valid", async () => {
    const db = await freshDb("main");
    const out = await writeSteelman(deps(db, { authorRouter: stubRouter(planted) }), SUBJECT, PACK);
    expect(out).toMatchObject({ state: "written", shown: 4 });
    if (out.state === "written") expect(out.claims).toEqual({ total: 8, valid: 4 });
    const pts = await readPoints(db, PACK.packId);
    expect(pts.map((p) => `${p.side}:${p.state}`).sort()).toEqual([
      "bear:dropped_citation",
      "bear:dropped_unsafe",
      "bear:shown",
      "bear:shown",
      "bull:dropped_number",
      "bull:dropped_unsafe",
      "bull:shown",
      "bull:shown",
    ]);
    const text = (await readShownPoints(db, PACK.packId)).map((p) => p.text).join(" ");
    expect(text).not.toMatch(/701|https|guaranteed|nowhere/);
  });

  it("an answer that loses more than half its claims is rejected and nothing is shown", async () => {
    const db = await freshDb("main");
    const bad = {
      bull: [
        { text: "Past trades give a range.", citations: ["E04"] },
        { text: "Visit https://a.com now", citations: ["E01"] },
        { text: "Another https://b.com link", citations: ["E01"] },
      ],
      bear: [],
    };
    const out = await writeSteelman(deps(db, { authorRouter: stubRouter(bad) }), SUBJECT, PACK);
    expect(out).toMatchObject({ state: "not_written", reason: "rejected" });
    expect(await readShownPoints(db, PACK.packId)).toHaveLength(0);
    expect((await db.execute("SELECT 1 FROM opinion_track")).rows).toHaveLength(0);
  });
});

describe("writeSteelman: the critic", () => {
  it("hides a point the critic does not support, with its note; the rest stay shown", async () => {
    const db = await freshDb("main");
    const store = new MemoryStore();
    const llm = llmOf(
      [scripted("alpha", genericAuthor())],
      [scripted("beta", criticAnswer([1], "cited item does not say this"))],
      store,
    );
    const out = await writeSteelman(deps(db, { ...llm, store }), SUBJECT, PACK);
    expect(out).toMatchObject({ state: "written", shown: 3, hidden: 1 });
    const hidden = (await readPoints(db, PACK.packId)).filter((p) => p.state === "hidden_critic");
    expect(hidden).toHaveLength(1);
    expect(hidden[0]!.criticNote).toBe("cited item does not say this");
    const shown = await readShownPoints(db, PACK.packId);
    expect(shown.map((p) => p.pointId)).not.toContain(hidden[0]!.pointId);
  });

  it("the critic's output is never stored as a point and never shown", async () => {
    const db = await freshDb("main");
    await writeSteelman(deps(db), SUBJECT, PACK);
    const all = JSON.stringify(await readPoints(db, PACK.packId));
    expect(all).not.toContain("verdicts");
    expect(all).not.toContain("pointIndex");
  });

  it("no provider other than the author's: not written (critic_unavailable), nothing shown", async () => {
    const db = await freshDb("main");
    const store = new MemoryStore();
    const llm = llmOf([scripted("alpha", genericAuthor())], [], store);
    const out = await writeSteelman(deps(db, { ...llm, store }), SUBJECT, PACK);
    expect(out).toMatchObject({ state: "not_written", reason: "critic_unavailable" });
    expect(await readShownPoints(db, PACK.packId)).toHaveLength(0);
  });

  it("a critic router that answers from the author's own provider is refused (strict, D-483)", async () => {
    const db = await freshDb("main");
    const store = new MemoryStore();
    const alpha = scripted("alpha", (r) =>
      r.prompt.includes("pointIndex") ? criticAnswer()(r) : genericAuthor()(r),
    );
    const d = deps(db, {
      authorRouter: routerOf([alpha], store),
      criticRouterFor: () => routerOf([alpha], store),
      providers: [alpha],
      store,
    });
    expect(await writeSteelman(d, SUBJECT, PACK)).toMatchObject({
      state: "not_written",
      reason: "critic_unavailable",
    });
  });
});

describe("writeSteelman: not written, never an error (AT-37, D-484)", () => {
  it("an exhausted provider chain is no_model", async () => {
    const db = await freshDb("main");
    const down = scripted("alpha", genericAuthor(), { available: () => false });
    const d = deps(db, { authorRouter: routerOf([down]), providers: [down] });
    expect(await writeSteelman(d, SUBJECT, PACK)).toMatchObject({
      state: "not_written",
      reason: "no_model",
    });
    expect(down.calls).toHaveLength(0);
    expect(await readPoints(db, PACK.packId)).toHaveLength(0);
    expect((await readPackForSubject(db, MARKET, D, "order", "c1"))?.packId).toBe(PACK.packId);
  });

  it("a rules-only router (production, D-480) is no_model", async () => {
    const db = await freshDb("main");
    const d = deps(db, { authorRouter: routerOf([], new MemoryStore(), "rules-only") });
    expect(await writeSteelman(d, SUBJECT, PACK)).toMatchObject({ reason: "no_model" });
  });

  it("a provider that only ever answers badly is rejected, after one repair", async () => {
    const db = await freshDb("main");
    const bad = scripted("alpha", () => "not json");
    const d = deps(db, { authorRouter: routerOf([bad]), providers: [bad] });
    expect(await writeSteelman(d, SUBJECT, PACK)).toMatchObject({ reason: "rejected" });
    expect(bad.calls).toHaveLength(2); // the answer and one repair
  });

  it("a spent R6 budget is `budget` and the author is never called", async () => {
    const db = await freshDb("main");
    const store = new MemoryStore();
    await store.recordCall({
      id: "u",
      role: "R6",
      provider: "alpha",
      modelId: "m",
      fallbackDepth: "0",
      tokensIn: params.llm.roleDailyTokens.R6,
      tokensOut: 1,
      cached: 0,
      outcome: "ok",
      injectionFiltered: 0,
      market: MARKET,
      d: D,
    });
    const author = scripted("alpha", genericAuthor());
    const llm = llmOf([author], [scripted("beta", criticAnswer())], store);
    const out = await writeSteelman(deps(db, { ...llm, store }), SUBJECT, PACK);
    expect(out).toMatchObject({ state: "not_written", reason: "budget" });
    expect(author.calls).toHaveLength(0);
  });

  it("never throws: a database failure is a not_written outcome", async () => {
    const broken = { execute: () => Promise.reject(new Error("boom")) } as unknown as Client;
    const out = await writeSteelman(deps(await freshDb("main"), { db: broken }), SUBJECT, PACK);
    expect(out).toMatchObject({ state: "not_written", reason: "error" });
  });
});

describe("the reservation keeps the later stages' share (D-481, D-482)", () => {
  // The per-night cap (30,000 tokens) would bind first in a test that spends the daily total; lift it so
  // the daily-total rule is what is under test.
  const lp = { ...params.llm, nightlyTokensPerMarket: params.llm.dailyTotal };
  const share = lp.marketShare[MARKET];
  const total = scaledCap(lp.dailyTotal, share);
  const r5 = scaledCap(reserveAfter("steelman", lp), share);
  const spend = (store: MemoryStore, tokens: number) =>
    store.recordCall({
      id: `s${tokens}`,
      role: "R1",
      provider: "p",
      modelId: "m",
      fallbackDepth: "0",
      tokensIn: tokens,
      tokensOut: 0,
      cached: 0,
      outcome: "ok",
      injectionFiltered: 0,
      market: MARKET,
      d: D,
    });

  it("what comes after the steelman is the Evening Review cap", () => {
    expect(reserveAfter("steelman", params.llm)).toBe(params.llm.roleDailyTokens.R5);
    expect(r5).toBeGreaterThan(0);
  });

  it("refuses when the total left minus the R5 share cannot hold the reservation", async () => {
    const store = new MemoryStore();
    await spend(store, total - r5 - 1000); // only 1000 above the R5 share
    const base = { params: lp, store, market: MARKET, d: D };
    expect(await hasRoom(base, 1000)).toBe(true);
    expect(await hasRoom(base, 1001)).toBe(false);
    // without the reserve rule 1001 would still have fitted under the plain caps
    const plain = allowance(lp, "R6", MARKET, true, await store.usage("R6", MARKET, D));
    expect(plain.allowed).toBeGreaterThan(1001);
  });

  it("a write near the limit leaves the Evening Review its whole cap", async () => {
    const db = await freshDb("main");
    const store = new MemoryStore();
    const llm = llmOf(
      [scripted("alpha", genericAuthor())],
      [scripted("beta", criticAnswer())],
      store,
      lp,
    );
    await spend(store, total - r5 - 20_000);
    const out = await writeSteelman(deps(db, { ...llm, store, params: lp }), SUBJECT, PACK);
    expect(out.state).toBe("written");
    const u = await store.usage("R5", MARKET, D);
    expect(allowance(lp, "R5", MARKET, true, u).allowed).toBeGreaterThanOrEqual(r5);
  });

  it("the nightly cap keeps the R5 share too (D-505)", async () => {
    // Nightly cap smaller than the daily total: the Evening Review is a nightly call as well.
    const np = { ...params.llm, nightlyTokensPerMarket: 2 * r5 + 1000 };
    const store = new MemoryStore();
    await spend(store, r5); // nightly spend by an earlier stage: 2 * r5 + 1000 - r5 - r5 = 1000 left
    const base = { params: np, store, market: MARKET, d: D };
    expect(await hasRoom(base, 1000)).toBe(true);
    expect(await hasRoom(base, 1001)).toBe(false);
  });

  it("an R5 share already spent tonight is not reserved for twice (D-505)", async () => {
    const store = new MemoryStore();
    await spend(store, total - r5 - 1000);
    await store.recordCall({
      id: "r5-done",
      role: "R5",
      provider: "p",
      modelId: "m",
      fallbackDepth: "0",
      tokensIn: r5,
      tokensOut: 0,
      cached: 0,
      outcome: "ok",
      injectionFiltered: 0,
      market: MARKET,
      d: D,
    });
    // total - r5 - 1000 - r5 spent; the R5 reserve is now 0, so 1000 is left
    const base = { params: lp, store, market: MARKET, d: D };
    expect(await hasRoom(base, 1000)).toBe(true);
    expect(await hasRoom(base, 1001)).toBe(false);
  });

  it("with only the R5 share left the subject is skipped as budget", async () => {
    const db = await freshDb("main");
    const store = new MemoryStore();
    const author = scripted("alpha", genericAuthor());
    const llm = llmOf([author], [scripted("beta", criticAnswer())], store, lp);
    await spend(store, total - r5);
    const out = await writeSteelman(deps(db, { ...llm, store, params: lp }), SUBJECT, PACK);
    expect(out).toMatchObject({ reason: "budget" });
    expect(author.calls).toHaveLength(0);
  });
});
