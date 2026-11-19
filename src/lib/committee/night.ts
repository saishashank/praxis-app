// Committee night stage (M22 C1; AGT-145, AGT-132, LLM-066, D-1417, D-1418, D-1419). Runs after the steelman and the
// reflections, from its own bundle (cli.ts). Per (market, d), only for the current session: shortlist the top new signals,
// then per signal build the evidence pack, run the bull, bear and risk statements and the judge, store every answered call
// (`committee_call`) and one rating row (`committee_rating`), and record the rating as an opinion (`opinion_track`, kind
// `committee`) for the lift meter. A signal the night could not rate still gets its `skipped_*` or `failed` row, so the trial
// sees every shortlisted signal. Nothing is written when the switch is off, the date is not today, a replay flag is set, or no
// pre-registration exists. It NEVER throws: every failure is a row or a status (the steelman pattern, D-484). The ratings are
// opinions: nothing here can reach an order, a rank, a pick, a rule, a breaker or an e-mail (PRD-033, AT-73).
import type { LlmParams } from "@/lib/agents/params";
import { allowance } from "@/lib/llm/budget";
import { requestReservation } from "@/lib/llm/router";
import { recordOpinion } from "@/lib/llm/textLabels";
import { buildPack, loadPackInput, type EvidencePack, type PackItem } from "@/lib/steelman/pack";
import { subjectLine } from "@/lib/steelman/night";
import { readPackForSubject } from "@/lib/steelman/store";
import type { Subject } from "@/lib/steelman/subjects";
import {
  debate,
  statementRequest,
  type CommitteeLlm,
  type Debate,
  type Point,
  type StageRecord,
} from "./debate";
import { judgeRequest, MAX_REASONS, runJudge } from "./judge";
import { shortlist, type ShortlistItem } from "./shortlist";
import {
  insertCall,
  insertRating,
  ratedSignalIds,
  readTrial,
  type Exec,
  type Rating,
  type RatingRow,
} from "./store";

/** Which of the two Committee roles the factory reports live (the night skips unless both are, D-1417). */
export type LiveRoles = { readonly R6: boolean; readonly R7: boolean };

export type CommitteeKeys = {
  /** committee_enabled */
  readonly enabled: boolean;
  /** committee_shortlist */
  readonly shortlist: number;
  /** evidence_pack_max_items */
  readonly maxItems: number;
  /** decision_cutoff (HH:MM, market time) */
  readonly decisionCutoff: string;
  /** committee_call_record_retention_months */
  readonly retentionMonths: number;
};

export type CommitteeNightOptions = {
  readonly market: string;
  /** The session the night rates. Must be `today`: the Committee is forward only (D-1417). */
  readonly d: string;
  /** The current session of the market. */
  readonly today: string;
  /** A replay or a recorded-day replay: refused. */
  readonly replay?: boolean;
  readonly llmParams: LlmParams;
  readonly keys: CommitteeKeys;
  readonly llm: CommitteeLlm;
  readonly live: LiveRoles;
  /** ISO UTC time stamped on every row written. */
  readonly now: string;
  readonly nowMs: () => number;
  /** The hard stop (epoch ms): a signal not started by then is `skipped_time`. */
  readonly deadlineMs: number;
};

export type CommitteeStatus =
  "done" | "off" | "refused_replay" | "refused_date" | "no_trial" | "trial_done" | "failed";

export type CommitteeNightResult = {
  status: CommitteeStatus;
  requested: number;
  /** Rated approve, neutral or reject. */
  rated: number;
  skippedBudget: number;
  skippedTime: number;
  skippedModels: number;
  failed: number;
  /** Signals that already had a row from an earlier run. */
  alreadyDone: number;
};

const empty = (status: CommitteeStatus): CommitteeNightResult => ({
  status,
  requested: 0,
  rated: 0,
  skippedBudget: 0,
  skippedTime: 0,
  skippedModels: 0,
  failed: 0,
  alreadyDone: 0,
});

/** The pack id of a row written without a pack (a signal skipped before one was built). */
export const NO_PACK = "none";
const REASONS_MAX_CHARS = 2000; // threshold-ok: committee_rating.reasons_json CHECK
const FILLER_CHARS = 400; // threshold-ok: one point's character bound (reservation sizing only)

const MONTH_PAD = 2;
const pad = (n: number): string => String(n).padStart(MONTH_PAD, "0");

/** `d` plus whole months, as a calendar date (the call-record expiry, D-1419). */
export function addMonths(d: string, months: number): string {
  const [y, m, day] = d.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1 + Math.max(0, Math.trunc(months)), day));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** The reasons as the stored JSON array: at most five, at most 2,000 characters (the last ones are dropped to fit). */
export function reasonsJson(reasons: readonly Point[]): string {
  const list = reasons.slice(0, MAX_REASONS).map((r) => ({ text: r.text, citations: r.citations }));
  while (list.length > 0 && JSON.stringify(list).length > REASONS_MAX_CHARS) list.pop();
  return JSON.stringify(list);
}

async function packFor(
  db: Exec,
  o: CommitteeNightOptions,
  item: ShortlistItem,
): Promise<EvidencePack> {
  const subject: Subject = {
    kind: "order",
    id: item.cardId ?? item.signalId,
    code: item.code,
    cardId: item.cardId,
    rankScore: item.rankScore,
  };
  // The steelman's pack for the same card, when it wrote one (a read; its table is never written here).
  if (item.cardId !== null) {
    const stored = await readPackForSubject(db, o.market, o.d, "order", item.cardId);
    if (stored !== null && stored.items.length > 0)
      return {
        packId: stored.packId,
        items: stored.items as PackItem[],
        cutoffAt: stored.cutoffAt,
      };
  }
  const input = await loadPackInput(db, subject, o.market, o.d, {
    maxItems: o.keys.maxItems,
    decisionCutoff: o.keys.decisionCutoff,
  });
  const head = { kind: "card" as const, text: subjectLine(subject) };
  return buildPack({ ...input, items: [head, ...input.items] });
}

/** Worst-case tokens of the four calls of one signal, for the single up-front check against the Committee bucket. */
function reservationOf(o: CommitteeNightOptions, item: ShortlistItem, pack: EvidencePack): number {
  const base = { market: o.market, d: o.d, code: item.code, pack };
  const bull = statementRequest("bull", base);
  const point = { text: "x".repeat(FILLER_CHARS), citations: pack.items.map((i) => i.id) };
  const four = Array.from({ length: 4 }, () => point); // threshold-ok: points a statement may carry
  const judge = judgeRequest({ ...base, statements: { bull: four, bear: four, risk: four } });
  return 3 * requestReservation(bull, bull.untrusted) + requestReservation(judge, judge.untrusted); // threshold-ok: three statements and the judge
}

/**
 * True when the four calls fit what is left of the Committee bucket, the daily total and the nightly cap (`allowance` takes
 * the strictest). The stages after the Committee in the drop order (steelman, reflections, Evening Review) run BEFORE it
 * in the night, so their spend is already in the usage and nothing is held back for them (D-1465).
 */
async function hasRoom(o: CommitteeNightOptions, reservation: number): Promise<boolean> {
  const usage = await o.llm.store.usage("committee", o.market, o.d);
  return reservation <= allowance(o.llmParams, "committee", o.market, true, usage).allowed;
}

type RowParts = {
  rating: Rating;
  packId: string;
  reasons?: readonly Point[];
  debate?: Debate;
  judgeModel?: string | null;
  timings?: Record<string, number>;
};

function ratingRow(
  o: CommitteeNightOptions,
  trialId: string,
  item: ShortlistItem,
  p: RowParts,
): RatingRow {
  const dbt = p.debate;
  return {
    market: o.market,
    d: o.d,
    signalId: item.signalId,
    trialId,
    packId: p.packId,
    rating: p.rating,
    reasonsJson: reasonsJson(p.reasons ?? []),
    bullModel: dbt?.models.bull ?? null,
    bearModel: dbt?.models.bear ?? null,
    riskModel: dbt?.models.risk ?? null,
    judgeModel: p.judgeModel ?? null,
    sameFamily: dbt?.sameFamily ?? false,
    timingsJson: JSON.stringify(p.timings ?? {}),
    createdAt: o.now,
  };
}

async function storeCalls(
  db: Exec,
  o: CommitteeNightOptions,
  item: ShortlistItem,
  packId: string,
  records: readonly StageRecord[],
): Promise<void> {
  const expiresD = addMonths(o.d, o.keys.retentionMonths);
  for (const r of records) {
    try {
      await insertCall(db, {
        id: r.callId,
        market: o.market,
        d: o.d,
        signalId: item.signalId,
        stage: r.stage,
        promptSha: r.promptSha,
        packId,
        provider: r.provider,
        modelId: r.model,
        modelVersion: r.modelVersion,
        paramsJson: r.paramsJson,
        rawResponse: r.raw,
        parsedJson: r.parsed,
        createdAt: o.now,
        expiresD,
      });
    } catch {
      // a missing call record never changes the rating; the router's own call log still has the row
    }
  }
}

/** Rates one signal and stores its rows. Returns the rating written, or null when the row could not be stored. */
async function rateOne(
  db: Exec,
  o: CommitteeNightOptions,
  trialId: string,
  item: ShortlistItem,
): Promise<Rating | null> {
  const timeUp = (): boolean => o.nowMs() >= o.deadlineMs;
  const write = async (p: RowParts): Promise<Rating | null> => {
    try {
      await insertRating(db, ratingRow(o, trialId, item, p));
      return p.rating;
    } catch {
      return null;
    }
  };
  if (timeUp()) return write({ rating: "skipped_time", packId: NO_PACK });
  if (!o.live.R6 || !o.live.R7) return write({ rating: "skipped_models", packId: NO_PACK });
  let pack: EvidencePack;
  try {
    pack = await packFor(db, o, item);
  } catch {
    return write({ rating: "failed", packId: NO_PACK });
  }
  try {
    if (!(await hasRoom(o, reservationOf(o, item, pack))))
      return write({ rating: "skipped_budget", packId: pack.packId });
  } catch {
    return write({ rating: "failed", packId: pack.packId });
  }
  const t0 = o.nowMs();
  const base = { market: o.market, d: o.d, code: item.code, pack };
  const dbt = await debate(o.llm, base, { timeUp, nowMs: o.nowMs });
  const records = [...dbt.records];
  const finish = async (
    p: Omit<RowParts, "packId" | "debate" | "timings">,
  ): Promise<Rating | null> => {
    await storeCalls(db, o, item, pack.packId, records);
    return write({
      ...p,
      packId: pack.packId,
      debate: dbt,
      timings: { ...dbt.timings, total: Math.max(0, o.nowMs() - t0) },
    });
  };
  if (dbt.statements === null || dbt.stop !== null) return finish({ rating: dbt.stop ?? "failed" });
  if (timeUp()) return finish({ rating: "skipped_time" });
  // The judge never uses the bear's model (D-1418): a router that avoids the bear's provider, else nothing is rated.
  const router = o.llm.routerFor("R7", { avoid: [dbt.providers.bear ?? ""] });
  if (router === null) return finish({ rating: "skipped_models" });
  const tj = o.nowMs();
  const j = await runJudge(
    router,
    o.llm.providers,
    { ...base, statements: dbt.statements },
    dbt.models.bear,
  );
  dbt.timings.judge = Math.max(0, o.nowMs() - tj);
  if (j.kind !== "ok") {
    const rating: Rating =
      j.kind === "budget"
        ? "skipped_budget"
        : j.kind === "no_model" || j.kind === "same_model"
          ? "skipped_models"
          : "failed";
    return finish({ rating });
  }
  records.push(j.record);
  const written = await finish({ rating: j.rating, reasons: j.reasons, judgeModel: j.model });
  if (written !== null) {
    try {
      await recordOpinion(db, {
        market: o.market,
        kind: "committee",
        code: item.code,
        d: o.d,
        value: { rating: j.rating },
      });
    } catch {
      // the rating stands; the lift meter then misses one opinion
    }
  }
  return written;
}

/** The Committee night. Never throws; see the file header for what is written and when. */
export async function committeeNight(
  db: Exec,
  o: CommitteeNightOptions,
): Promise<CommitteeNightResult> {
  try {
    if (o.replay === true) return empty("refused_replay");
    if (o.d !== o.today) return empty("refused_date"); // past, future or any other day: forward only (D-1417)
    if (!o.keys.enabled) return empty("off");
    const trial = await readTrial(db, o.market);
    if (trial === null) return empty("no_trial");
    if (trial.finished) return empty("trial_done");
    const res = empty("done");
    let list: ShortlistItem[];
    let done: Set<string>;
    try {
      list = await shortlist(db, o.market, o.d, o.keys.shortlist);
      done = await ratedSignalIds(db, o.market, o.d);
    } catch {
      return empty("failed");
    }
    res.requested = list.length;
    for (const item of list) {
      if (done.has(item.signalId)) {
        res.alreadyDone += 1;
        continue;
      }
      let rating: Rating | null = null;
      try {
        rating = await rateOne(db, o, trial.trialId, item);
      } catch {
        rating = null;
      }
      if (rating === null) res.failed += 1;
      else if (rating === "approve" || rating === "neutral" || rating === "reject") res.rated += 1;
      else if (rating === "skipped_budget") res.skippedBudget += 1;
      else if (rating === "skipped_time") res.skippedTime += 1;
      else if (rating === "skipped_models") res.skippedModels += 1;
      else res.failed += 1;
    }
    return res;
  } catch {
    return empty("failed");
  }
}
