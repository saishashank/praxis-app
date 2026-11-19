// Cloudflare Workers AI adapter (M22 L3, LLM-078, D-1413). One more provider behind the same router: the nightly router runs in
// GitHub Actions, so it calls the REST endpoint with a token (not a Worker binding). Off until the Owner sets a neuron budget
// above 0 and adds both secrets; a model is routable only after a bake-off pass (the factory's gate). Credentials are read
// from the environment at call time only and never logged or put in error text.
import type { Role } from "./budget";
import { toProviderSchema } from "./jsonSchema";
import {
  ProviderHttpError,
  RateLimitError,
  type LlmProvider,
  type ProviderRequest,
  type ProviderResult,
} from "./providers";

export const WORKERS_AI_TOKEN_ENV = "CF_WORKERS_AI_TOKEN";
export const WORKERS_AI_ACCOUNT_ENV = "CF_ACCOUNT_ID";
export const WORKERS_AI_ID = "workers-ai";

const BASE = "https://api.cloudflare.com/client/v4/accounts";
const HTTP_TOO_MANY = 429; // threshold-ok: HTTP status code
const CHARS_PER_TOKEN = 4; // threshold-ok: estimation heuristic, not a rule threshold
/**
 * D-1475: neurons charged per 1,000 tokens (input plus the reserved output) for the pre-call check. Deliberately above the
 * published rate of the small models, so the free daily allowance is never overrun by an estimate that is too low [VERIFY
 * against the model's page on the pricing date].
 */
const NEURONS_PER_1K_TOKENS = 250; // threshold-ok: conservative neuron rate, not a rule value

/** The neurons one call is expected to use (prompt estimate plus the output reservation); at least 1. */
export function estimateNeurons(req: Pick<ProviderRequest, "prompt" | "maxOutputTokens">): number {
  const tokens = Math.ceil(req.prompt.length / CHARS_PER_TOKEN) + req.maxOutputTokens;
  return Math.max(1, Math.ceil((tokens * NEURONS_PER_1K_TOKENS) / 1000)); // threshold-ok: per-thousand unit
}

export type WorkersAiOptions = {
  id?: string;
  models: Readonly<Partial<Record<Role, string>>>;
  /** `llm_budget_workers_ai_daily` (neurons per day); 0 or absent = off, no request is ever made. */
  dailyNeurons?: number;
  /** Neurons already spent today before this process (the caller reads `llm_call` rows of this provider); optional. */
  spentNeuronsToday?: () => number;
  timeoutMs: number;
  env?: Readonly<Record<string, string | undefined>>;
  fetchImpl?: typeof fetch;
};

type Json = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function createWorkersAiProvider(opts: WorkersAiOptions): LlmProvider {
  const env = (): Readonly<Record<string, string | undefined>> => opts.env ?? process.env;
  const read = (name: string): string | undefined => {
    const v = env()[name];
    return v && v.trim() !== "" ? v.trim() : undefined;
  };
  const budget = (): number => Math.max(0, Math.floor(opts.dailyNeurons ?? 0));
  let spentInProcess = 0;
  const spentToday = (): number => {
    let before = 0;
    try {
      before = Math.max(0, opts.spentNeuronsToday?.() ?? 0);
    } catch {
      before = Number.POSITIVE_INFINITY; // an unreadable ledger is the safe side: no spend
    }
    return before + spentInProcess;
  };
  return {
    id: opts.id ?? WORKERS_AI_ID,
    kind: "live",
    paid: false,
    trainsOnPrompts: false, // [VERIFY] Cloudflare states that customer content is not used to train its models
    modelFor: (role) => opts.models[role],
    available: () =>
      budget() > 0 &&
      read(WORKERS_AI_TOKEN_ENV) !== undefined &&
      read(WORKERS_AI_ACCOUNT_ENV) !== undefined,
    async call(req: ProviderRequest, signal?: AbortSignal): Promise<ProviderResult> {
      // Budget first, credentials second: a budget of 0 never reaches the network and never reads a secret.
      if (budget() === 0) throw new RateLimitError(WORKERS_AI_ID);
      const token = read(WORKERS_AI_TOKEN_ENV);
      const account = read(WORKERS_AI_ACCOUNT_ENV);
      if (!token || !account) throw new Error(`${WORKERS_AI_ID}: no credentials configured`);
      const need = estimateNeurons(req);
      if (spentToday() + need > budget()) throw new RateLimitError(WORKERS_AI_ID);
      const doFetch = opts.fetchImpl ?? fetch;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), opts.timeoutMs);
      signal?.addEventListener("abort", () => ctl.abort());
      try {
        const body: Json = {
          messages: [{ role: "user", content: req.prompt }],
          max_tokens: req.maxOutputTokens,
          temperature: 0,
        };
        if (req.responseSchema) {
          body.response_format = {
            type: "json_schema",
            json_schema: toProviderSchema(req.responseSchema, "groq-strict"),
          };
        }
        const model = req.model.split("/").map(encodeURIComponent).join("/").replace("%40", "@");
        // Charged before the call: a failed or timed-out request may still have used neurons.
        spentInProcess += need;
        const res = await doFetch(`${BASE}/${encodeURIComponent(account)}/ai/run/${model}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
          signal: ctl.signal,
        });
        if (res.status === HTTP_TOO_MANY) throw new RateLimitError(WORKERS_AI_ID);
        // Status only: response bodies can echo request details.
        if (!res.ok) throw new ProviderHttpError(`${WORKERS_AI_ID}: http ${res.status}`);
        const data = (await res.json()) as Json;
        const result = (data.result ?? {}) as Json;
        const usage = (result.usage ?? {}) as Json;
        const answer = result.response;
        return {
          text: typeof answer === "string" ? answer : answer == null ? "" : JSON.stringify(answer),
          tokensIn: num(usage.prompt_tokens),
          tokensOut: num(usage.completion_tokens),
        };
      } catch (e) {
        if (e instanceof RateLimitError || e instanceof ProviderHttpError) throw e;
        if (ctl.signal.aborted) throw new Error(`${WORKERS_AI_ID}: timeout`);
        throw new Error(`${WORKERS_AI_ID}: request failed`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
