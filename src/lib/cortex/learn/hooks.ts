// Plug-in points of the learning loop for the candidate measures ("probes") and the promotion into the
// base (design C.13 step 9; O-81). The nightly stage (`cortexLearnNight`, stage.ts) and the weekly stage
// (`cortexLearnWeekly`, weekly.ts) call these AFTER their own work, inside their own try/catch, so a
// failing hook never stops the scorecard, the duel, the checkpoint or the weekly re-weighting.
//
// The probe / base builder fills `CORTEX_LEARN_HOOKS` below (a one-line import of its functions); the
// stages read it when no `hooks` option is passed (a test passes its own). Event seqs: the nightly
// stage uses 0 (scorecard) and 1..99 (duel, checkpoint), the weekly stage 100..199; a hook writes its
// `cortex_learn_event` rows from `seqBase` (200) on.
import type { Client } from "@libsql/client";
import type { CalendarRow } from "@/lib/data/calendar";
import type { World } from "@/lib/learning/dailyLoad";
import type { MapRow } from "../store/maps";
import type { LearnConfig } from "./config";

/** First `cortex_learn_event.seq` a hook may use on a night (the stages use the seqs below it). */
export const HOOK_SEQ_BASE = 200; // threshold-ok: event seq layout (header)

export type ProbeNightContext = {
  readonly market: string;
  readonly d: string;
  readonly calendar: readonly CalendarRow[];
  /** The daily learning's World of night d (bars of the liquid shares up to d). */
  readonly world: World;
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
  /** The fixed (base) row and the learner row in force after this week's re-weighting. */
  readonly fixed: MapRow | null;
  readonly learner: MapRow | null;
  readonly config: LearnConfig;
  readonly seqBase: number;
  readonly now: string;
};

/** What a hook hands back: extra Evening Review lines and weekly-run statistics (both optional). */
export type HookResult = {
  readonly lines?: readonly string[];
  readonly stats?: readonly { readonly metric: string; readonly value: unknown }[];
};

export type CortexLearnHooks = {
  /** Nightly, after the scorecard, duel and checkpoint (the probe builder's nightly step). */
  readonly probeNight?: (db: Client, ctx: ProbeNightContext) => Promise<HookResult | void>;
  /** Weekly, after the re-weighting (the probe close / promotion into the base). */
  readonly baseWeekly?: (db: Client, ctx: BaseWeeklyContext) => Promise<HookResult | void>;
};

/** The hooks the production stages call. Empty until the probe / base builder plugs its functions in. */
export const CORTEX_LEARN_HOOKS: CortexLearnHooks = {};
