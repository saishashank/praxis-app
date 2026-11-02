// Steelman night stage (M11-lite WP4; AGT-133, PRD-029; D-481..D-485, D-488, D-492, D-493). Runs after
// the picks batch, from its own bundle (cli.ts). Per (market, d): settle due opinions (read-after), expire
// old suggestions, pick the night's subjects (orders by rank score, then picks, at most
// `steelman_daily_cards`), write each one, store the night row, list suggestions. Idempotent through the
// insert-once `steelman_night` row and the append-only pack and point rows. It NEVER throws: every
// failure becomes a not_written outcome with a reason, counted on the night row (D-484).
import type { LlmParams } from "@/lib/agents/params";
import type { CalendarRow } from "@/lib/data/calendar";
import type { LlmProvider } from "@/lib/llm/providers";
import type { LlmRouter } from "@/lib/llm/router";
import type { LlmStore } from "@/lib/llm/store";
import { recordOpinion } from "@/lib/llm/textLabels";
import { opinionValue, settleDue } from "./opinion";
import { buildPack, loadPackInput, type EvidencePack, type PackItem } from "./pack";
import {
  insertNight,
  readNight,
  readPackForSubject,
  readPoints,
  type Exec,
  type NightRow,
} from "./store";
import { createSuggestions, expireSuggestions } from "./suggestions";
import { nightSubjects, type Subject } from "./subjects";
import { writeSteelman, type NotWrittenReason, type WriteOutcome } from "./write";

/** The model side of the night: routers and the store they spend against. Rules-only until the bake-off (D-480). */
export type SteelmanLlm = {
  readonly authorRouter: LlmRouter;
  readonly criticRouterFor: (author: { provider: string; model: string }) => LlmRouter | null;
  readonly providers: readonly LlmProvider[];
  readonly store: LlmStore;
};

export type SteelmanKeys = {
  /** steelman_daily_cards */
  readonly dailyCards: number;
  /** evidence_pack_max_items */
  readonly maxItems: number;
  /** steelman_suggestion_expiry_sessions */
  readonly expirySessions: number;
  /** decision_cutoff (HH:MM, market time) */
  readonly decisionCutoff: string;
};

export type NightOptions = {
  readonly market: string;
  readonly d: string;
  readonly llmParams: LlmParams;
  readonly keys: SteelmanKeys;
  readonly llm: SteelmanLlm;
  readonly calendar: readonly CalendarRow[];
  /** ISO UTC time stamped on every row written. */
  readonly now: string;
};

export type NightResult = {
  /** done = written now; already_done = the night row existed; failed = the night row could not be stored. */
  status: "done" | "already_done" | "failed";
  requested: number;
  written: number;
  notWritten: Record<"limit" | "budget" | "noModel" | "critic", number>;
  claimsTotal: number;
  claimsValid: number;
  validityPpm: number;
  criticHidden: number;
  settled: number;
  expired: number;
  suggestions: number;
};

const PPM = 1_000_000; // threshold-ok: unit, parts per million

const empty = (status: NightResult["status"]): NightResult => ({
  status,
  requested: 0,
  written: 0,
  notWritten: { limit: 0, budget: 0, noModel: 0, critic: 0 },
  claimsTotal: 0,
  claimsValid: 0,
  validityPpm: 0,
  criticHidden: 0,
  settled: 0,
  expired: 0,
  suggestions: 0,
});

const bucket = (r: NotWrittenReason): keyof NightResult["notWritten"] => {
  switch (r) {
    case "daily_limit":
      return "limit";
    case "budget":
      return "budget";
    case "no_model":
    case "error":
      return "noModel";
    default:
      return "critic"; // critic_unavailable, rejected: did not pass review (D-503)
  }
};

const fromRow = (r: NightRow): NightResult => ({
  status: "already_done",
  requested: r.requested,
  written: r.written,
  notWritten: {
    limit: r.notWrittenLimit,
    budget: r.notWrittenBudget,
    noModel: r.notWrittenNoModel,
    critic: r.notWrittenCritic,
  },
  claimsTotal: r.claimsTotal,
  claimsValid: r.claimsValid,
  validityPpm: r.validityPpm,
  criticHidden: r.criticHidden,
  settled: 0,
  expired: 0,
  suggestions: 0,
});

/** The outcome of a subject already written by an earlier run (its points are on file). */
function outcomeFromPoints(
  points: readonly { state: string }[],
): Extract<WriteOutcome, { state: "written" }> | null {
  const shown = points.filter((p) => p.state === "shown").length;
  const hidden = points.filter((p) => p.state === "hidden_critic").length;
  if (shown === 0) return null;
  return {
    state: "written",
    shown,
    hidden,
    claims: { total: points.length, valid: shown + hidden },
  };
}

async function subjectPack(
  db: Exec,
  o: NightOptions,
  subject: Subject,
): Promise<{ pack: EvidencePack; points: Awaited<ReturnType<typeof readPoints>> }> {
  const stored = await readPackForSubject(db, o.market, o.d, subject.kind, subject.id);
  if (stored !== null) {
    return {
      pack: { packId: stored.packId, items: stored.items as PackItem[], cutoffAt: stored.cutoffAt },
      points: await readPoints(db, stored.packId),
    };
  }
  const input = await loadPackInput(db, subject, o.market, o.d, {
    maxItems: o.keys.maxItems,
    decisionCutoff: o.keys.decisionCutoff,
  });
  // The subject line comes first so two subjects with the same evidence still get different packs
  // (pack_id is the hash of the items, and the card thesis is a fixed per-family line). It names the
  // subject itself, not only the code: two profiles may pick one code on the same night (D-506).
  const head = { kind: "card" as const, text: subjectLine(subject) };
  return { pack: buildPack({ ...input, items: [head, ...input.items] }), points: [] };
}

/** The first pack item: "Subject order ZZA, card <id>" or "Subject pick ZZA, profile <p>, rank <n>". */
export function subjectLine(subject: Subject): string {
  if (subject.kind === "pick" && subject.pickKey)
    return `Subject pick ${subject.code}, profile ${subject.pickKey.profile}, rank ${subject.pickKey.rank}`;
  return `Subject ${subject.kind} ${subject.code}, card ${subject.cardId ?? subject.id}`;
}

export async function steelmanNight(db: Exec, o: NightOptions): Promise<NightResult> {
  try {
    const done = await readNight(db, o.market, o.d);
    if (done !== null) return fromRow(done);
  } catch {
    return empty("failed");
  }
  const res = empty("done");
  try {
    res.settled = await settleDue(db, o.market, o.d);
  } catch {
    // read-after settlement is retried every night
  }
  try {
    res.expired = await expireSuggestions(
      db,
      o.market,
      o.d,
      o.calendar,
      o.keys.expirySessions,
      o.now,
    );
  } catch {
    // retried every night
  }
  let subjects: Subject[] = [];
  try {
    subjects = await nightSubjects(db, o.market, o.d, Number.MAX_SAFE_INTEGER);
  } catch {
    return { ...res, status: "failed" };
  }
  res.requested = subjects.length;
  const cap = Math.max(0, Math.trunc(o.keys.dailyCards));
  res.notWritten.limit = Math.max(0, subjects.length - cap);
  let hidden = 0;
  for (const subject of subjects.slice(0, cap)) {
    let outcome: WriteOutcome;
    let packId: string | null = null;
    try {
      const { pack, points } = await subjectPack(db, o, subject);
      packId = pack.packId;
      const prior = outcomeFromPoints(points);
      if (prior !== null) {
        // A run that stopped between the points and the opinion row (D-507): the insert is idempotent
        // (same value, same id), so a subject written tonight gets its opinion at most once.
        try {
          await recordOpinion(db, {
            market: o.market,
            kind: "steelman",
            code: subject.code,
            d: o.d,
            value: opinionValue(points.filter((p) => p.state === "shown")),
          });
        } catch {
          // the points stand; the opinion is tried again on the next resume
        }
      }
      const failedBefore: WriteOutcome = {
        state: "not_written",
        reason: "rejected",
        claims: { total: points.length, valid: 0 },
      };
      outcome =
        prior ??
        (points.length > 0
          ? failedBefore
          : await writeSteelman(
              {
                db,
                market: o.market,
                d: o.d,
                params: o.llmParams,
                now: o.now,
                authorRouter: o.llm.authorRouter,
                criticRouterFor: o.llm.criticRouterFor,
                providers: o.llm.providers,
                store: o.llm.store,
              },
              subject,
              pack,
            ));
    } catch {
      outcome = { state: "not_written", reason: "error", claims: { total: 0, valid: 0 } };
    }
    res.claimsTotal += outcome.claims.total;
    res.claimsValid += outcome.claims.valid;
    if (outcome.state === "written") {
      res.written += 1;
      hidden += outcome.hidden;
      if (packId !== null) {
        try {
          res.suggestions += await createSuggestions(db, {
            market: o.market,
            d: o.d,
            subject,
            packId,
            now: o.now,
          });
        } catch {
          // a missing suggestion never undoes a written steelman
        }
      }
    } else {
      res.notWritten[bucket(outcome.reason)] += 1;
    }
  }
  res.criticHidden = hidden;
  res.validityPpm =
    res.claimsTotal === 0 ? 0 : Math.floor((res.claimsValid * PPM) / res.claimsTotal);
  try {
    await insertNight(db, {
      market: o.market,
      d: o.d,
      requested: res.requested,
      written: res.written,
      notWrittenLimit: res.notWritten.limit,
      notWrittenBudget: res.notWritten.budget,
      notWrittenNoModel: res.notWritten.noModel,
      notWrittenCritic: res.notWritten.critic,
      claimsTotal: res.claimsTotal,
      claimsValid: res.claimsValid,
      validityPpm: res.validityPpm,
      criticHidden: res.criticHidden,
      createdAt: o.now,
    });
  } catch {
    res.status = "failed";
  }
  return res;
}
