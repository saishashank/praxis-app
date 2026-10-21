// A7 Critic wording (M6 T6; AGT-041, LLM-010, LLM-021, KB-060, LLM-037; D-110 #4, #5, M6 design 4.6).
// Worded concerns and alternatives for the subjects the Critic checked, through the R3 role of the
// router (rules-only or mock until the bake-off; no live provider in M6). Numbers are never worded:
// the pack holds the stored check results, the router's grounding rejects any number, date or
// ticker that is not in the pack, and the answer is capped in item count and length.
//
//   - at most `critic_llm_calls_per_night` subjects are worded per run: challengers first, then
//     lessons by grade (highest first), then id; the rest get a `critique_note` row marked
//     deferred = 1 with the text "critic wording deferred" (their deterministic checks still ran);
//   - the provider chain starts with a provider other than the one that wrote the subject's A6 text
//     (LLM-010); only one provider -> a different model, logged; neither -> rules-only, logged;
//   - the text is stored in `critique_note` and shown in the app only; it never blocks anything and
//     no rule reads it (AGT-042, AGT-011a). Re-running a run id writes nothing new.
import type { Client } from "@libsql/client";
import type { AgentParams } from "@/lib/agents/params";
import type { LlmProvider } from "@/lib/llm/providers";
import type { LlmRouter } from "@/lib/llm/router";
import { CRITIC_CHECK_COUNT, type CriticState } from "./challengerLifecycle";
import type { Evaluation } from "./critic";

export const CRITIC_WORDING_DEFERRED = "critic wording deferred";
export const CRITIC_TEMPLATE_VERSION = "critic-concerns-v1";
const ROLE = "R3" as const;
/** Cap on one concern or alternative line, and on the answer's size (reply tokens). */
const MAX_LINE_CHARS = 400; // threshold-ok: output cap on worded text, not a rule threshold
const MAX_OUTPUT_TOKENS = 400; // threshold-ok: reply-size cap for one R3 answer

export type Wording = {
  readonly concerns: readonly string[];
  readonly alternatives: readonly string[];
};

/** The subject as the Critic worded it. */
export type WordingSubject = {
  readonly evaluation: Evaluation;
  /** Lesson grade for ordering; null for a challenger. */
  readonly grade: "L1" | "L2" | "L3" | null;
  /** Provider and model that wrote the subject's A6 text (LLM-010); null = rules text. */
  readonly author?: { readonly provider: string; readonly model: string } | null;
};

const GRADE_RANK: Record<string, number> = { L3: 3, L2: 2, L1: 1 }; // threshold-ok: ordering rank

/** Challengers first, then lessons by grade (desc), then id. */
export function orderForWording(subjects: readonly WordingSubject[]): WordingSubject[] {
  const rank = (s: WordingSubject): number =>
    s.grade === null ? Number.MAX_SAFE_INTEGER : (GRADE_RANK[s.grade] ?? 0);
  return [...subjects].sort(
    (a, b) =>
      rank(b) - rank(a) ||
      (a.evaluation.id < b.evaluation.id ? -1 : a.evaluation.id > b.evaluation.id ? 1 : 0),
  );
}

// ---- provider rule (LLM-010, D-110 #4) -------------------------------------------------------------------------

export type CriticChain = {
  /** Provider ids for the router chain, in order; empty = rules-only. */
  readonly chain: readonly string[];
  readonly rule: "different-provider" | "different-model" | "rules-only";
  /** The log line when the rule degraded (null for a plain different provider). */
  readonly log: string | null;
};

export function pickCriticChain(
  providers: readonly LlmProvider[],
  author: WordingSubject["author"],
): CriticChain {
  const usable = providers.filter(
    (p) => !p.paid && p.available() && p.modelFor(ROLE) !== undefined,
  );
  if (!author) {
    return { chain: usable.map((p) => p.id), rule: "different-provider", log: null };
  }
  const other = usable.filter((p) => p.id !== author.provider);
  if (other.length > 0) {
    return { chain: other.map((p) => p.id), rule: "different-provider", log: null };
  }
  const sameProviderOtherModel = usable.filter(
    (p) => p.id === author.provider && p.modelFor(ROLE) !== author.model,
  );
  if (sameProviderOtherModel.length > 0) {
    return {
      chain: sameProviderOtherModel.map((p) => p.id),
      rule: "different-model",
      log: `LLM-010 degraded: only provider ${author.provider} is available, critic uses a different model`,
    };
  }
  return {
    chain: [],
    rule: "rules-only",
    log: `LLM-010 degraded: no provider or model differs from ${author.provider}/${author.model}, rules-only wording`,
  };
}

// ---- pack, template and parse ---------------------------------------------------------------------------------

/** The compact pack: stored check results only; no annotations, no third-party text (KB-060). */
export function packOf(s: WordingSubject): Record<string, unknown> {
  return {
    subject: { kind: s.evaluation.kind, grade: s.grade },
    checks: s.evaluation.checks.map((c) => ({
      n: c.n,
      name: c.name,
      state: c.state,
      detail: c.detail,
    })),
  };
}

const ALTERNATIVE: readonly string[] = [
  "Wait for more rows and blocks before relying on this result.",
  "Look at the result per regime before relying on the pooled estimate.",
  "Re-run the result with the stress costs and compare.",
  "Review the flagged rows and the input dates of the window.",
  "Wait for the luck test before treating this as more than a note.",
  "Bring every parameter back inside its bounds.",
];

const STATE_WORD: Record<CriticState, string> = {
  pass: "passed",
  fail: "failed",
  pending: "is pending",
  not_assessable: "cannot be assessed",
};

/** Template wording from the failed, pending and not-assessable checks (the rules-only answer). */
export function templateWording(e: Evaluation): Wording {
  const open = e.checks.filter((c) => c.state !== "pass");
  if (open.length === 0) {
    return { concerns: ["No deterministic check failed."], alternatives: [] };
  }
  return {
    concerns: open.map((c) => `Check ${c.n} (${c.name}) ${STATE_WORD[c.state]}: ${c.detail}.`),
    alternatives: open.map((c) => ALTERNATIVE[c.n - 1]!),
  };
}

/** Schema and caps: arrays of strings, at most one line per check, each line capped. */
export function parseWording(v: unknown): Wording | null {
  if (v === null || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const ok = (a: unknown): a is string[] =>
    Array.isArray(a) &&
    a.length <= CRITIC_CHECK_COUNT &&
    a.every((x) => typeof x === "string" && x.length > 0 && x.length <= MAX_LINE_CHARS);
  if (!ok(o.concerns) || !ok(o.alternatives)) return null;
  return { concerns: o.concerns, alternatives: o.alternatives };
}

// ---- the run -------------------------------------------------------------------------------------------------

export type RouterFactory = (chain: readonly string[]) => LlmRouter;

export type WordingOutcome = {
  readonly id: string;
  readonly kind: "lesson" | "challenger";
  readonly status: "worded" | "deferred" | "existing";
  /** "rules-only", "cache" or the provider id. */
  readonly source: string | null;
  readonly rule: CriticChain["rule"] | null;
};

export type WordingReport = {
  readonly outcomes: readonly WordingOutcome[];
  readonly worded: number;
  readonly deferred: number;
  /** LLM-010 degrade lines to put in the run log. */
  readonly log: readonly string[];
};

async function hasNotes(db: Client, kind: string, id: string, runId: string): Promise<boolean> {
  const r = await db.execute({
    sql: "SELECT 1 FROM critique_note WHERE subject_kind = ? AND subject_id = ? AND run_id = ?",
    args: [kind, id, runId],
  });
  return r.rows.length > 0;
}

type NoteRow = {
  readonly kind: "concerns" | "alternatives";
  readonly text: string;
  readonly provider: string | null;
  readonly modelId: string | null;
  readonly depth: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly promptSha: string | null;
  readonly deferred: 0 | 1;
};

async function putNote(db: Client, s: WordingSubject, runId: string, n: NoteRow): Promise<void> {
  await db.execute({
    sql: `INSERT OR IGNORE INTO critique_note (subject_kind, subject_id, run_id, kind, text, provider,
            model_id, fallback_depth, tokens_in, tokens_out, prompt_sha, deferred)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      s.evaluation.kind,
      s.evaluation.id,
      runId,
      n.kind,
      n.text,
      n.provider,
      n.modelId,
      n.depth,
      n.tokensIn,
      n.tokensOut,
      n.promptSha,
      n.deferred,
    ],
  });
}

/**
 * Words the concerns of the checked subjects (nightly, role R3). Writes `critique_note` rows only;
 * the deterministic states are never touched, so rules-only and mock runs have identical gates.
 */
export async function wordConcerns(
  db: Client,
  args: {
    readonly market: string;
    readonly d: string;
    readonly runId: string;
    readonly params: AgentParams;
    readonly subjects: readonly WordingSubject[];
    readonly providers: readonly LlmProvider[];
    readonly routerFor: RouterFactory;
  },
): Promise<WordingReport> {
  const cap = args.params.learning.criticLlmCallsPerNight;
  const outcomes: WordingOutcome[] = [];
  const log: string[] = [];
  let calls = 0;
  for (const s of orderForWording(args.subjects)) {
    const e = s.evaluation;
    if (await hasNotes(db, e.kind, e.id, args.runId)) {
      outcomes.push({ id: e.id, kind: e.kind, status: "existing", source: null, rule: null });
      continue;
    }
    if (calls >= cap) {
      for (const kind of ["concerns", "alternatives"] as const) {
        await putNote(db, s, args.runId, {
          kind,
          text: CRITIC_WORDING_DEFERRED,
          provider: null,
          modelId: null,
          depth: "deferred",
          tokensIn: 0,
          tokensOut: 0,
          promptSha: null,
          deferred: 1,
        });
      }
      outcomes.push({ id: e.id, kind: e.kind, status: "deferred", source: null, rule: null });
      continue;
    }
    calls += 1;
    const pick = pickCriticChain(args.providers, s.author);
    if (pick.log !== null) log.push(`${e.kind} ${e.id}: ${pick.log}`);
    const router = args.routerFor(pick.chain);
    const res = await router.route<Wording>({
      role: ROLE,
      market: args.market,
      d: args.d,
      nightly: true,
      templateVersion: CRITIC_TEMPLATE_VERSION,
      task:
        "You are the Critic. From the stored check results in FACTS write short concerns and " +
        "alternatives about the subject. Reply as JSON {concerns: string[], alternatives: string[]}. " +
        "Do not state any number that is not in FACTS.",
      facts: packOf(s),
      parse: parseWording,
      rules: templateWording(e),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
    const provider = !res.llmUsed
      ? null
      : res.source === "cache"
        ? (res.attempts[res.attempts.length - 1]?.provider ?? null)
        : res.source;
    const hit = provider === null ? undefined : args.providers.find((p) => p.id === provider);
    const modelId = hit?.modelFor(ROLE) ?? null;
    const depth = provider === null ? "rules-only" : String(pick.chain.indexOf(provider));
    const common = {
      provider,
      modelId,
      depth,
      tokensIn: res.call.tokensIn,
      tokensOut: res.call.tokensOut,
      promptSha: res.llmUsed ? (res.call.promptShas[0] ?? null) : null,
      deferred: 0 as const,
    };
    await putNote(db, s, args.runId, {
      ...common,
      kind: "concerns",
      text: res.value.concerns.join("\n"),
    });
    await putNote(db, s, args.runId, {
      ...common,
      kind: "alternatives",
      text: res.value.alternatives.join("\n"),
    });
    outcomes.push({
      id: e.id,
      kind: e.kind,
      status: "worded",
      source: res.source,
      rule: pick.rule,
    });
  }
  return {
    outcomes,
    worded: outcomes.filter((o) => o.status === "worded").length,
    deferred: outcomes.filter((o) => o.status === "deferred").length,
    log,
  };
}
