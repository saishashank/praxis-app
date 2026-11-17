// The learner's part of the nightly stage (design C.1, C.5, B.4; D-927, D-928), run by
// `cortexLearnNight` right after the scorecard. Nothing runs (and nothing is read beyond one small
// map read) until a learner row is in force.
//
//   1. duel        the decisions of d-21 (the fixed book and its `#learn` twin, top pick each, from
//                  cortex_decision) are paired and their forward returns read from the daily loop's
//                  bars (no bar read), then written to cortex_learn_compare (insert-or-ignore);
//                  e-processes over the comparisons since the learner started and the matured
//                  hold-length outcomes; the duel line.
//   2. leader      the nightly evaluator may SWITCH to the learner only when compare.ts allows it;
//                  the Owner kill (`learner_off`) hands the decisions back at once. Effective from the
//                  next session (cortex_leader.since_d).
//   3. checkpoint  on a checkpoint night (every 2nd session, 3rd after an abstain-all night) the B.4
//                  checks; its events, a FALLBACK (protective, never a switch) and its caps / rollback
//                  as a new learner map row (generation tag "c" / "r"); a cap whose end comes is
//                  lifted the night before (tag "e"). Rows are fitted just after tonight's cut-off.
// Reads (C.10, LRN-AT-10): maps and learner history (tens of rows), d-21 decisions (<= 50), the
// comparisons and matured outcomes since the learner started (hundreds), the leaders, and on a
// checkpoint night the horizon-1 scorecard rows of the null window (<= 120 x angles, about 6,000).
import type { CalendarRow } from "@/lib/data/calendar";
import { addDays, nextTradingDay, sessionsBetween } from "@/lib/data/calendar";
import { angleById } from "../angles/registry";
import type { BatchExec } from "../store/common";
import {
  insertMapIgnore,
  isLearnerRow,
  latestMaps,
  learnerHistory,
  mapInForce,
  type MapRow,
} from "../store/maps";
import { checkpoint, checkpointEvents, isCheckpointNight } from "./checkpoint";
import { matureComparisons } from "./compare";
import type { LearnConfig } from "./config";
import { loadLearnConfig } from "./configStore";
import { duelPicks, duelStatus, evaluateLeader, forwardReturns, netDeltas } from "./duel";
import {
  baseWeightsOf,
  CAP_FIT_OFFSET_MS,
  embargoFittedAt,
  generationBefore,
  generationOf,
  LEARN_FAMILIES,
  learnerRuleVersion,
  learnerStartD,
  learnerWeightsOf,
  nightlyRow,
} from "./learner";
import {
  capLiftWords,
  duelWaitingWords,
  duelWords,
  ownerOffWords,
  switchWords,
} from "./learnWords";
import {
  angleDaysOfHorizon,
  compareRowsSince,
  filledOutcomesSince,
  insertCompareRows,
  insertLeader,
  leaderMap,
  logEvent,
  takenDecisions,
  type LearnEvent as StoredEvent,
} from "./store";
import type { LeaderRow, LearnEvent } from "./types";
import type { LearnerNightNumbers } from "./words";

/** Calendar days searched around tonight for the session list (cap expiry, start, windows). */
const BACK_DAYS = 400; // threshold-ok: covers the 250-night null window bound with holidays
const AHEAD_DAYS = 120; // threshold-ok: covers the 20-session cap and cool-down bounds ahead
const EVENTS_BACK = 10; // threshold-ok: design C.7 "events of the last 10 sessions"
const WEEK_DAYS = 7; // threshold-ok: calendar days searched before the learner's first fit
const ISO_DATE_LEN = 10; // threshold-ok: the date part of an ISO instant
/** First seq of the nightly learner events (0 is the scorecard). */
export const LEARNER_SEQ = 1;

export type LearnerNightOpts = {
  readonly market: string;
  readonly d: string;
  readonly calendar: readonly CalendarRow[];
  /** D-1 and the 20-session decision night D-21. */
  readonly prev: string;
  readonly back20: string;
  readonly regimeBack20: string;
  /** The daily loop's closes of the liquid shares up to d. */
  readonly bars: ReadonlyMap<string, readonly { readonly d: string; readonly c: number }[]>;
  /** cortex_learn_event rows of the prior 60 sessions (the scorecard's read). */
  readonly priorEvents: readonly StoredEvent[];
  /** Tonight had no stored features (abstain-all). */
  readonly abstainTonight: boolean;
  readonly now: string;
  readonly cutoffHhmm?: string;
  readonly config?: LearnConfig;
};

export type LearnerNightResult = {
  readonly lines: readonly string[];
  readonly numbers: LearnerNightNumbers;
  readonly learner: MapRow;
  readonly config: LearnConfig;
};

const typedEvent = (e: StoredEvent): LearnEvent => ({
  market: e.market,
  d: e.d,
  seq: e.seq,
  kind: e.kind,
  family: e.family ?? null,
  angleId: e.angleId ?? null,
  generation: e.generation ?? null,
  evidence:
    typeof e.evidence === "object" && e.evidence !== null
      ? (e.evidence as Record<string, unknown>)
      : {},
  words: e.words,
  reversesSeq: e.reversesSeq ?? null,
  expiresD: e.expiresD ?? null,
});

/** The learner rows in force on night d (one map read); empty = no learner yet. */
export async function learnersInForce(
  db: BatchExec,
  market: string,
  d: string,
  cutoffHhmm?: string,
): Promise<MapRow[]> {
  const families = new Set<string>(LEARN_FAMILIES);
  return (await latestMaps(db, market, d, cutoffHhmm)).filter(
    (m) =>
      isLearnerRow(m) && families.has(m.family) && m.ruleVersion === learnerRuleVersion(m.family),
  );
}

/** The learner's night for its (single, v1) family; null when no learner is in force. */
export async function learnerNight(
  db: BatchExec,
  o: LearnerNightOpts,
): Promise<LearnerNightResult | null> {
  const learner = (await learnersInForce(db, o.market, o.d, o.cutoffHhmm))[0];
  if (learner === undefined) return null;
  const config = o.config ?? (await loadLearnConfig(db));
  const family = learner.family;
  const rv = learner.ruleVersion;
  const history = await learnerHistory(db, o.market);
  // from the learner's first fit (or the null window, whichever is earlier) to past the cap bounds
  const firstFit = history
    .reduce((m, h) => (h.fittedAt < m ? h.fittedAt : m), o.d)
    .slice(0, ISO_DATE_LEN);
  const back = addDays(o.d, -BACK_DAYS);
  const sessions = sessionsBetween(
    firstFit < back ? addDays(firstFit, -WEEK_DAYS) : back,
    addDays(o.d, AHEAD_DAYS),
    o.calendar,
  );
  const nextSession = nextTradingDay(o.d, o.calendar);
  const lines: string[] = [];
  let seq = LEARNER_SEQ;
  const log = async (e: Omit<StoredEvent, "market" | "d" | "seq" | "createdAt">) => {
    await logEvent(db, { ...e, market: o.market, d: o.d, seq, createdAt: o.now });
    seq += 1;
  };

  // 1. the duel: mature the decisions of d-21
  let compareMatured = 0;
  const atDecision = mapInForce(history, family, rv, o.back20, o.cutoffHhmm);
  if (atDecision !== undefined) {
    const rows = await takenDecisions(db, o.market, o.back20, [family]);
    const picks = duelPicks({
      decisionD: o.back20,
      rows,
      learners: new Map([[family, { ruleVersion: rv, generation: generationOf(atDecision) }]]),
      regime: o.regimeBack20,
    });
    const codes = picks.flatMap((p) => [p.fixedCode, p.learnerCode]).filter((c) => c !== null);
    const forward = forwardReturns({
      codes: codes as string[],
      decisionD: o.back20,
      end20: o.prev,
      bars: o.bars,
    });
    const cmp = matureComparisons({ market: o.market, maturedD: o.d, picks, forward });
    await insertCompareRows(db, cmp);
    compareMatured = cmp.length;
  }
  const startD = learnerStartD(history, learner, sessions, o.cutoffHhmm) ?? o.d;
  const compareRows = (await compareRowsSince(db, o.market, startD, o.d)).filter(
    (r) => r.family === family && r.learnerRuleVersion === rv,
  );
  const net = netDeltas(await filledOutcomesSince(db, o.market, startD, [family]), rv);
  const p = learner.params as unknown as Record<string, unknown>;
  const hold = typeof p.hold === "number" && Number.isFinite(p.hold) ? p.hold : null;
  const status = duelStatus({ compareRows, net: net.deltas, hold, config });
  lines.push(
    status.nights === 0
      ? duelWaitingWords(family)
      : duelWords({
          agree: status.agree,
          nights: status.nights,
          mean: status.mean20,
          e: status.mean20 >= 0 ? status.eBetter20 : status.eWorse20,
          matured: status.matured,
          needed: config.switchMinNights,
        }),
  );

  // 2. the leader: the nightly evaluator (switch) and the Owner kill
  const leaders = await leaderMap(db, o.market, o.d);
  const lead = leaders.get(family);
  const leader = lead?.leader ?? "fixed";
  const sinceLastChange =
    lead === undefined
      ? null
      : Math.max(0, sessionsBetween(lead.sinceD, o.d, o.calendar).length - 1);
  let leaderChange: LearnerNightNumbers["leaderChange"] = null;
  const leaderRow = (to: "fixed" | "learner", setBy: LeaderRow["setBy"], evidence: object) =>
    insertLeader(db, {
      market: o.market,
      family,
      sinceD: nextSession,
      leader: to,
      learnerRuleVersion: rv,
      learnerGeneration: generationOf(learner),
      evidence,
      setBy,
    });
  if (leader === "learner" && config.learnerOff === 1) {
    await leaderRow("fixed", "owner_kill", { reason: "learner_off" });
    await log({
      kind: "fallback",
      family,
      generation: generationOf(learner),
      evidence: { reason: "owner_off", since: nextSession },
      words: ownerOffWords(family),
    });
    lines.push(ownerOffWords(family));
    leaderChange = "owner_kill";
  } else if (leader === "fixed") {
    const call = evaluateLeader({ status, leader, sinceLastChange, config });
    if (call === "switch") {
      const e = status.primary === "net" ? status.eBetterNet : status.eBetter20;
      const n = status.primary === "net" ? status.matured : status.differ20;
      await leaderRow("learner", "evaluator", { ...status });
      await log({
        kind: "switch",
        family,
        generation: generationOf(learner),
        evidence: { ...status, since: nextSession },
        words: switchWords(family, e, n),
      });
      lines.push(switchWords(family, e, n));
      leaderChange = "switch";
    }
  }

  // 3. the checkpoint, and the learner's row of tonight (caps, rollback, lifted caps)
  const prevCard = o.priorEvents.find((e) => e.kind === "scorecard" && e.d === o.prev);
  const abstainLastNight =
    prevCard !== undefined && (prevCard.evidence as { rows?: unknown } | null)?.rows === 0;
  const isCp = isCheckpointNight({
    startD,
    d: o.d,
    calendar: sessions,
    abstainTonight: o.abstainTonight,
    abstainLastNight,
  });
  const actions: string[] = [];
  let decisions: ReturnType<typeof checkpoint> = [];
  if (isCp) {
    const i = sessions.indexOf(o.d);
    const from = sessions[Math.max(0, i - config.nullSessions + 1)] ?? o.d;
    const angleDays = await angleDaysOfHorizon(db, o.market, 1, from, o.d);
    const tenBack = sessions[Math.max(0, i - EVENTS_BACK)] ?? o.d;
    const weights = learnerWeightsOf(learner);
    const angles: Record<string, { name: string }> = {};
    for (const id of Object.keys(weights.angle).sort()) {
      angles[id] = { name: angleById(id)?.title ?? "" };
    }
    decisions = checkpoint({
      market: o.market,
      d: o.d,
      calendar: sessions,
      angleDays120: angleDays,
      angles,
      weights,
      events10: o.priorEvents.filter((e) => e.d >= tenBack).map(typedEvent),
      compareRows,
      netDeltas: { [family]: net.deltas },
      leaders: [...leaders.values()].map((l) => ({
        ...l,
        evidence: (l.evidence ?? {}) as Record<string, unknown>,
      })),
      config,
    }).filter((x) => !(x.kind === "fallback" && leaderChange === "owner_kill"));
    for (const ev of checkpointEvents(o.market, o.d, decisions, seq)) {
      await logEvent(db, { ...ev, createdAt: o.now });
      seq += 1;
      actions.push(ev.kind);
    }
    for (const x of decisions) {
      lines.push(x.words);
      if (x.kind !== "fallback" || x.family !== family) continue;
      const kill = x.reason === "owner_off";
      await leaderRow("fixed", kill ? "owner_kill" : "fallback", {
        ...x.evidence,
        again: x.expiresD,
      });
      leaderChange = kill ? "owner_kill" : "fallback";
    }
  }
  const rollback = decisions.find((x) => x.kind === "rollback" && x.generation !== null);
  const prior =
    rollback === undefined ? undefined : generationBefore(history, rv, rollback.generation!);
  const night = nightlyRow(learner, {
    nextSession,
    decisions,
    ...(prior === undefined ? {} : { before: baseWeightsOf(prior) }),
    fittedAt: embargoFittedAt(o.d, CAP_FIT_OFFSET_MS, o.cutoffHhmm),
  });
  if (night !== null) {
    await insertMapIgnore(db, night.row);
    if (night.lifted.length > 0) {
      lines.push(capLiftWords(night.lifted.map((id) => angleById(id)?.title ?? "")));
    }
  }

  return {
    lines,
    learner,
    config,
    numbers: {
      family,
      generation: generationOf(learner),
      leader,
      compareMatured,
      duelNights: status.nights,
      duelAgree: status.agree,
      eBetter20: status.eBetter20,
      eWorse20: status.eWorse20,
      matured: status.matured,
      checkpoint: isCp,
      actions,
      mapRowWritten: night !== null,
      leaderChange,
    },
  };
}
