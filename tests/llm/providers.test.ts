// @vitest-environment node
// Live adapters are exercised only through an injected fake fetch; global fetch must stay unused.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalJson,
  createLiveProvider,
  KEY_ENV,
  promptSha,
  RateLimitError,
  type ProviderRequest,
} from "@/lib/llm/providers";

const globalFetch = vi.fn();
beforeEach(() => vi.stubGlobal("fetch", globalFetch));
afterEach(() => {
  expect(globalFetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

const req: ProviderRequest = {
  role: "R2",
  model: "m1",
  prompt: "p",
  promptSha: "s",
  maxOutputTokens: 50,
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("canonical hashing", () => {
  it("is independent of key order and sensitive to every component", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
    const base = promptSha("R2", "m", "v1", "x");
    expect(promptSha("R2", "m", "v1", "x")).toBe(base);
    expect(promptSha("R1", "m", "v1", "x")).not.toBe(base);
    expect(promptSha("R2", "n", "v1", "x")).not.toBe(base);
    expect(promptSha("R2", "m", "v2", "x")).not.toBe(base);
    expect(promptSha("R2", "m", "v1", "y")).not.toBe(base);
  });
});

describe("live adapters (fake fetch only)", () => {
  it("an absent key means unavailable", () => {
    const p = createLiveProvider({
      kind: "groq",
      models: { R2: "m1" },
      trainsOnPrompts: false,
      timeoutMs: 1000,
      env: {},
    });
    expect(p.available()).toBe(false);
  });

  it("groq: sends the key as a bearer header and parses usage", async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        choices: [{ message: { content: '{"note":"x"}' } }],
        usage: { prompt_tokens: 7, completion_tokens: 3 },
      }),
    );
    const p = createLiveProvider({
      kind: "groq",
      models: { R2: "m1" },
      trainsOnPrompts: false,
      timeoutMs: 1000,
      env: { [KEY_ENV.groq]: "k-test" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(p.available()).toBe(true);
    expect(await p.call(req)).toEqual({ text: '{"note":"x"}', tokensIn: 7, tokensOut: 3 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("api.groq.com");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer k-test");
  });

  it("groq: GPT-OSS models get low reasoning effort and no returned reasoning (D-182)", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ choices: [{ message: { content: "{}" } }], usage: {} }),
    );
    const p = createLiveProvider({
      kind: "groq",
      models: { R2: "openai/gpt-oss-120b" },
      trainsOnPrompts: false,
      timeoutMs: 1000,
      env: { [KEY_ENV.groq]: "k-test" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await p.call({ ...req, model: "openai/gpt-oss-120b" });
    await p.call({ ...req, model: "m1" });
    const bodies = fetchImpl.mock.calls.map(
      (c) =>
        JSON.parse(String((c as unknown as [string, RequestInit])[1].body)) as Record<
          string,
          unknown
        >,
    );
    expect(bodies[0]).toMatchObject({ reasoning_effort: "low", include_reasoning: false });
    expect(bodies[1]).not.toHaveProperty("reasoning_effort");
    expect(bodies[1]).not.toHaveProperty("include_reasoning");
  });

  it("google: uses the key header, not the URL", async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        candidates: [{ content: { parts: [{ text: "{}" }] } }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
      }),
    );
    const p = createLiveProvider({
      kind: "google",
      models: { R2: "gem" },
      trainsOnPrompts: true,
      timeoutMs: 1000,
      env: { [KEY_ENV.google]: "k-test" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await p.call({ ...req, model: "gem" })).toEqual({
      text: "{}",
      tokensIn: 4,
      tokensOut: 2,
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain("k-test");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("k-test");
  });

  it("maps 429 to RateLimitError and hides response details on other errors", async () => {
    const mk = (status: number) =>
      createLiveProvider({
        kind: "openrouter",
        models: { R2: "x:free" },
        trainsOnPrompts: false,
        timeoutMs: 1000,
        env: { [KEY_ENV.openrouter]: "k-secret" },
        fetchImpl: (async () => json({ error: "k-secret" }, status)) as unknown as typeof fetch,
      });
    await expect(mk(429).call(req)).rejects.toBeInstanceOf(RateLimitError);
    await expect(mk(500).call(req)).rejects.toThrow(/http 500/);
    await expect(mk(500).call(req)).rejects.not.toThrow(/k-secret/);
  });

  it("times out", async () => {
    const p = createLiveProvider({
      kind: "groq",
      models: { R2: "m1" },
      trainsOnPrompts: false,
      timeoutMs: 5,
      env: { [KEY_ENV.groq]: "k" },
      fetchImpl: ((_u: string, init: RequestInit) =>
        new Promise((_, rej) =>
          init.signal?.addEventListener("abort", () => rej(new Error("aborted"))),
        )) as unknown as typeof fetch,
    });
    await expect(p.call(req)).rejects.toThrow(/timeout/);
  });

  it("an OpenRouter model that is not :free is marked paid (LLM-003)", () => {
    const mk = (m: string) =>
      createLiveProvider({
        kind: "openrouter",
        models: { R2: m },
        trainsOnPrompts: false,
        timeoutMs: 1,
        env: {},
      });
    expect(mk("vendor/model:free").paid).toBe(false);
    expect(mk("vendor/model").paid).toBe(true);
  });
});
