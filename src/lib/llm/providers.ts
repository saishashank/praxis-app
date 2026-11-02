// Provider interface, deterministic mock, and live adapters (LLM-003, 011, 012, 020, 036). Live
// adapters exist behind the interface but are never constructed by the M4 pipeline and never called
// in tests (design 4.6, decision 3: no live role before the bake-off). Keys are read from env vars at
// call time only and never logged or put in error text. A missing key means "unavailable".
import { createHash } from "node:crypto";
import type { Role } from "./budget";
import { toProviderSchema, type JsonSchema } from "./jsonSchema";
import { supportsStrictSchema } from "./roster";

/** Stable JSON: object keys sorted, so equal values hash equally on every machine. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Cache key and fixture key: sha256 of (role, model, prompt template version, prompt inputs). */
export function promptSha(role: Role, model: string, templateVersion: string, prompt: string) {
  return sha256Hex(canonicalJson({ role, model, templateVersion, prompt }));
}

export type ProviderRequest = {
  role: Role;
  model: string;
  prompt: string;
  promptSha: string;
  maxOutputTokens: number;
  /** LLM-071: the answer schema; sent in the provider's strict mode only when the roster allows it. */
  responseSchema?: JsonSchema;
};

export type ProviderResult = { text: string; tokensIn: number; tokensOut: number };

export class RateLimitError extends Error {
  constructor(public readonly provider: string) {
    super(`${provider}: rate limited`);
    this.name = "RateLimitError";
  }
}

export class ProviderHttpError extends Error {}

export class NoFixtureError extends Error {
  constructor(public readonly sha: string) {
    super(`mock: no recorded fixture for ${sha}`);
    this.name = "NoFixtureError";
  }
}

export interface LlmProvider {
  readonly id: string;
  /** "live" providers are never called in tests; "mock" replays fixtures. */
  readonly kind: "mock" | "live";
  /** LLM-003: a paid endpoint is refused by the router. */
  readonly paid: boolean;
  /** LLM-036: true => the router sends only extracted facts, never third-party text. */
  readonly trainsOnPrompts: boolean;
  /** Optional per-provider daily request budget (LLM-021); undefined = unmetered here. */
  readonly dailyRequests?: number;
  /** Model per role (LLM-012: from configuration); a role without a model is skipped. */
  modelFor(role: Role): string | undefined;
  available(): boolean;
  call(req: ProviderRequest, signal?: AbortSignal): Promise<ProviderResult>;
}

// ---------------------------------------------------------------------------------------------
// Mock: replays recorded fixture answers by prompt hash (CI and replay only). Deterministic.

export type MockFixture = { text: string; tokensIn: number; tokensOut: number };

export type MockOptions = {
  id?: string;
  model: string;
  roles: readonly Role[];
  fixtures: Readonly<Record<string, MockFixture>>;
  trainsOnPrompts?: boolean;
};

export function createMockProvider(opts: MockOptions): LlmProvider {
  const roles = new Set<Role>(opts.roles);
  return {
    id: opts.id ?? "mock",
    kind: "mock",
    paid: false,
    trainsOnPrompts: opts.trainsOnPrompts ?? false,
    modelFor: (role) => (roles.has(role) ? opts.model : undefined),
    available: () => true,
    call(req) {
      const hit = Object.prototype.hasOwnProperty.call(opts.fixtures, req.promptSha)
        ? opts.fixtures[req.promptSha]
        : undefined;
      if (!hit) return Promise.reject(new NoFixtureError(req.promptSha));
      return Promise.resolve({ ...hit });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Live adapters (Google AI Studio, Groq, OpenRouter). HTTP via fetch with a timeout.

export type LiveKind = "google" | "groq" | "openrouter";

/** Environment variable that holds each provider's key (read at call time, never logged). */
export const KEY_ENV: Readonly<Record<LiveKind, string>> = {
  google: "GOOGLE_AI_API_KEY",
  groq: "GROQ_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

const ENDPOINTS: Readonly<Record<LiveKind, string>> = {
  google: "https://generativelanguage.googleapis.com/v1beta/models",
  groq: "https://api.groq.com/openai/v1/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
};

const HTTP_TOO_MANY = 429; // threshold-ok: HTTP status code

export type LiveOptions = {
  kind: LiveKind;
  models: Readonly<Partial<Record<Role, string>>>;
  trainsOnPrompts: boolean;
  timeoutMs: number;
  dailyRequests?: number;
  /** Declared paid endpoints are refused by the router (LLM-003). */
  paid?: boolean;
  env?: Readonly<Record<string, string | undefined>>;
  fetchImpl?: typeof fetch;
};

type Json = Record<string, unknown>;
/** Groq model ids of the GPT-OSS reasoning family (D-182). */
const GROQ_REASONING_PREFIX = "openai/gpt-oss";

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function createLiveProvider(opts: LiveOptions): LlmProvider {
  const env = (): Readonly<Record<string, string | undefined>> => opts.env ?? process.env;
  const key = (): string | undefined => {
    const k = env()[KEY_ENV[opts.kind]];
    return k && k.trim() !== "" ? k : undefined;
  };
  return {
    id: opts.kind,
    kind: "live",
    // OpenRouter is $0 only through ":free" models (LLM-003); a non-free model id marks it paid.
    paid:
      opts.paid ??
      (opts.kind === "openrouter" &&
        Object.values(opts.models).some((m) => m !== undefined && !m.endsWith(":free"))),
    trainsOnPrompts: opts.trainsOnPrompts,
    dailyRequests: opts.dailyRequests,
    modelFor: (role) => opts.models[role],
    available: () => key() !== undefined,
    async call(req, signal) {
      const apiKey = key();
      if (!apiKey) throw new Error(`${opts.kind}: no key configured`);
      const doFetch = opts.fetchImpl ?? fetch;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), opts.timeoutMs);
      signal?.addEventListener("abort", () => ctl.abort());
      try {
        let url: string;
        let headers: Record<string, string>;
        let body: Json;
        if (opts.kind === "google") {
          url = `${ENDPOINTS.google}/${encodeURIComponent(req.model)}:generateContent`;
          headers = { "content-type": "application/json", "x-goog-api-key": apiKey };
          body = {
            contents: [{ role: "user", parts: [{ text: req.prompt }] }],
            generationConfig: {
              maxOutputTokens: req.maxOutputTokens,
              responseMimeType: "application/json",
              temperature: 0,
            },
          };
          if (req.responseSchema && supportsStrictSchema("google", req.model)) {
            (body.generationConfig as Json).responseSchema = toProviderSchema(
              req.responseSchema,
              "gemini",
            );
          }
        } else {
          url = ENDPOINTS[opts.kind];
          headers = { "content-type": "application/json", authorization: `Bearer ${apiKey}` };
          body = {
            model: req.model,
            messages: [{ role: "user", content: req.prompt }],
            max_tokens: req.maxOutputTokens,
            temperature: 0,
            response_format: { type: "json_object" },
          };
          if (req.responseSchema && supportsStrictSchema(opts.kind, req.model)) {
            // LLM-071: strict structured output; only Groq entries carry strictSchema in the roster.
            body.response_format = {
              type: "json_schema",
              json_schema: {
                name: "answer",
                strict: true,
                schema: toProviderSchema(req.responseSchema, "groq-strict"),
              },
            };
          }
          // D-182: Groq's GPT-OSS models reason before answering, and the reasoning shares the
          // output budget; at the default effort a short JSON answer was cut off and Groq refused it
          // (HTTP 400). Low effort, reasoning not returned.
          if (opts.kind === "groq" && req.model.startsWith(GROQ_REASONING_PREFIX)) {
            body.reasoning_effort = "low";
            body.include_reasoning = false;
          }
        }
        const res = await doFetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: ctl.signal,
        });
        if (res.status === HTTP_TOO_MANY) throw new RateLimitError(opts.kind);
        // Status only: response bodies and headers can echo request details.
        if (!res.ok) throw new ProviderHttpError(`${opts.kind}: http ${res.status}`);
        const data = (await res.json()) as Json;
        if (opts.kind === "google") {
          const cand = (data.candidates as Json[] | undefined)?.[0];
          const parts = (cand?.content as Json | undefined)?.parts as Json[] | undefined;
          const usage = (data.usageMetadata ?? {}) as Json;
          return {
            text: String(parts?.[0]?.text ?? ""),
            tokensIn: num(usage.promptTokenCount),
            tokensOut: num(usage.candidatesTokenCount),
          };
        }
        const choice = (data.choices as Json[] | undefined)?.[0];
        const usage = (data.usage ?? {}) as Json;
        return {
          text: String((choice?.message as Json | undefined)?.content ?? ""),
          tokensIn: num(usage.prompt_tokens),
          tokensOut: num(usage.completion_tokens),
        };
      } catch (e) {
        if (e instanceof RateLimitError || e instanceof ProviderHttpError) throw e;
        if (ctl.signal.aborted) throw new Error(`${opts.kind}: timeout`);
        throw new Error(`${opts.kind}: request failed`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
