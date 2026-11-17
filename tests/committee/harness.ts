// Test-only helpers for the Committee tests (M22 C1): scripted providers with an R6 and an R7 model, a CommitteeLlm over
// them (the shape the factory will deliver), the synthetic ZZ night of the steelman harness plus a pre-registration row,
// and the stage answers. Not a test file. Synthetic data only (SEC-110).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import type { LlmParams } from "@/lib/agents/params";
import type { Role } from "@/lib/llm/budget";
import type { ProviderRequest } from "@/lib/llm/providers";
import { createRouter } from "@/lib/llm/router";
import { MemoryStore } from "@/lib/llm/store";
import type { CommitteeLlm, RouterSelect } from "@/lib/committee/debate";
import type { CommitteeKeys, CommitteeNightOptions } from "@/lib/committee/night";
import { D, MARKET, NOW, params, seedNight, type Scripted } from "../steelman/nightHarness";

export { D, MARKET, NOW, params, seedNight };

/** The evidence ids in the FACTS line of a prompt (the line may be the last one: no data section follows). */
export function idsOf(prompt: string): string[] {
  const m = /FACTS:\n(.*)(?:\n|$)/.exec(prompt);
  if (!m) return [];
  const facts = JSON.parse(m[1]!) as { items?: { id: string }[] };
  return (facts.items ?? []).map((i) => i.id);
}

export const KEYS: CommitteeKeys = {
  enabled: true,
  shortlist: 2,
  maxItems: 25,
  decisionCutoff: "18:10",
  retentionMonths: 18,
};

/** A mock provider that answers by stage (the bull, bear, risk or judge task in the prompt); counts its calls. */
export function committeeProvider(
  id: string,
  models: { R6?: string; R7?: string } = { R6: `${id}-r6`, R7: `${id}-r7` },
  answer: (req: ProviderRequest, stage: string) => string = defaultAnswer,
  onCall?: () => void,
): Scripted {
  const calls: ProviderRequest[] = [];
  return {
    id,
    kind: "mock",
    paid: false,
    trainsOnPrompts: false,
    modelFor: (r: Role) => (r === "R6" ? models.R6 : r === "R7" ? models.R7 : undefined),
    available: () => true,
    call(req) {
      calls.push(req);
      onCall?.();
      return Promise.resolve({
        text: answer(req, stageOf(req.prompt)),
        tokensIn: 100,
        tokensOut: 100,
      });
    },
    calls,
  };
}

export function stageOf(prompt: string): string {
  const m = /You are the (bull|bear|risk officer|judge)/.exec(prompt);
  return m ? (m[1] === "risk officer" ? "risk" : m[1]!) : "unknown";
}

const TEXT = JSON.parse(
  readFileSync(join(import.meta.dirname, "../fixtures/committee/answers.json"), "utf8"),
) as Record<string, [string, string]>;

/** Valid, digit-free answers citing the pack's first ids; the judge says `approve`. */
export function defaultAnswer(req: ProviderRequest, stage: string): string {
  const ids = idsOf(req.prompt);
  const at = (n: number): string[] => [ids[n % ids.length]!];
  const [a, b] = TEXT[stage] ?? TEXT.bull!;
  const points = [
    { text: a, citations: at(0) },
    { text: b, citations: at(1) },
  ];
  return JSON.stringify(stage === "judge" ? { rating: "approve", reasons: points } : { points });
}

export function judgeSays(rating: string): (req: ProviderRequest, stage: string) => string {
  return (req, stage) => {
    if (stage !== "judge") return defaultAnswer(req, stage);
    const j = JSON.parse(defaultAnswer(req, stage)) as Record<string, unknown>;
    return JSON.stringify({ ...j, rating });
  };
}

/** The CommitteeLlm the factory will deliver: a router per role over the providers that have a model for it. */
export function committeeLlm(
  providers: readonly Scripted[],
  store = new MemoryStore(),
  lp: LlmParams = params.llm,
): CommitteeLlm & { routerCalls: Array<{ role: string; select?: RouterSelect }> } {
  const routerCalls: Array<{ role: string; select?: RouterSelect }> = [];
  return {
    routerCalls,
    providers,
    store,
    routerFor(role, select) {
      routerCalls.push({ role, select });
      const ids = providers
        .filter((p) => p.modelFor(role) !== undefined)
        .map((p) => p.id)
        .filter((i) => select?.only === undefined || i === select.only)
        .filter((i) => !(select?.avoid ?? []).includes(i));
      if (ids.length === 0) return null;
      return createRouter({
        mode: "mock",
        params: lp,
        kbVersion: "t",
        store,
        providers,
        chain: { [role]: ids },
        now: () => new Date(NOW),
      });
    },
  };
}

/** A pre-registration row (what task C2 writes before the first rated night), optionally with its final verdict. */
export async function seedTrial(db: Client, final = false): Promise<void> {
  await db.execute(
    `INSERT INTO committee_prereg (trial_id, version, market, frozen_json, sha, created_at)
     VALUES ('t1', 1, 'AU', '{}', '${"a".repeat(64)}', '2026-03-01T00:00:00Z')`,
  );
  if (final)
    await db.execute(
      `INSERT INTO committee_trial_result (trial_id, market, d, kind, verdict, stats_json, created_at)
       VALUES ('t1', 'AU', '2026-03-03', 'final', 'FAIL', '{}', '2026-03-03T00:00:00Z')`,
    );
}

export function nightOptions(
  llm: CommitteeLlm,
  over: Partial<CommitteeNightOptions> = {},
): CommitteeNightOptions {
  return {
    market: MARKET,
    d: D,
    today: D,
    llmParams: params.llm,
    keys: KEYS,
    llm,
    live: { R6: true, R7: true },
    now: NOW,
    nowMs: () => 0,
    deadlineMs: Number.MAX_SAFE_INTEGER,
    ...over,
  };
}

export const count = async (db: Client, table: string): Promise<number> =>
  Number((await db.execute(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0]!.n);
