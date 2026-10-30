// Cortex point-in-time types (M15 C1a; docs/M15_design.md 3a "point in time"; CTX-010). The shapes
// every other Cortex package reads data through. Existing types are reused by import, never copied:
// ViewBar / IndexViewBar (decisionView.ts), AdjBar (candidates.ts), Tier, EventFact, IndexChangeFact,
// RegimeLabel (families/types.ts), CorpActionRecord (arena/corpActions.ts), CalendarRow (data/calendar.ts).
// Pure types only; the builder is asOfView.ts, the known-time table knownTime.ts.
import type { AdjBar } from "@/lib/agents/candidates";
import type { IndexViewBar, ViewBar } from "@/lib/agents/decisionView";
import type { EventFact, IndexChangeFact, RegimeLabel, Tier } from "@/lib/agents/families/types";
import type { AgentParams } from "@/lib/agents/params";
import type { CorpActionRecord } from "@/lib/arena/corpActions";
import type { CalendarRow } from "@/lib/data/calendar";

// ---- known time ---------------------------------------------------------------------------------------------

/** One source class = one known-time rule (CTX-010). The rule is data, never a branch in an angle. */
export type InputKind =
  | "bar_au" // Yahoo D bar: known at the cut-off of D when present in the night's snapshot (D-263 interim)
  | "index_au" // ^AXJO close: as bar_au
  | "index_us" // ^GSPC, ^VIX dated D: known D+1 09:00 Melbourne all year (D-290)
  | "asic_short" // as_of + ASIC_PUBLISH_LAG_WEEKDAYS at 23:59:59Z (asicPublishedAt, data/backfill/rules.mjs)
  | "macro" // RBA/FRED: publication instant when stamped, else the MACRO_SERIES lag in sessions
  | "announcement" // published_at; an untimed (date-only) backfill row = +1 session (OI-46)
  | "corp_action" // known_at (0016) else ex-date - 1 session for vendor rows
  | "index_change" // DAT-234 manual list: known_at else announced date (else effective date) + 1 session (D-302)
  | "calendar" // trading_calendar rows: known at load
  | "sector_map"; // instrument_class / ASX list: as_of (D-271: current map offline, labelled)

export const INPUT_KINDS: readonly InputKind[] = [
  "bar_au",
  "index_au",
  "index_us",
  "asic_short",
  "macro",
  "announcement",
  "corp_action",
  "index_change",
  "calendar",
  "sector_map",
];

/**
 * The fields a known-time rule may read. One row carries only the fields its source has: a bar has
 * `d`, a short-interest point `asOf`, an announcement `publishedAt`, a confirmed action `knownAt`
 * (else `exDate`), a macro observation `d` (= observation date) and `series`.
 */
export type KnownTimeRow = {
  readonly d?: string;
  readonly asOf?: string;
  readonly publishedAt?: string | null;
  readonly knownAt?: string | null;
  readonly exDate?: string;
  readonly series?: string;
};

/**
 * What a rule needs besides the row: the cut-off instant of a session and the session arithmetic for
 * the "+1 session" rules. Built by `makeSessionClock(sessions, cutoffHhmm)`. (Design 3a had the rule
 * as a function of the row alone; "+1 session" and "at the cut-off" cannot be computed without this.)
 */
export type SessionClock = {
  readonly sessions: readonly string[];
  readonly cutoffHhmm: string;
  /** decisionCutoffUtc(d, cutoffHhmm): the cut-off instant of session date `d` (any date, ISO UTC). */
  cutoffUtc(d: string): string;
  /** The first session strictly after `d`; null when the list ends on or before `d`. */
  nextSession(d: string): string | null;
  /** The last session strictly before `d`; null when the list starts on or after `d`. */
  previousSession(d: string): string | null;
};

/** ISO-8601 UTC instant at which the row becomes usable (compared as instants, never as text). */
export type KnownTimeRule = (row: KnownTimeRow, clock: SessionClock) => string;

// ---- series ---------------------------------------------------------------------------------------------------

export type IndexCode = "AXJO" | "GSPC" | "VIX";
export const INDEX_CODES_PIT: readonly IndexCode[] = ["AXJO", "GSPC", "VIX"];

/**
 * A point-in-time series of one code: raw bars and the split-adjusted view on the basis known at
 * the cut-off (CTX-050 method: OHLC x cumulative split factor, volume x split ratio, dividends as a
 * separate float factor that is a statistic, never money).
 */
export type CodeSeries = {
  readonly code: string;
  /** Session dates, oldest first, same length as every array below. */
  readonly d: readonly string[];
  readonly raw: readonly ViewBar[];
  /** Full adjusted OHLCV (adjustBars, candidates.ts) so angles that read opens/highs/lows share one basis. */
  readonly adj: readonly AdjBar[];
  readonly adjClose: readonly bigint[];
  readonly adjVolume: readonly bigint[];
  /** Cumulative dividend factor <= 1 (product of 1 - dps / prior close over later ex-dates); 1 = none. */
  readonly divFactor: readonly number[];
};

export type ShortPoint = { readonly asOf: string; readonly ppm: number };
export type MacroPoint = { readonly obsD: string; readonly value: number };

export type ManifestSource = {
  readonly kind: InputKind;
  readonly rows: number;
  /** ISO UTC of the latest known time among the rows counted; null when there are none. */
  readonly lastKnownAt: string | null;
};

/** The immutable per-night input record (CTX-010); `manifestId` = sha256 of the canonical JSON of the rest. */
export type InputManifest = {
  readonly manifestId: string;
  readonly market: string;
  readonly d: string;
  readonly sources: readonly ManifestSource[];
  readonly schemaSha: string;
};

// ---- the world the builder takes ---------------------------------------------------------------------------------

export type TierRow = { readonly d: string; readonly tier: Tier | null };
export type MacroRow = {
  readonly obsD: string;
  readonly value: number;
  /** Publication instant when the source stamps one (ISO UTC); absent = the MACRO_SERIES lag applies. */
  readonly publishedAt?: string | null;
};
/** An event fact with the instant its announcement was published (date-only text = untimed backfill). */
export type EventRow = EventFact & { readonly publishedAt: string };
export type IndexChangeRow = IndexChangeFact & {
  /** GL-02 style stamp when the CSV row carries one; absent = known from the announced (else effective) date. */
  readonly knownAt?: string | null;
};
export type IndustryRow = { readonly asOf: string; readonly industry: string | null };
export type HaltRow = { readonly d: string; readonly halted: boolean };

/**
 * Plain arrays, one world. The three producers (live store, replay snapshot, offline extract) fill
 * this and call `buildAsOfView`. Every per-code array is oldest first. Absent optional maps mean
 * "source not loaded": the accessors return empty and the manifest counts zero rows for that kind.
 * `indexChanges: null` means the DAT-234 list is missing (G08 fails closed on `indexChangesLoaded`).
 *
 * Every field of a row must be known at that row's known time: the view bounds rows, it cannot see
 * inside a row. The producer owns that (an event's `ar` / `volRatio` from day-0 bars only, a tier
 * from the snapshot of its own session); the one field the view nulls itself is
 * `EventFact.reversedNextClose`, which is known at day 0 + 1.
 */
export type AsOfWorld = {
  readonly market: string;
  readonly sessions: readonly string[];
  readonly cutoffHhmm: string;
  readonly calendar: readonly CalendarRow[];
  readonly schemaSha: string;
  readonly bars: ReadonlyMap<string, readonly ViewBar[]>;
  /** Universe membership per session; required for a universe (`codes(t)`), absent only in fixtures. */
  readonly tiers?: ReadonlyMap<string, readonly TierRow[]>;
  /** ^AXJO must span `regimeWarmupCloses(regimeParams)` closes before the first t that reads `regime`. */
  readonly index?: Partial<Readonly<Record<IndexCode, readonly IndexViewBar[]>>>;
  readonly shorts?: ReadonlyMap<string, readonly ShortPoint[]>;
  readonly macro?: ReadonlyMap<string, readonly MacroRow[]>;
  readonly events?: ReadonlyMap<string, readonly EventRow[]>;
  readonly corpActions?: ReadonlyMap<string, readonly CorpActionRecord[]>;
  readonly indexChanges?: ReadonlyMap<string, readonly IndexChangeRow[]> | null;
  readonly industry?: ReadonlyMap<string, readonly IndustryRow[]>;
  readonly halts?: ReadonlyMap<string, readonly HaltRow[]>;
  /** `windows` and `regime` of the night's params drive regimeSeries over ^AXJO (regime.ts). */
  readonly regimeParams: AgentParams;
};

// ---- the view ------------------------------------------------------------------------------------------------

/**
 * Read-only view of the world truncated at session index `t` of `sessions`. Every accessor takes an
 * explicit `t` and returns only rows whose KNOWN_TIME <= cutoffUtc(sessions[t]). Built once per world
 * by `buildAsOfView(world)`; `truncated(t)` is a cheap handle that refuses any index beyond `t`.
 * Enforced by construction (rows are stored sorted by known time and sliced by the cut-off instant);
 * TST-109 then rebuilds the view from arrays cut at t (`cutWorld`) and asserts equal features.
 */
export type AsOfView = {
  readonly market: string;
  readonly sessions: readonly string[];
  /** params.decisionCutoff ("18:10"). */
  readonly cutoffHhmm: string;
  /** The largest `t` this handle answers; `sessions.length - 1` for the full view. */
  readonly maxT: number;
  /** True when the DAT-234 index-change list was loaded (false = fail closed, CTX-013 step 8). */
  readonly indexChangesLoaded: boolean;
  readonly calendar: readonly CalendarRow[];
  cutoffUtc(t: number): string;
  /** Universe codes with a bar on sessions[t] (and a tier at t when tiers are loaded), sorted. */
  codes(t: number): readonly string[];
  tier(code: string, t: number): Tier | null;
  /** Number of raw bars with d <= sessions[t] (the warm-up check without a slice). */
  barCount(code: string, t: number): number;
  /** The last `count` raw bars with d <= sessions[t], oldest first. */
  bars(code: string, t: number, count: number): readonly ViewBar[];
  /** The last `count` sessions adjusted on the basis known at cutoffUtc(t). */
  adj(code: string, t: number, count: number): CodeSeries;
  index(indexCode: IndexCode, t: number, count: number): readonly IndexViewBar[];
  /** Short-interest points usable at the cut-off, newest first. */
  shorts(code: string, t: number, limit: number): readonly ShortPoint[];
  /** The last `count` macro observations published by the cut-off, oldest first. */
  macro(series: string, t: number, count: number): readonly MacroPoint[];
  /**
   * Events with day 0 <= sessions[t] whose announcement was published by the cut-off, with that
   * publication instant (it is <= the cut-off, so a rule may read it). `reversedNextClose` is null
   * until the session after day 0 is at or before sessions[t].
   */
  events(code: string, t: number): readonly EventRow[];
  /** Actions known by the cut-off (known_at <= cutoffUtc(t)), including ones with a later ex-date. */
  corpActions(code: string, t: number): readonly CorpActionRecord[];
  indexChanges(code: string, t: number): readonly IndexChangeFact[];
  industry(code: string, t: number): string | null;
  halted(code: string, t: number): boolean | null;
  /** First session date of the halted run that is current at t; null when not halted (or unknown). */
  haltSince(code: string, t: number): string | null;
  /** regimeSeries over index(AXJO) up to t (regime.ts); "unknown" with no benchmark bar. */
  regime(t: number): RegimeLabel;
  manifest(t: number): InputManifest;
  /** A handle that answers t' <= t only. */
  truncated(t: number): AsOfView;
};
