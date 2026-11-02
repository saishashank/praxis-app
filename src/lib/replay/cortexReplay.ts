// Cortex replay driver (M15 P3; docs/M15_design.md 3a "replay" producer, 3c "Replay hook"; CTX-050
// replay, AT-50; D-278 one implementation, D-281, D-307, D-321). It is NOT a second engine: it builds
// the `AsOfWorld` of a `SnapshotWorld` (bars, tiers, GSPC/VIX index bars, ASIC short interest, macro
// series, calendar, corporate actions with their provenance), runs `runNight` once per session with
// the inputs the live stage uses, and hands the result to `replayCohorts` through the
// `CohortReplayOptions.cortex` hook, where the entries of an `allowed` family become limit orders
// (`fillEntryLimit`, trade-through rows mapped by `fillRowRule`). Shadow and blocked decisions are
// collected here and scored as would-have trades with `wouldHaveOutcome`.
// What the snapshot does not carry (event rows, per-night state rows, the DAT-234 list unless the
// caller says it was loaded) is left empty, so those gates run on what they are given and fail
// closed where the design says so (D-261 forward-measured states; G08 8a without the list).
// Pure given its inputs: no clock, no randomness beyond the seeded `scopedPrng`.
import type { ViewBar } from "@/lib/agents/decisionView";
import type { Family, RegimeLabel } from "@/lib/agents/families/types";
import type { AgentParams } from "@/lib/agents/params";
import { COST_PROFILES, type CostProfile } from "@/lib/arena/costs";
import { buildAsOfView } from "@/lib/cortex/pit/asOfView";
import type { AsOfView, AsOfWorld, HaltRow, IndustryRow, TierRow } from "@/lib/cortex/pit/types";
import type { AngleDef, AngleStatus } from "@/lib/cortex/angles/types";
import {
  atr20Micro,
  runNight,
  wouldHaveOutcome,
  type BlockedDecision,
  type BookState,
  type Decision,
  type FamilyNightRule,
  type FamilyStatusMap,
  type NightInputs,
  type NightOutput,
  type StateRef,
  type WouldHaveOutcome,
} from "@/lib/cortex/night";
import type { CortexMap } from "@/lib/cortex/score/types";
import type { CellStatistic } from "@/lib/stats/cells";
import { scopedPrng, type Prng } from "@/lib/stats/rng";
import type { CortexReplayHook } from "./cohortReplay";
import type { FillRowRule } from "@/lib/cortex/economics/fillRow";
import type { SnapshotWorld } from "./snapshotWorld";

const ADV_WINDOW = 20; // threshold-ok: sessions of the would-have ADV (the v1 ADV window)

export type CortexReplayConfig = {
  readonly world: SnapshotWorld;
  readonly params: AgentParams;
  /** Family → status; absent family = shadow (D-280). Default: every family shadow. */
  readonly status?: FamilyStatusMap;
  readonly maps?: ReadonlyMap<Family, CortexMap>;
  readonly cells?: ReadonlyMap<string, CellStatistic>;
  readonly rules?: ReadonlyMap<Family, FamilyNightRule>;
  readonly passports?: ReadonlyMap<string, AngleStatus>;
  readonly angles?: readonly AngleDef[];
  /** `cortex_state` rows per night; default none (the snapshot carries no state history, D-261). */
  readonly states?: (d: string) => readonly StateRef[];
  readonly labels?: ReadonlyMap<string, unknown>;
  readonly kills?: NightInputs["kills"];
  readonly arn011Failed?: (d: string) => ReadonlyMap<string, readonly string[]> | undefined;
  readonly goLiveD?: string | null;
  /** True when the DAT-234 list was loaded into the snapshot (an empty list is then a real list). */
  readonly indexChangesLoaded?: boolean;
  readonly schemaSha?: string;
  /**
   * Pins the regime label on every night. For synthetic worlds only: the real classifier needs
   * about 1,280 benchmark sessions (regime.ts), which a test world does not have.
   */
  readonly regimeOverride?: RegimeLabel;
  readonly prng?: (scope: string) => Prng;
};

/** The replay producer of the `AsOfWorld` (design 3a): one builder, the snapshot as the source. */
export function asOfWorldOf(cfg: CortexReplayConfig): AsOfWorld {
  const w = cfg.world;
  const bars = new Map<string, readonly ViewBar[]>();
  const tiers = new Map<string, readonly TierRow[]>();
  const halts = new Map<string, readonly HaltRow[]>();
  const industry = new Map<string, readonly IndustryRow[]>();
  for (const code of w.codes) {
    bars.set(code, w.barsOf(code));
    const t = w.tierRowsOf(code);
    if (t.length > 0) {
      tiers.set(code, t);
      halts.set(code, w.haltRowsOf(code));
    }
    const ind = w.industryRowsOf(code);
    if (ind.length > 0) industry.set(code, ind);
  }
  const index: { AXJO?: ReturnType<SnapshotWorld["indexBarsOf"]> } & Record<string, unknown> = {};
  for (const code of ["AXJO", "GSPC", "VIX"] as const) {
    const rows = w.indexBarsOf(code);
    if (rows.length > 0) index[code] = rows;
  }
  const changes = w.indexChangeRowsOf() ?? (cfg.indexChangesLoaded === true ? new Map() : null);
  return {
    market: w.market,
    sessions: w.sessions,
    cutoffHhmm: cfg.params.decisionCutoff,
    calendar: w.calendarRows(),
    schemaSha: cfg.schemaSha ?? w.sha,
    bars,
    tiers: tiers.size > 0 ? tiers : undefined,
    index: index as AsOfWorld["index"],
    shorts: w.shortInterest(),
    macro: w.macroSeries(),
    corpActions: w.cortexCorpActions(),
    indexChanges: changes,
    industry,
    halts,
    regimeParams: cfg.params,
  };
}

/** One scored shadow or blocked decision (CTX-023, CTX-054): the would-have trade of the decision. */
export type ReplayWouldHave = {
  readonly d: string;
  readonly kind: "shadow" | "blocked";
  readonly bookId: string;
  readonly family: Family;
  readonly code: string;
  readonly firstFail: string | null;
  readonly outcome: WouldHaveOutcome | null;
};

export type CortexReplay = {
  /** Pass as `CohortReplayOptions.cortex`. */
  readonly hook: CortexReplayHook;
  /** Every night run, in session order. */
  nights(): readonly { readonly d: string; readonly out: NightOutput }[];
  /** The `fill.rule` each Cortex entry fill would be written with (D-307), in fill order. */
  fillRules(): readonly { d: string; cohortId: string; code: string; rule: FillRowRule }[];
  /** Shadow and blocked decisions scored as would-have trades (null outcome = hold still open). */
  wouldHave(): readonly ReplayWouldHave[];
};

/**
 * The driver. `hook.night(d, books)` builds the view handle of session `d`, assembles the same
 * `NightInputs` the live stage does and runs `runNight`; the sink keeps the output of every night.
 */
export function createCortexReplay(cfg: CortexReplayConfig): CortexReplay {
  const w = cfg.world;
  const built = buildAsOfView(asOfWorldOf(cfg));
  const view: AsOfView =
    cfg.regimeOverride === undefined
      ? built
      : { ...built, regime: () => cfg.regimeOverride as RegimeLabel };
  const status: FamilyStatusMap = cfg.status ?? {};
  const outs: { d: string; out: NightOutput }[] = [];
  const fills: { d: string; cohortId: string; code: string; rule: FillRowRule }[] = [];
  const profiles = new Map<string, CostProfile>();
  const hook: CortexReplayHook = {
    status,
    night(d, books: readonly BookState[]) {
      const t = view.sessions.indexOf(d);
      if (t < 0) throw new RangeError(`unknown session ${d}`);
      for (const b of books) profiles.set(b.bookId, b.costProfile);
      return runNight({
        market: view.market,
        d,
        t,
        view,
        params: cfg.params,
        status,
        maps: cfg.maps ?? new Map(),
        cells: cfg.cells ?? new Map(),
        books,
        rules: cfg.rules ?? new Map(),
        states: cfg.states?.(d) ?? [],
        passports: cfg.passports ?? new Map(),
        angles: cfg.angles,
        labels: cfg.labels,
        kills: cfg.kills ?? { arena: false, families: new Set(), sourcesOff: new Set() },
        arn011Failed: cfg.arn011Failed?.(d),
        goLiveD: cfg.goLiveD,
        prng: cfg.prng ?? ((scope) => scopedPrng(scope)),
      });
    },
    sink(d, out) {
      outs.push({ d, out });
    },
    onFill(e) {
      fills.push(e);
    },
  };

  const score = (
    d: string,
    kind: "shadow" | "blocked",
    x: Decision | BlockedDecision,
  ): ReplayWouldHave => {
    const base = {
      d,
      kind,
      bookId: x.bookId,
      family: x.family,
      code: x.code,
      firstFail: "firstFail" in x ? x.firstFail : null,
    } as const;
    if (x.qty === null || x.limitMicro === null) return { ...base, outcome: null };
    const all = view.bars(x.code, view.sessions.indexOf(d), 300); // threshold-ok: ATR history window
    const later = w.barsOf(x.code).filter((b) => b.d > d);
    const tail = all.slice(-ADV_WINDOW);
    let traded = 0n;
    for (const b of tail) traded += b.close * b.volume;
    const advMicro = tail.length === 0 ? 0n : traded / BigInt(tail.length);
    return {
      ...base,
      outcome: wouldHaveOutcome({
        code: x.code,
        family: x.family,
        qty: x.qty,
        limitMicro: x.limitMicro,
        plan: x.plan,
        atrMicro: atr20Micro(all),
        bars: later,
        profile: profiles.get(x.bookId) ?? COST_PROFILES.P1,
        advMicro,
      }),
    };
  };
  return {
    hook,
    nights: () => outs,
    fillRules: () => fills,
    wouldHave: () => {
      const rows: ReplayWouldHave[] = [];
      for (const { d, out } of outs) {
        for (const x of out.shadow) rows.push(score(d, "shadow", x));
        for (const x of out.blocked) rows.push(score(d, "blocked", x));
      }
      return rows;
    },
  };
}
