// @vitest-environment node
// M22 L3 (LLM-078, D-1413, D-1475..D-1477): the Workers AI adapter. No real network: every call goes through an injected fetch.
import { describe, expect, it, vi } from "vitest";
import { createWorkersAiProvider, estimateNeurons } from "@/lib/llm/workersAi";
import { providerForRoster, RateLimitError, type ProviderRequest } from "@/lib/llm/providers";

const ENV = { CF_WORKERS_AI_TOKEN: "tok-test", CF_ACCOUNT_ID: "acct-test" };
const MODEL = "@cf/test/model-8b";
const req = (over: Partial<ProviderRequest> = {}): ProviderRequest => ({
  role: "R2",
  model: MODEL,
  prompt: "hello",
  promptSha: "sha",
  maxOutputTokens: 100,
  ...over,
});
const ok = (result: unknown) =>
  vi.fn(async () => new Response(JSON.stringify({ success: true, result }), { status: 200 }));
const base = { models: { R2: MODEL }, timeoutMs: 1000, env: ENV } as const;

describe("Workers AI adapter", () => {
  it("is a live, free, non-training route and models only the listed roles", () => {
    const p = createWorkersAiProvider({ ...base, dailyNeurons: 100 });
    expect(p.id).toBe("workers-ai");
    expect(p.kind).toBe("live");
    expect(p.paid).toBe(false);
    expect(p.trainsOnPrompts).toBe(false);
    expect(p.modelFor("R2")).toBe(MODEL);
    expect(p.modelFor("R1")).toBeUndefined();
  });

  it("is unavailable without the account id, without the token, and at a budget of 0", () => {
    const mk = (env: Record<string, string>, dailyNeurons: number) =>
      createWorkersAiProvider({ ...base, env, dailyNeurons }).available();
    expect(mk(ENV, 100)).toBe(true);
    expect(mk({ CF_WORKERS_AI_TOKEN: "t" }, 100)).toBe(false);
    expect(mk({ CF_ACCOUNT_ID: "a" }, 100)).toBe(false);
    expect(mk({ CF_WORKERS_AI_TOKEN: " ", CF_ACCOUNT_ID: "a" }, 100)).toBe(false);
    expect(mk(ENV, 0)).toBe(false);
  });

  it("makes no request at a budget of 0", async () => {
    const f = ok({ response: "{}" });
    const p = createWorkersAiProvider({
      ...base,
      dailyNeurons: 0,
      fetchImpl: f as unknown as typeof fetch,
    });
    await expect(p.call(req())).rejects.toBeInstanceOf(RateLimitError);
    expect(f).not.toHaveBeenCalled();
  });

  it("makes no request without a token", async () => {
    const f = ok({ response: "{}" });
    const p = createWorkersAiProvider({
      ...base,
      dailyNeurons: 1000,
      env: { CF_ACCOUNT_ID: "a" },
      fetchImpl: f as unknown as typeof fetch,
    });
    await expect(p.call(req())).rejects.toThrow(/no credentials/);
    expect(f).not.toHaveBeenCalled();
  });

  it("reads the credentials at call time, not at construction", async () => {
    const env: Record<string, string | undefined> = {};
    const f = ok({ response: "{}", usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const p = createWorkersAiProvider({
      ...base,
      env,
      dailyNeurons: 10_000,
      fetchImpl: f as unknown as typeof fetch,
    });
    expect(p.available()).toBe(false);
    env.CF_WORKERS_AI_TOKEN = "t";
    env.CF_ACCOUNT_ID = "a";
    expect(p.available()).toBe(true);
    await p.call(req());
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("posts to the account's run endpoint with a bearer token and returns text and usage", async () => {
    const f = ok({ response: '{"a":1}', usage: { prompt_tokens: 12, completion_tokens: 5 } });
    const p = createWorkersAiProvider({
      ...base,
      dailyNeurons: 10_000,
      fetchImpl: f as unknown as typeof fetch,
    });
    const out = await p.call(req());
    expect(out).toEqual({ text: '{"a":1}', tokensIn: 12, tokensOut: 5 });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct-test/ai/run/@cf/test/model-8b",
    );
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok-test");
    const body = JSON.parse(String(init.body));
    expect(body.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(body.max_tokens).toBe(100);
  });

  it("serialises an object answer and sends the schema in JSON mode", async () => {
    const f = ok({ response: { a: 1 } });
    const p = createWorkersAiProvider({
      ...base,
      dailyNeurons: 10_000,
      fetchImpl: f as unknown as typeof fetch,
    });
    const out = await p.call(
      req({ responseSchema: { type: "object", properties: {}, required: [] } as never }),
    );
    expect(JSON.parse(out.text)).toEqual({ a: 1 });
    const body = JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.response_format.type).toBe("json_schema");
  });

  it("stops at the day's neuron budget, counting spend in the process and from the hook", async () => {
    const f = ok({ response: "{}", usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const need = estimateNeurons(req());
    const p = createWorkersAiProvider({
      ...base,
      dailyNeurons: need * 2,
      fetchImpl: f as unknown as typeof fetch,
    });
    await p.call(req());
    await p.call(req());
    await expect(p.call(req())).rejects.toBeInstanceOf(RateLimitError);
    expect(f).toHaveBeenCalledTimes(2);

    const g = ok({ response: "{}" });
    const q = createWorkersAiProvider({
      ...base,
      dailyNeurons: need * 2,
      spentNeuronsToday: () => need * 2 - 1,
      fetchImpl: g as unknown as typeof fetch,
    });
    await expect(q.call(req())).rejects.toBeInstanceOf(RateLimitError);
    expect(g).not.toHaveBeenCalled();
  });

  it("maps 429 to a rate limit, other statuses to a status-only error, and never echoes a secret", async () => {
    const mk = (status: number) =>
      createWorkersAiProvider({
        ...base,
        dailyNeurons: 10_000,
        fetchImpl: (async () =>
          new Response("tok-test acct-test", { status })) as unknown as typeof fetch,
      });
    await expect(mk(429).call(req())).rejects.toBeInstanceOf(RateLimitError);
    const e = await mk(500)
      .call(req())
      .catch((x: Error) => x);
    expect((e as Error).message).toBe("workers-ai: http 500");
    const boom = createWorkersAiProvider({
      ...base,
      dailyNeurons: 10_000,
      fetchImpl: (async () => {
        throw new Error("tok-test");
      }) as unknown as typeof fetch,
    });
    const e2 = await boom.call(req()).catch((x: Error) => x);
    expect((e2 as Error).message).not.toMatch(/tok-test|acct-test/);
  });

  it("the roster factory builds it, off until a budget is passed", () => {
    const off = providerForRoster("workers-ai", {
      models: { R2: MODEL },
      trainsOnPrompts: false,
      env: ENV,
    });
    expect(off).not.toBeNull();
    expect(off!.paid).toBe(false);
    expect(off!.available()).toBe(false);
    const on = providerForRoster("workers-ai", {
      models: { R2: MODEL },
      trainsOnPrompts: false,
      env: ENV,
      dailyNeurons: 500,
    });
    expect(on!.available()).toBe(true);
  });
});
