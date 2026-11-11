// The learning Cortex's weekly stage "cortex" (design C.1, C.7, C.13 step 4; D-923, D-928, D-931),
// registered last in the weekly learning run (src/lib/learning/weeklyRun.ts LEARNING_STAGES).
//
//   First run (no learner row for F1 yet, or the fixed rule it was based on was replaced): writes
//   generation 0 of `F1.learn` — the fixed rule's own map with equal weights — so the `#learn` shadow
//   rows start from the next session.
//   Later runs: reads the week's window of `cortex_angle_day` (one date-range read, no OFFSET), the
//   development priors from the passports, the checkpoint's fall alarms since the last weekly run, and
//   calls `reweight` and its coin-flip twin `placebo` (scopes `reweightScope` / `placeboScope`). A new
//   map row (generation g + 1) is written only when the weights changed (or the Owner edited a C.9 key,
//   which starts a new generation, D-940); a 'reweight' or 'no_change' event and a 'placebo' event are
//   logged either way. Every new generation is charged to the trial ledger first (kind challenger,
//   rule version `cortex:F1.learn@g`, LRN-AT-12).
//   One-session embargo: the row is fitted just after the cut-off of the week's last session, so it is
//   first in force on the next session; the run date never enters a statistic.
// Then the `baseWeekly` hook (hooks.ts). Deterministic: the same stored rows give the same row bytes;
// a re-run of the week writes nothing new (insert-or-ignore).
import type { Client } from "@libsql/client";
import type { StageOutput } from "@/lib/learning/weeklyRun";
import { ANGLES, angleById, ruleScoredSet } from "../angles/registry";
import type { AngleStatus } from "../angles/types";
import { newestPerFamily } from "../stage";
import { chargeCortexTrial } from "../store/keyEdit";
import { insertMapIgnore, isLearnerRow, latestMaps, type MapRow } from "../store/maps";
import { latestPassports, type PassportRow } from "../store/passports";
import type { CalendarRow } from "@/lib/data/calendar";
import { isTradingDay, previousTradingDay } from "@/lib/data/calendar";
import { scopedPrng } from "@/lib/stats/rng";
import { isoWeek } from "@/lib/view/format";
import type { LearnConfig } from "./config";
import { loadLearnConfig } from "./configStore";
import { CORTEX_LEARN_HOOKS, HOOK_SEQ_BASE, type CortexLearnHooks } from "./hooks";
import {
  baseWeightsOf,
  basedOnOf,
  configHash,
  embargoFittedAt,
  generationOf,
  generationZero,
  LEARN_FAMILIES,
  learnerRuleVersion,
  nextGeneration,
  WEEKLY_FIT_OFFSET_MS,
} from "./learner";
import { reweightWords, startWords } from "./learnWords";
import {
  placebo,
  placeboScope,
  reweight,
  reweightScope,
  weeklyWords,
  withinChance,
  type DevPrior,
} from "./reweight";
import { angleDaysOfHorizon, eventsSince, lastEventD, logEvent } from "./store";

/** Seqs of the weekly events on the week's last session (the nightly stage uses 0..99). */
export const WEEKLY_SEQ = 100; // threshold-ok: event seq layout (hooks.ts header)
export const PLACEBO_SEQ = 101; // threshold-ok: event seq layout (hooks.ts header)
const H20 = 20; // threshold-ok: the 20-session rows the reweight reads (C.6)
const DEV_IC_KEYS = ["dev_ic", "rank_ic", "ic20", "ic"] as const;

export { LEARN_FAMILIES };

export type CortexWeeklyResult = {
  readonly family: string;
  readonly action: "no_fixed_rule" | "generation_zero" | "reweight" | "no_change";
  readonly generation: number | null;
  readonly lastSession: string;
  readonly words: readonly string[];
  readonly charged: boolean;
  readonly maxMove: number | null;
  readonly placeboMove: number | null;
};

/** The development IC an angle's passport recorded (first numeric of DEV_IC_KEYS); 0 when none. */
export function devIcOf(evidence: unknown): number {
  if (typeof evidence !== "object" || evidence === null) return 0;
  const e = evidence as Record<string, unknown>;
  for (const k of DEV_IC_KEYS) {
    const v = e[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return 0;
}

/** PURE: the learner's development priors over its angle ids (passport IC, registry cluster and name). */
export function devPriorOf(ids: readonly string[], passports: readonly PassportRow[]): DevPrior {
  const by = new Map(passports.map((p) => [p.angleId, p]));
  const out: Record<string, DevPrior[string]> = {};
  for (const id of [...ids].sort()) {
    const p = by.get(id);
    const def = angleById(id);
    out[id] = {
      devIc: devIcOf(p?.evidence),
      cluster: String(def?.cluster ?? p?.cluster ?? "other"),
      name: def?.title ?? "",
    };
  }
  return out;
}

/** PURE: the angle ids a learner of `fixed` weighs (its own scored set, D-889). */
export function learnerAngleIds(fixed: MapRow, passports: readonly PassportRow[]): string[] {
  const status = new Map<string, AngleStatus>(passports.map((p) => [p.angleId, p.status]));
  const p = fixed.params as unknown as Record<string, unknown>;
  const listed =
    Array.isArray(p.angles) && p.angles.every((a) => typeof a === "string")
      ? (p.angles as string[])
      : undefined;
  return ruleScoredSet(ANGLES, (id) => status.get(id) ?? "candidate", listed).map((a) => a.id);
}

const sessionsBack = (d: string, n: number, calendar: readonly CalendarRow[]): string => {
  let t = d;
  for (let i = 0; i < n; i += 1) t = previousTradingDay(t, calendar);
  return t;
};

export type CortexWeeklyOpts = {
  readonly market: string;
  /** The run date (Saturday in production). */
  readonly d: string;
  readonly calendar: readonly CalendarRow[];
  /** created_at of the events. */
  readonly now: string;
  readonly cutoffHhmm?: string;
  readonly config?: LearnConfig;
  readonly hooks?: CortexLearnHooks;
};

/** The weekly stage for one market; see the header. */
export async function cortexLearnWeekly(
  db: Client,
  o: CortexWeeklyOpts,
): Promise<CortexWeeklyResult[]> {
  const lastSession = isTradingDay(o.d, o.calendar) ? o.d : previousTradingDay(o.d, o.calendar);
  const config = o.config ?? (await loadLearnConfig(db));
  const cHash = configHash(config);
  const week = isoWeek(lastSession) ?? lastSession;
  const fittedAt = embargoFittedAt(lastSession, WEEKLY_FIT_OFFSET_MS, o.cutoffHhmm);
  const maps = await latestMaps(db, o.market, lastSession, o.cutoffHhmm);
  const fixedOf = newestPerFamily(maps);
  const passports = await latestPassports(db, o.market);
  const out: CortexWeeklyResult[] = [];
  for (const family of LEARN_FAMILIES) {
    const rv = learnerRuleVersion(family);
    const fixed = fixedOf.get(family);
    const learner = maps.find(
      (m) => m.family === family && m.ruleVersion === rv && isLearnerRow(m),
    );
    const base = {
      family,
      lastSession,
      maxMove: null,
      placeboMove: null,
    };
    if (fixed === undefined) {
      out.push({ ...base, action: "no_fixed_rule", generation: null, words: [], charged: false });
      continue;
    }
    // first run, or the Owner replaced the fixed rule the learner was based on: a fresh start
    if (learner === undefined || basedOnOf(learner) !== fixed.ruleVersion) {
      const g = learner === undefined ? 0 : generationOf(learner) + 1;
      const row = generationZero(fixed, learnerAngleIds(fixed, passports), {
        fittedAt,
        configHash: cHash,
        generation: g,
      });
      const charged = await chargeCortexTrial(db, {
        market: o.market,
        family,
        ruleVersion: `cortex:${rv}@${g}`,
        variant: `generation:${g}`,
        id: `cortex-learn:${o.market}:${rv}:${g}`,
        d: lastSession,
      });
      await insertMapIgnore(db, row);
      const words = [startWords(family)];
      await logEvent(db, {
        market: o.market,
        d: lastSession,
        seq: WEEKLY_SEQ,
        kind: "reweight",
        family,
        generation: g,
        evidence: {
          generation: g,
          start: true,
          basedOn: fixed.ruleVersion,
          angles: Object.keys(
            (row.params as unknown as { weights: { angle: object } }).weights.angle,
          ).length,
          raisedMost: null,
          charged,
        },
        words: words[0]!,
        createdAt: o.now,
      });
      out.push({ ...base, action: "generation_zero", generation: g, words, charged });
      continue;
    }
    // a later run: the weekly re-weighting
    const from = sessionsBack(lastSession, config.windowSessions - 1, o.calendar);
    const rows = await angleDaysOfHorizon(db, o.market, H20, from, lastSession);
    const current = baseWeightsOf(learner);
    const ids = Object.keys(current.angle).sort();
    const devPrior = devPriorOf(ids, passports);
    const since = await lastEventD(db, o.market, ["reweight", "no_change"], lastSession);
    const alarmEvents = since === null ? [] : await eventsSince(db, o.market, since, lastSession);
    const fallAlarms = [
      ...new Set(
        alarmEvents
          .filter(
            (e) =>
              (e.kind === "cap" || e.kind === "watch" || e.kind === "rollback") &&
              e.angleId !== null &&
              e.angleId !== undefined &&
              e.d > since!,
          )
          .map((e) => e.angleId as string),
      ),
    ].sort();
    const input = { angleDays60: rows, devPrior, current, config, fallAlarms };
    const real = reweight({ ...input, prng: scopedPrng(reweightScope(o.market, week)) });
    const twin = placebo({ ...input, prng: scopedPrng(placeboScope(o.market, week)) });
    const g = generationOf(learner);
    const configChanged =
      (learner.params as unknown as Record<string, unknown>).config_hash !== cHash;
    const write = real.changed || configChanged;
    const words = [
      real.changed
        ? weeklyWords(real, twin, devPrior, config)
        : reweightWords({
            changed: false,
            up: [],
            down: [],
            maxStep: config.maxStep,
            realMove: 0,
            placeboMove: twin.maxMove,
          }),
    ];
    let charged = false;
    if (write) {
      charged = await chargeCortexTrial(db, {
        market: o.market,
        family,
        ruleVersion: `cortex:${rv}@${g + 1}`,
        variant: `generation:${g + 1}`,
        id: `cortex-learn:${o.market}:${rv}:${g + 1}`,
        d: lastSession,
      });
      const evidence: Record<string, unknown> = {};
      for (const [id, e] of Object.entries(real.evidence)) {
        evidence[id] = { ic20: e.ic20, lo90: e.lo90, shrunk: e.shrunk, nights: e.nights };
      }
      await insertMapIgnore(
        db,
        nextGeneration(learner, real.weights, {
          fittedAt,
          configHash: cHash,
          window: { from, to: lastSession, sessions: config.windowSessions },
          evidence,
          words,
        }),
      );
    }
    await logEvent(db, {
      market: o.market,
      d: lastSession,
      seq: WEEKLY_SEQ,
      kind: write ? "reweight" : "no_change",
      family,
      generation: write ? g + 1 : g,
      evidence: {
        generation: write ? g + 1 : g,
        raisedMost: real.raisedMost,
        loweredMost: real.loweredMost,
        maxMove: real.maxMove,
        weightsHash: real.weightsHash,
        configChanged,
        fallAlarms,
        rows: rows.length,
        window: { from, to: lastSession },
        charged,
      },
      words: words[0]!,
      createdAt: o.now,
    });
    await logEvent(db, {
      market: o.market,
      d: lastSession,
      seq: PLACEBO_SEQ,
      kind: "placebo",
      family,
      generation: write ? g + 1 : g,
      evidence: {
        maxMove: twin.maxMove,
        realMove: real.maxMove,
        withinChance: withinChance(real, twin),
        scope: placeboScope(o.market, week),
      },
      words: words[0]!,
      createdAt: o.now,
    });
    out.push({
      ...base,
      action: write ? "reweight" : "no_change",
      generation: write ? g + 1 : g,
      words,
      charged,
      maxMove: real.maxMove,
      placeboMove: twin.maxMove,
    });
  }
  // the probe / base builder's weekly step (hooks.ts), never fatal to the re-weighting
  const hooks = o.hooks ?? CORTEX_LEARN_HOOKS;
  if (hooks.baseWeekly !== undefined) {
    try {
      const after = await latestMaps(db, o.market);
      const fixed = newestPerFamily(after).get("F1") ?? null;
      const learner =
        after.find((m) => m.ruleVersion === learnerRuleVersion("F1") && isLearnerRow(m)) ?? null;
      await hooks.baseWeekly(db, {
        market: o.market,
        d: o.d,
        lastSession,
        calendar: o.calendar,
        fixed,
        learner,
        config,
        seqBase: HOOK_SEQ_BASE,
        now: o.now,
      });
    } catch {
      // recorded by the caller's stage output as a missing hook result; the stage itself succeeded
    }
  }
  return out;
}

/** The weekly learning run's stage "cortex" (weeklyRun.ts LEARNING_STAGES, last). */
export async function cortexWeeklyStage(ctx: {
  readonly db: Client;
  readonly market: string;
  readonly d: string;
  readonly calendar: readonly CalendarRow[];
  readonly params?: { readonly decisionCutoff?: string };
}): Promise<StageOutput> {
  const results = await cortexLearnWeekly(ctx.db, {
    market: ctx.market,
    d: ctx.d,
    calendar: ctx.calendar,
    now: new Date().toISOString(), // created_at only; never part of a statistic
    ...(ctx.params?.decisionCutoff === undefined ? {} : { cutoffHhmm: ctx.params.decisionCutoff }),
  });
  return {
    stats: results.map((r) => ({
      scope: ctx.market,
      metric: `cortex_learn:${r.family}`,
      value: {
        action: r.action,
        generation: r.generation,
        last_session: r.lastSession,
        charged: r.charged,
        max_move: r.maxMove,
        placebo_move: r.placeboMove,
      },
    })),
  };
}
