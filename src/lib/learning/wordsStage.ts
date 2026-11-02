// The `words` phase: the model-worded text of the night, after `learn` (M6 T11; LLM-010/021/031/050,
// ARN-068, AGT-041/042, KB-060; docs/M6_design.md 4.1 and 4.3; D-110 #4 #5 #48; D-120, D-123).
//
// ONE run per session D, keyed `arena-words:<market>:<D>`. Every model call goes through the router
// (rules-only or mock until the bake-off); this module decides nothing and writes only text:
//   1. A7 concerns: the Critic's stored checks of the subjects that changed tonight (or never had notes)
//      are worded by `wordConcerns` (R3), at most `critic_llm_calls_per_night` subjects, challengers
//      first, then lessons by grade; the rest get a `deferred` note. Numbers are never worded.
//   2. R5 narrative of the Evening Review (sections 4-6), moved here from batch 3 so it reads the A6
//      output of `learn`; stored in `replay_stat` under this run's key, used only if grounded.
// Budget (LLM-050 s13, D-110 #48): before any R3 call the phase RESERVES the R5 narrative's maximum
// (its output cap plus the estimated prompt) inside the nightly and the daily-total caps, so the review
// text is the last thing dropped; an R3 call that would eat the reservation is answered rules-only.
// Preconditions as the other phases: market mode `full` (or a replay on a non-production database); a
// missing `learn` run of D makes the output PARTIAL (`degraded`), never touching orders (AGT-004/050).
// On a non-trading day only the concerns are worded (the review of such a day is facts-only R5-wise).
import type { Client } from "@libsql/client";
import { isTradingDay, type CalendarRow } from "@/lib/data/calendar";
import { hasSuccess, finishRun, startRun } from "@/lib/runs/runRecord";
import { loadCalendar } from "@/lib/arena/closeBooks";
import { loadAgentParams, type AgentParams } from "@/lib/agents/params";
import { narrativeStage } from "@/lib/agents/batch3";
import { allowance, fits } from "@/lib/llm/budget";
import type { LlmProvider } from "@/lib/llm/providers";
import { BUDGET_EXHAUSTED, requestReservation, type LlmRouter } from "@/lib/llm/router";
import type { LlmStore } from "@/lib/llm/store";
import { loadCtx, narrativeRequest, readNarrativePack } from "@/lib/review/sections";
import { CRITIC_CHECK_NAMES, type Evaluation } from "./critic";
import {
  wordConcerns,
  type RouterFactory,
  type WordingReport,
  type WordingSubject,
} from "./criticWords";
import { currentKbVersion } from "./kbVersion";
import { WORDS_JOB, learnKey, wordsKey } from "./learnFacts";

export { WORDS_JOB, wordsKey };

const LOG_MESSAGE_MAX = 500; // threshold-ok: app_log message length cap (as the other phases)

/** What the phase talks to: the R5 router, the A7 chain (providers and a router per chain), the call log. */
export type WordsLlm = {
  readonly r5Router: LlmRouter;
  readonly providers: readonly LlmProvider[];
  readonly routerFor: RouterFactory;
  /** The call log the budget reservation reads (the same store the routers write to). */
  readonly store: LlmStore;
};

export type WordsOptions = {
  readonly market: string;
  readonly d: string;
  readonly replay?: boolean;
  readonly now: () => string;
  readonly commitSha?: string | null;
  readonly calendar?: CalendarRow[];
  readonly params?: AgentParams;
  /** The routers, built once the guards passed (params and the KB version in force are supplied). */
  readonly llm: (ctx: { params: AgentParams; kbVersion: string }) => WordsLlm;
};

export type WordsStatus = "success" | "degraded" | "failed" | "skipped" | "already_done";

export type WordsStats = {
  partialReason: string | null;
  subjects: number;
  worded: number;
  deferred: number;
  /** R3 calls answered rules-only because they would have eaten the R5 reservation. */
  reservedBlocks: number;
  /** Tokens held back for the R5 narrative (0 when no narrative is due). */
  reservedTokens: number;
  llm010Degraded: number;
  narrative: "llm" | "rules" | null;
  stepsFailed: string[];
};

export type WordsResult = {
  readonly market: string;
  readonly d: string;
  readonly status: WordsStatus;
  readonly reason: string | null;
  readonly runId: number | null;
  readonly stats: WordsStats;
};

const text = (v: unknown): string => String(v);

const emptyStats = (): WordsStats => ({
  partialReason: null,
  subjects: 0,
  worded: 0,
  deferred: 0,
  reservedBlocks: 0,
  reservedTokens: 0,
  llm010Degraded: 0,
  narrative: null,
  stepsFailed: [],
});

const result = (
  o: WordsOptions,
  status: WordsStatus,
  reason: string | null,
  runId: number | null,
  stats = emptyStats(),
): WordsResult => ({ market: o.market, d: o.d, status, reason, runId, stats });

async function recordSkip(db: Client, o: WordsOptions, reason: string): Promise<WordsResult> {
  const runId = await startRun(db, {
    job: WORDS_JOB,
    market: o.market,
    concurrencyKey: wordsKey(o.market, o.d),
    scheduledFor: o.d,
    commitSha: o.commitSha ?? undefined,
    now: o.now(),
  });
  await finishRun(db, runId, { status: "skipped", details: { reason }, now: o.now() });
  return result(o, "skipped", reason, runId);
}

async function log(
  db: Client,
  o: WordsOptions,
  level: "warn" | "error",
  message: string,
  runId: number,
): Promise<void> {
  await db.execute({
    sql: "INSERT INTO app_log (at, level, source, message, run_id) VALUES (?, ?, ?, ?, ?)",
    args: [o.now(), level, WORDS_JOB, message.slice(0, LOG_MESSAGE_MAX), runId],
  });
}

// ---- the reservation (D-110 #48) -------------------------------------------------------------------------------------

/** The tokens the R5 narrative can need: its output cap plus the estimated size of its prompt. */
export function narrativeReserve(req: {
  readonly task: string;
  readonly facts: unknown;
  readonly maxOutputTokens: number;
}): number {
  return requestReservation(req, undefined);
}

/**
 * A router that answers an R3 request rules-only when it would not fit under the stricter of the
 * role, daily-total and nightly caps AFTER `reserve` tokens are set aside for R5 (the reserve counts as
 * already spent in the shared total and nightly caps; the R3 role cap is unaffected). Other roles and
 * routers in `off` / `rules-only` mode (no tokens) pass straight through.
 */
export function reservingRouter(
  base: LlmRouter,
  args: {
    readonly reserve: number;
    readonly params: AgentParams;
    readonly store: LlmStore;
    readonly onBlocked: () => void;
  },
): LlmRouter {
  return {
    mode: base.mode,
    route: async (req) => {
      if (
        req.role !== "R3" ||
        args.reserve <= 0 ||
        (base.mode !== "mock" && base.mode !== "live")
      ) {
        return base.route(req);
      }
      const usage = await args.store.usage("R3", req.market, req.d);
      const allow = allowance(args.params.llm, "R3", req.market, req.nightly === true, {
        roleDay: usage.roleDay,
        totalDay: usage.totalDay + args.reserve,
        marketNight: usage.marketNight + args.reserve,
      });
      const projected = requestReservation(req, req.untrusted);
      if (fits(allow, projected)) return base.route(req);
      args.onBlocked();
      return {
        value: req.rules,
        source: "rules-only",
        llmUsed: false,
        cached: false,
        outcome: BUDGET_EXHAUSTED,
        budgetExhausted: true,
        injectionFiltered: false,
        injectionRemoved: 0,
        attempts: [{ provider: "rules-only", outcome: `budget-reserved:${allow.binding}` }],
        call: { id: "", promptShas: [], tokensIn: 0, tokensOut: 0, costMicro: 0 },
      };
    },
  } as LlmRouter;
}

// ---- the Critic subjects to word ------------------------------------------------------------------------------------

type StoredCheck = {
  n: number;
  state: Evaluation["checks"][number]["state"];
  detail: string;
  values: Evaluation["checks"][number]["values"];
};

function evaluationOf(
  kind: "lesson" | "challenger",
  id: string,
  checksJson: string,
  passed: boolean,
): Evaluation {
  const stored = JSON.parse(checksJson) as StoredCheck[];
  return {
    kind,
    id,
    passed,
    checks: stored.map((c) => ({
      n: c.n,
      name: CRITIC_CHECK_NAMES[c.n - 1] ?? "",
      state: c.state,
      detail: c.detail,
      values: c.values,
    })),
  };
}

/**
 * Subjects whose latest Critic result needs wording: it was written on D, or the subject has no
 * `critique_note` yet. Challengers still in the pipeline and lessons graded L1..L3 only.
 */
export async function subjectsToWord(
  db: Client,
  market: string,
  d: string,
): Promise<WordingSubject[]> {
  const rs = await db.execute({
    sql: `SELECT c.subject_kind, c.subject_id, c.checks_json, c.passed, c.d FROM critique c
          WHERE c.d <= ?
            AND NOT EXISTS (SELECT 1 FROM critique x WHERE x.subject_kind = c.subject_kind
              AND x.subject_id = c.subject_id AND x.d <= ?
              AND (x.d > c.d OR (x.d = c.d AND x.run_id > c.run_id)))
            AND (c.d = ? OR NOT EXISTS (SELECT 1 FROM critique_note n
              WHERE n.subject_kind = c.subject_kind AND n.subject_id = c.subject_id))
          ORDER BY c.subject_kind, c.subject_id`,
    args: [d, d, d],
  });
  const out: WordingSubject[] = [];
  for (const r of rs.rows) {
    const kind = text(r.subject_kind) as "lesson" | "challenger";
    const id = text(r.subject_id);
    let grade: WordingSubject["grade"] = null;
    if (kind === "challenger") {
      const ch = await db.execute({
        sql: `SELECT 1 FROM challenger WHERE id = ? AND lineage_id LIKE ?
              AND state IN ('proposed','replay','shakedown','review','approved')`,
        args: [id, `${market}:%`],
      });
      if (ch.rows.length === 0) continue;
    } else {
      const g = await db.execute({
        sql: `SELECT g.grade FROM lesson_grade g JOIN lesson l ON l.id = g.lesson_id
              WHERE g.lesson_id = ? AND l.market = ? AND g.d <= ? ORDER BY g.seq DESC LIMIT 1`,
        args: [id, market, d],
      });
      const gr = g.rows.length === 0 ? null : text(g.rows[0]!.grade);
      if (gr !== "L1" && gr !== "L2" && gr !== "L3") continue;
      grade = gr;
    }
    out.push({
      evaluation: evaluationOf(kind, id, text(r.checks_json), Number(r.passed) === 1),
      grade,
      // the A6 text of a subject is a template (classifier `none`): no provider wrote it (LLM-010)
      author: null,
    });
  }
  return out;
}

// ---- the entry point ------------------------------------------------------------------------------------------------------

export async function wordsDay(db: Client, o: WordsOptions): Promise<WordsResult> {
  const key = wordsKey(o.market, o.d);
  if (await hasSuccess(db, key)) return result(o, "already_done", null, null);

  const market = await db.execute({
    sql: "SELECT mode FROM market WHERE code = ?",
    args: [o.market],
  });
  if (market.rows.length === 0) return recordSkip(db, o, "market_missing");
  const mode = text(market.rows[0]!.mode);
  if (mode === "off") return recordSkip(db, o, "market_off");
  if (mode !== "full" && o.replay !== true) return recordSkip(db, o, "data_only_guard");
  const calendar = o.calendar ?? (await loadCalendar(db, o.market));
  const trading = isTradingDay(o.d, calendar);

  const stale = await db.execute({
    sql: "SELECT 1 FROM run_record WHERE concurrency_key = ? AND status = 'running' LIMIT 1",
    args: [key],
  });
  if (stale.rows.length > 0) {
    await db.execute({
      sql: `UPDATE run_record SET status = 'failed', ended_at = ?, error_summary = ?
            WHERE concurrency_key = ? AND status = 'running'`,
      args: [o.now(), "superseded: the previous run did not finish", key],
    });
  }
  const runId = await startRun(db, {
    job: WORDS_JOB,
    market: o.market,
    concurrencyKey: key,
    scheduledFor: o.d,
    commitSha: o.commitSha ?? undefined,
    now: o.now(),
  });
  const stats = emptyStats();
  try {
    const params = o.params ?? (await loadAgentParams(db));
    const llm = o.llm({ params, kbVersion: await currentKbVersion(db, o.market) });
    const learnOk = await db.execute({
      sql: `SELECT 1 FROM run_record WHERE concurrency_key = ? AND status IN ('success', 'degraded') LIMIT 1`,
      args: [learnKey(o.market, o.d)],
    });
    if (learnOk.rows.length === 0) stats.partialReason = "learn_missing";

    const step = async (name: string, fn: () => Promise<void>): Promise<void> => {
      try {
        await fn();
      } catch (error) {
        stats.stepsFailed.push(name);
        await log(
          db,
          o,
          "error",
          `words on ${o.d}: step ${name} failed (${error instanceof Error ? error.name : "error"})`,
          runId,
        );
      }
    };

    // The R5 reservation is sized from the pack the narrative will be given (sections 4-6 facts).
    let reserve = 0;
    if (trading) {
      await step("reserve", async () => {
        const c = await loadCtx(db, {
          market: o.market,
          d: o.d,
          env: "production",
          appUrl: "",
          now: new Date(o.now()),
        });
        const req = narrativeRequest(o.market, await readNarrativePack(c), false);
        reserve = narrativeReserve(req);
        stats.reservedTokens = reserve;
      });
    }

    await step("concerns", async () => {
      const subjects = await subjectsToWord(db, o.market, o.d);
      stats.subjects = subjects.length;
      const report: WordingReport = await wordConcerns(db, {
        market: o.market,
        d: o.d,
        runId: key,
        params,
        subjects,
        providers: llm.providers,
        routerFor: (chain) =>
          reservingRouter(llm.routerFor(chain), {
            reserve,
            params,
            store: llm.store,
            onBlocked: () => {
              stats.reservedBlocks += 1;
            },
          }),
      });
      stats.worded = report.worded;
      stats.deferred = report.deferred;
      stats.llm010Degraded = report.log.length;
      for (const line of report.log) await log(db, o, "warn", line, runId);
    });

    if (trading) {
      await step("narrative", async () => {
        stats.narrative = await narrativeStage(
          db,
          { market: o.market, d: o.d, now: o.now },
          llm.r5Router,
        );
      });
    }

    const degraded = stats.partialReason !== null || stats.stepsFailed.length > 0;
    const status: WordsStatus = degraded ? "degraded" : "success";
    await finishRun(db, runId, {
      status,
      itemsProcessed: stats.worded + stats.deferred,
      rowsWritten: stats.worded * 2 + stats.deferred * 2 + (stats.narrative === null ? 0 : 1),
      details: { ...stats },
      now: o.now(),
    });
    return result(
      o,
      status,
      stats.stepsFailed.length > 0
        ? `step_failed:${stats.stepsFailed.join(",")}`
        : stats.partialReason,
      runId,
      stats,
    );
  } catch (error) {
    const code =
      error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : error instanceof Error
          ? error.name
          : "unknown_error";
    await finishRun(db, runId, {
      status: "failed",
      errorSummary: error instanceof Error ? `words/${code}: ${error.message}` : `words/${code}`,
      details: { code },
      now: o.now(),
    });
    await log(db, o, "error", `words failed on ${o.d}: ${code}`, runId);
    return result(o, "failed", `words/${code}`, runId, stats);
  }
}
