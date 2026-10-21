import fixture from "../fixtures/llm/r2_event_summary.json";
import { defaultAgentParams } from "@/lib/agents/params";
import type { Role } from "@/lib/llm/budget";
import {
  createMockProvider,
  promptSha,
  type LlmProvider,
  type MockFixture,
} from "@/lib/llm/providers";
import { buildPrompt, createRouter, type RouteRequest, type RouterMode } from "@/lib/llm/router";
import { filterMany } from "@/lib/llm/injection";
import { MemoryStore, type LlmStore } from "@/lib/llm/store";

export type Note = { note: string };
export const parseNote = (v: unknown): Note | null =>
  v !== null && typeof v === "object" && typeof (v as Note).note === "string"
    ? { note: (v as Note).note }
    : null;

export const MOCK_MODEL = "mock-1";

export function request(over: Partial<RouteRequest<Note>> = {}): RouteRequest<Note> {
  return {
    role: fixture.role as Role,
    market: "AU",
    d: "2026-03-05",
    templateVersion: fixture.templateVersion,
    task: fixture.task,
    facts: fixture.facts,
    untrusted: fixture.untrusted,
    parse: parseNote,
    rules: fixture.rulesNote,
    maxOutputTokens: 200,
    ...over,
  };
}

/** The prompt the router builds for the mock provider (untrusted text filtered). */
export function promptFor(req: RouteRequest<Note>, repair = false): string {
  return buildPrompt(req.task, req.facts, filterMany(req.untrusted ?? []).texts, repair);
}

export function fixtureFor(req: RouteRequest<Note>, answer: unknown): Record<string, MockFixture> {
  const sha = promptSha(req.role, MOCK_MODEL, req.templateVersion, promptFor(req));
  return { [sha]: { text: JSON.stringify(answer), tokensIn: 120, tokensOut: 30 } };
}

export function mockProvider(fixtures: Record<string, MockFixture>): LlmProvider {
  return createMockProvider({ model: MOCK_MODEL, roles: ["R1", "R2", "R3", "R5"], fixtures });
}

export function makeRouter<S extends LlmStore = MemoryStore>(
  mode: RouterMode,
  providers: LlmProvider[],
  store: S = new MemoryStore() as unknown as S,
  extra: Partial<Parameters<typeof createRouter>[0]> = {},
) {
  let n = 0;
  const router = createRouter({
    mode,
    params: defaultAgentParams().llm,
    kbVersion: "kb1",
    store,
    providers,
    now: () => new Date("2026-03-05T10:00:00.000Z"),
    idFactory: () => `call-${++n}`,
    ...extra,
  });
  return { router, store };
}

export { fixture };
