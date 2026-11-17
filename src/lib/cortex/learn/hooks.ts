// Plug-in points of the learning loop for the candidate measures ("probes") and the promotion into the
// base (design C.13 step 9; O-81; D-945, D-970…). The nightly stage (`cortexLearnNight`, stage.ts) calls
// `probeNight` AFTER its scorecard, duel and checkpoint; the weekly stage (`cortexLearnWeekly`,
// weekly.ts) calls `baseWeekly` BEFORE its re-weighting (D-972), so a base change restarts the learner
// on the new base in the same week. Each call sits in its own try/catch: a failing hook never stops the
// scorecard, the duel, the checkpoint or the weekly re-weighting.
//
// `CORTEX_LEARN_HOOKS` below wires the probe / base functions of baseStage.ts; the stages read it when
// no `hooks` option is passed (a test passes its own). Event seqs of a night: 0 the scorecard, 1..99
// the nightly learner, 100 / 101 the weekly reweight and placebo, then from `seqBase` (200) the hooks:
// probes 200..249, base 250..299 (baseStage.ts PROBE_SEQ0 / BASE_SEQ0, D-970).
import type { Client } from "@libsql/client";
import type { CalendarRow } from "@/lib/data/calendar";
import type { MoverExplanation } from "@/lib/learning/daily";
import type { World } from "@/lib/learning/dailyLoad";
import type { Top5Sets } from "@/lib/learning/dailyTop5";
import type { MapRow } from "../store/maps";
import { baseWeekly, probeNight } from "./baseStage";
import type { LearnConfig } from "./config";
import type { CandidateTally, Top5Flags } from "./top5";

/** First `cortex_learn_event.seq` a hook may use on a night (the stages use the seqs below it). */
export const HOOK_SEQ_BASE = 200; // threshold-ok: event seq layout (header)

export type ProbeNightContext = {
  readonly market: string;
  readonly d: string;
  readonly calendar: readonly CalendarRow[];
  /** The daily learning's World of night d (bars of the liquid shares up to d). */
  readonly world: World;
  /** The night's explained movers (daily learning): the recurring-cause tally of the probes. */
  readonly movers: readonly Pick<MoverExplanation, "code" | "side" | "cause">[];
  /** The five biggest liquid gainers and losers of night d (dailyTop5.ts). */
  readonly top5?: Top5Sets;
  /** Stored top-5 flags of the nights before d in the four-week window (oldest first). */
  readonly top5History?: readonly Top5Flags[];
  /** Finished candidate picks per probe angle (handed in by the picks entry; evidence words only). */
  readonly candidatePicks?: ReadonlyMap<string, CandidateTally>;
  /** The learner row in force tonight (null when no learner exists yet). */
  readonly learner: MapRow | null;
  readonly config: LearnConfig;
  readonly seqBase: number;
  /** created_at of any row the hook writes; never part of a statistic. */
  readonly now: string;
};

export type BaseWeeklyContext = {
  readonly market: string;
  /** The weekly run's date and the week's last trading session (the embargo night). */
  readonly d: string;
  readonly lastSession: string;
  readonly calendar: readonly CalendarRow[];
  /** The fixed (base) row and the learner row in force BEFORE this week's re-weighting (D-972). */
  readonly fixed: MapRow | null;
  readonly learner: MapRow | null;
  readonly config: LearnConfig;
  readonly seqBase: number;
  /**
   * fitted_at of a system base row and created_at of the base rows: an instant just after the cut-off
   * of the week's last session (learner.ts embargoFittedAt), so the new base is first used on the next
   * session and a re-run writes the same keys.
   */
  readonly now: string;
};

/** A family whose base changed tonight: the weekly stage restarts its learner on `ruleVersion`. */
export type RestartLearner = {
  readonly family: string;
  readonly ruleVersion: string;
  readonly baseVersion: number;
  readonly sinceD: string;
};

/** What a hook hands back: extra Evening Review lines and weekly-run statistics (all optional). */
export type HookResult = {
  readonly lines?: readonly string[];
  readonly stats?: readonly { readonly metric: string; readonly value: unknown }[];
  /** baseWeekly: the learners to restart on a new base this week (D-972). */
  readonly restartLearner?: readonly RestartLearner[];
  /** probeNight: tonight's top-5 flags of the probe measures (stored with the scored set's, D-985). */
  readonly top5?: Top5Flags;
};

export type CortexLearnHooks = {
  /** Nightly, after the scorecard, duel and checkpoint (the probe builder's nightly step). */
  readonly probeNight?: (db: Client, ctx: ProbeNightContext) => Promise<HookResult | void>;
  /** Weekly, before the re-weighting (the probe close / promotion into the base). */
  readonly baseWeekly?: (db: Client, ctx: BaseWeeklyContext) => Promise<HookResult | void>;
};

/** The hooks the production stages call: the probe and base steps of baseStage.ts (D-970). */
export const CORTEX_LEARN_HOOKS: CortexLearnHooks = {
  probeNight: async (db, ctx) => {
    const r = await probeNight(db, {
      market: ctx.market,
      d: ctx.d,
      calendar: ctx.calendar,
      world: ctx.world,
      movers: ctx.movers,
      now: ctx.now,
      ...(ctx.top5 === undefined ? {} : { top5: ctx.top5 }),
      ...(ctx.top5History === undefined ? {} : { top5History: ctx.top5History }),
      ...(ctx.candidatePicks === undefined ? {} : { candidatePicks: ctx.candidatePicks }),
    });
    if (r === null) return {};
    return {
      lines: r.lines,
      top5: r.top5,
      stats: [
        {
          metric: "cortex_probe",
          value: { scored: r.scoredRows, opened: r.opened.length, escalated: r.escalated.length },
        },
      ],
    };
  },
  baseWeekly: async (db, ctx) => {
    const r = await baseWeekly(db, {
      market: ctx.market,
      d: ctx.lastSession,
      calendar: ctx.calendar,
      now: ctx.now,
      q: ctx.config.probeQ,
    });
    if (r === null) return {};
    return {
      lines: r.lines,
      restartLearner: r.restartLearner,
      stats: [
        {
          metric: "cortex_base",
          value: {
            families: r.families.map((f) => ({
              family: f.family,
              version: f.version,
              change: f.change,
            })),
            closed: r.closed.length,
            restarts: r.restartLearner.length,
          },
        },
      ],
    };
  },
};
