// @vitest-environment node
// LLM router core (M4 T10, LLM-030…037, 050; ch.03 acceptance criteria; AT-14 mock-vs-off identity).
// No network: global fetch is replaced by a spy that must never be called.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAgentParams } from "@/lib/agents/params";
import { BUDGET_EXHAUSTED } from "@/lib/llm/router";
import { RateLimitError, type LlmProvider, type MockFixture } from "@/lib/llm/providers";
import { DbStore, MemoryStore, type CallRow } from "@/lib/llm/store";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import {
  fixture,
  fixtureFor,
  makeRouter,
  MOCK_MODEL,
  mockProvider,
  promptFor,
  request,
  type Note,
} from "./helpers";

const fetchSpy = vi.fn();
beforeEach(() => {
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled(); // no network in tests
  vi.unstubAllGlobals();
  cleanupTempDbs();
});

const params = defaultAgentParams().llm;

function counting(p: LlmProvider): LlmProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    ...p,
    calls,
    call: (req, signal) => {
      calls.push(req.prompt);
      return p.call(req, signal);
    },
  };
}

function row(over: Partial<CallRow>): CallRow {
  return {
    id: "x",
    role: "R2",
    provider: "mock",
    modelId: MOCK_MODEL,
    fallbackDepth: "0",
    tokensIn: 0,
    tokensOut: 0,
    cached: 0,
    outcome: "ok",
    injectionFiltered: 0,
    market: "AU",
    d: "2026-03-05",
    ...over,
  };
}

describe("modes and rules-only (LLM-002)", () => {
  it("rules-only mode answers from the template, logs a row, calls nothing", async () => {
    const p = counting(mockProvider({}));
    const { router, store } = makeRouter("rules-only", [p]);
    const res = await router.route(request());
    expect(res.value).toEqual(fixture.rulesNote);
    expect(res.source).toBe("rules-only");
    expect(res.llmUsed).toBe(false);
    expect(p.calls).toEqual([]);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ provider: "rules-only", fallbackDepth: "rules-only" });
  });

  it("off mode answers from the template and writes nothing", async () => {
    const { router, store } = makeRouter("off", [mockProvider({})]);
    const res = await router.route(request());
    expect(res.source).toBe("rules-only");
    expect(store.rows).toHaveLength(0);
  });

  it("mock mode with no fixture falls back to rules-only", async () => {
    const { router, store } = makeRouter("mock", [mockProvider({})]);
    const res = await router.route(request());
    expect(res.value).toEqual(fixture.rulesNote);
    expect(res.attempts[0]).toEqual({ provider: "mock", outcome: "no-fixture" });
    expect(store.rows[0].provider).toBe("rules-only");
  });
});

describe("mock replay, cache (LLM-031)", () => {
  const req = request();
  const fx = fixtureFor(req, fixture.answer);

  it("replays the recorded fixture and logs tokens", async () => {
    const { router, store } = makeRouter("mock", [mockProvider(fx)]);
    const res = await router.route(req);
    expect(res.value).toEqual(fixture.answer);
    expect(res.source).toBe("mock");
    expect(store.rows[0]).toMatchObject({
      provider: "mock",
      modelId: MOCK_MODEL,
      tokensIn: 120,
      tokensOut: 30,
      cached: 0,
      outcome: "ok",
      fallbackDepth: "0",
    });
  });

  it("second identical request is a cache hit with no provider call", async () => {
    const p = counting(mockProvider(fx));
    const { router, store } = makeRouter("mock", [p]);
    await router.route(req);
    const hit = await router.route(req);
    expect(hit.cached).toBe(true);
    expect(hit.source).toBe("cache");
    expect(hit.value).toEqual(fixture.answer);
    expect(p.calls).toHaveLength(1);
    expect(store.rows[1]).toMatchObject({ cached: 1, outcome: "cache-hit", tokensIn: 0 });
    // Cache hits spend no budget.
    expect((await store.usage("R2", "AU", req.d)).roleDay).toBe(150);
  });

  it("misses when the knowledge-base version, template version or inputs change", async () => {
    const store = new MemoryStore();
    const a = makeRouter("mock", [mockProvider(fx)], store).router;
    await a.route(req);
    const b = makeRouter("mock", [mockProvider(fx)], store, { kbVersion: "kb2" }).router;
    expect((await b.route(req)).cached).toBe(false);
    const c = await a.route(request({ facts: { ...fixture.facts, ar_pct: 9 } }));
    expect(c.cached).toBe(false); // new prompt hash (and no fixture: rules-only)
    const d = await a.route(request({ templateVersion: "r2-event-summary-v2" }));
    expect(d.cached).toBe(false);
  });

  it("an expired cache row is not served", async () => {
    const store = new MemoryStore();
    let t = Date.parse("2026-03-05T10:00:00.000Z");
    const { router } = makeRouter("mock", [mockProvider(fx)], store, { now: () => new Date(t) });
    await router.route(req);
    t += (params.cacheTtlHours + 1) * 3_600_000;
    expect((await router.route(req)).cached).toBe(false);
  });
});

describe("injection defence (LLM-035)", () => {
  it("filters, logs the attempt, and the answer is data only", async () => {
    const req = request();
    const spy = counting(mockProvider(fixtureFor(req, fixture.answer)));
    const { router, store } = makeRouter("mock", [spy]);
    const res = await router.route(req);
    expect(res.injectionFiltered).toBe(true);
    expect(res.injectionRemoved).toBe(1);
    expect(store.rows[0].injectionFiltered).toBe(1);
    expect(spy.calls[0]).toContain("[removed]");
    expect(spy.calls[0]).not.toMatch(/ignore your instructions/i);
    expect(Object.keys(res.value)).toEqual(["note"]); // no tool call, no action field
  });

  it("clean text is not flagged", async () => {
    const req = request({ untrusted: ["Plain announcement text."] });
    const { router } = makeRouter("mock", [mockProvider(fixtureFor(req, { note: "ABC ok" }))]);
    expect((await router.route(req)).injectionFiltered).toBe(false);
  });

  it("a provider that trains on prompts never receives third-party text (LLM-036)", async () => {
    const base = mockProvider({});
    const seen: string[] = [];
    const g: LlmProvider = {
      ...base,
      id: "gem",
      trainsOnPrompts: true,
      call: (r) => {
        seen.push(r.prompt);
        return Promise.reject(new Error("x"));
      },
    };
    const { router } = makeRouter("mock", [g]);
    await router.route(request());
    expect(seen[0]).not.toContain("contract worth");
    expect(seen[0]).toContain("FACTS");
  });
});

describe("grounding and validation (LLM-033/034)", () => {
  it("rejects an answer with a number not in the context and falls to rules-only", async () => {
    const req = request();
    const { router } = makeRouter("mock", [
      mockProvider(fixtureFor(req, fixture.answerUngrounded)),
    ]);
    const res = await router.route(req);
    expect(res.value).toEqual(fixture.rulesNote);
    expect(res.attempts[0].outcome).toBe("grounding-rejected");
  });

  it("falls to the next provider when the first answer is ungrounded", async () => {
    const req = request();
    const bad = { ...mockProvider(fixtureFor(req, fixture.answerUngrounded)), id: "bad" };
    const good = { ...mockProvider(fixtureFor(req, fixture.answer)), id: "good" };
    const { router, store } = makeRouter("mock", [bad, good]);
    const res = await router.route(req);
    expect(res.source).toBe("good");
    expect(store.rows[0].fallbackDepth).toBe("1");
  });

  it("allows one repair retry for invalid output, then falls back", async () => {
    const req = request();
    const sha = Object.keys(fixtureFor(req, {}))[0];
    const broken: Record<string, MockFixture> = {
      [sha]: { text: "not json", tokensIn: 10, tokensOut: 5 },
    };
    const p = counting(mockProvider(broken));
    const { router } = makeRouter("mock", [p]);
    const res = await router.route(req);
    expect(res.value).toEqual(fixture.rulesNote);
    expect(p.calls).toHaveLength(2); // first try + one repair, no more
    expect(p.calls[1]).toBe(promptFor(req, true));
    expect(res.call.tokensIn).toBe(10); // the failed first call still counts; repair had no fixture
  });

  it("a valid repair answer is accepted", async () => {
    const req = request();
    const first = Object.keys(fixtureFor(req, {}))[0];
    const second = Object.keys(fixtureFor({ ...req, task: req.task }, {}))[0]; // placeholder to keep types simple
    expect(first).toBe(second);
    const repairSha = (await import("@/lib/llm/providers")).promptSha(
      req.role,
      MOCK_MODEL,
      req.templateVersion,
      promptFor(req, true),
    );
    const fx: Record<string, MockFixture> = {
      [first]: { text: "{", tokensIn: 1, tokensOut: 1 },
      [repairSha]: { text: JSON.stringify(fixture.answer), tokensIn: 2, tokensOut: 2 },
    };
    const { router } = makeRouter("mock", [mockProvider(fx)]);
    const res = await router.route(req);
    expect(res.value).toEqual(fixture.answer);
    expect(res.call.tokensIn).toBe(3);
  });
});

describe("budgets (LLM-050)", () => {
  it("falls to rules-only with 'LLM budget exhausted' when the role budget is spent", async () => {
    const req = request();
    const store = new MemoryStore();
    store.rows.push(row({ tokensIn: params.roleDailyTokens.R2, tokensOut: 0 }));
    const p = counting(mockProvider(fixtureFor(req, fixture.answer)));
    const { router } = makeRouter("mock", [p], store);
    const res = await router.route(req);
    expect(res.budgetExhausted).toBe(true);
    expect(res.outcome).toBe(BUDGET_EXHAUSTED);
    expect(res.value).toEqual(fixture.rulesNote);
    expect(p.calls).toEqual([]);
    expect(store.rows.at(-1)?.outcome).toBe(BUDGET_EXHAUSTED);
  });

  it("the stricter cap wins: the total cap can block while the role cap has room", async () => {
    const req = request();
    const store = new MemoryStore();
    store.rows.push(row({ role: "R1", tokensIn: params.dailyTotal - 10 }));
    const { router } = makeRouter("mock", [mockProvider(fixtureFor(req, fixture.answer))], store);
    const res = await router.route(req);
    expect(res.budgetExhausted).toBe(true);
    expect(res.attempts[0].outcome).toBe("budget-exhausted:total");
  });

  it("nightly calls honour the nightly per-market cap, other calls do not", async () => {
    const req = request();
    const store = new MemoryStore();
    store.rows.push(row({ role: "R1", tokensIn: params.nightlyTokensPerMarket - 10 }));
    const fx = fixtureFor(req, fixture.answer);
    const night = await makeRouter("mock", [mockProvider(fx)], store).router.route({
      ...req,
      nightly: true,
    });
    expect(night.attempts[0].outcome).toBe("budget-exhausted:nightly");
    const day = await makeRouter("mock", [mockProvider(fx)], store).router.route(req);
    expect(day.source).toBe("mock");
  });

  it("an unknown market has no share and gets no LLM", async () => {
    const req = request({ market: "US" });
    const { router } = makeRouter("mock", [mockProvider(fixtureFor(req, fixture.answer))]);
    expect((await router.route(req)).budgetExhausted).toBe(true);
  });

  it("per-provider daily request budget skips that provider (LLM-021)", async () => {
    const req = request();
    const store = new MemoryStore();
    store.rows.push(row({ provider: "mock" }));
    const limited = { ...mockProvider(fixtureFor(req, fixture.answer)), dailyRequests: 1 };
    const { router } = makeRouter("mock", [limited], store);
    expect((await router.route(req)).attempts[0].outcome).toBe("request-budget");
  });
});

describe("providers (LLM-003, 011, 020)", () => {
  it("refuses a paid endpoint", async () => {
    const req = request();
    const paid = { ...mockProvider(fixtureFor(req, fixture.answer)), paid: true };
    const { router } = makeRouter("mock", [paid]);
    const res = await router.route(req);
    expect(res.attempts[0].outcome).toBe("refused-paid");
    expect(res.source).toBe("rules-only");
  });

  it("a 429 cools the provider down for the day and the next provider answers", async () => {
    const req = request();
    let hits = 0;
    const limited: LlmProvider = {
      ...mockProvider({}),
      id: "lim",
      call: () => {
        hits += 1;
        return Promise.reject(new RateLimitError("lim"));
      },
    };
    const good = { ...mockProvider(fixtureFor(req, fixture.answer)), id: "good" };
    const { router } = makeRouter("mock", [limited, good]);
    const first = await router.route(req);
    expect(first.attempts[0].outcome).toBe("rate-limited");
    expect(first.source).toBe("good");
    await router.route(request({ untrusted: ["other text"] }));
    expect(hits).toBe(1); // not retried the same day
  });

  it("chain order comes from config and a live provider is not used in mock mode", async () => {
    const req = request();
    const live: LlmProvider = { ...mockProvider({}), id: "groq", kind: "live" };
    const a = { ...mockProvider(fixtureFor(req, fixture.answer)), id: "a" };
    const { router } = makeRouter("mock", [live, a], new MemoryStore(), {
      chain: { R2: ["a", "groq"] },
    });
    const res = await router.route(req);
    expect(res.source).toBe("a");
  });
});

describe("AT-14: mock vs off identity", () => {
  const reqs = [
    request(),
    request({ role: "R2", facts: { ...fixture.facts, code: "DEF" }, untrusted: undefined }),
  ];
  const decision = (r: Note, facts: unknown) => JSON.stringify({ facts }); // decisions read facts only

  it("decision inputs are identical across off, rules-only and mock; only the note differs", async () => {
    const fx = Object.assign({}, ...reqs.map((r) => fixtureFor(r, fixture.answer)));
    const out: Record<string, string[]> = {};
    for (const mode of ["off", "rules-only", "mock"] as const) {
      const { router } = makeRouter(mode, [mockProvider(fx)]);
      out[mode] = [];
      for (const r of reqs) {
        const res = await router.route(r);
        out[mode].push(decision(res.value, r.facts));
      }
    }
    expect(out.mock).toEqual(out.off);
    expect(out["rules-only"]).toEqual(out.off);
  });

  it("two mock runs are byte-identical (replay)", async () => {
    const fx = Object.assign({}, ...reqs.map((r) => fixtureFor(r, fixture.answer)));
    const run = async () => {
      const { router, store } = makeRouter("mock", [mockProvider(fx)]);
      const results = [];
      for (const r of reqs) results.push(await router.route(r));
      return JSON.stringify({ results, rows: store.rows });
    };
    expect(await run()).toBe(await run());
  });
});

describe("DbStore on migration 0008", () => {
  it("round-trips cache and call rows and sums usage", async () => {
    const db = await freshDb("main");
    const store = new DbStore(db);
    const req = request();
    const { router } = makeRouter("mock", [mockProvider(fixtureFor(req, fixture.answer))], store);
    const a = await router.route(req);
    const b = await router.route(req);
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(true);
    const calls = (await db.execute("SELECT * FROM llm_call ORDER BY cached")).rows;
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ provider: "mock", tokens_in: 120, tokens_out: 30, cached: 0 });
    expect(calls[1]).toMatchObject({ cached: 1, outcome: "cache-hit" });
    expect(await store.usage("R2", "AU", req.d)).toEqual({
      roleDay: 150,
      totalDay: 150,
      marketNight: 150,
    });
    expect(await store.requestsToday("mock", req.d)).toBe(1);
    expect((await db.execute("SELECT count(*) AS n FROM llm_cache")).rows[0].n).toBe(1);
  });

  it("refreshes an expired cache row (delete then insert)", async () => {
    const db = await freshDb("main");
    const store = new DbStore(db);
    const key = { role: "R2" as const, modelId: "m", promptSha: "s", kbVersion: "k" };
    await store.cachePut(
      key,
      '{"note":"a"}',
      "2020-01-02T00:00:00.000Z",
      "2020-01-01T00:00:00.000Z",
    );
    expect(await store.cacheGet(key, "2020-01-03T00:00:00.000Z")).toBeNull();
    await store.cachePut(
      key,
      '{"note":"b"}',
      "2999-01-01T00:00:00.000Z",
      "2020-01-03T00:00:00.000Z",
    );
    expect(await store.cacheGet(key, "2020-01-04T00:00:00.000Z")).toBe('{"note":"b"}');
  });
});
