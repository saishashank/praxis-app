// The as-of view builder (M15 C1a; docs/M15_design.md 3a; CTX-010; TST-109). `buildAsOfView` takes
// the plain arrays of one world and returns a view whose every accessor is bounded by the session
// index `t` it is given: rows are stored sorted by their KNOWN_TIME instant and sliced at the
// cut-off of sessions[t], so an angle cannot see t + 1 by construction. `partitionWorld` does the
// sorting once; `cutPartitioned(stores, t)` builds the physically truncated world that the TST-109
// helper rebuilds the view from, without sorting the whole world again per t.
// Pure: no clock, no store, no random source; the only instants are the rows' own and the session
// cut-offs (decisionCutoffUtc). Money stays bigint; the adjusted series comes from adjust.ts and is
// cached per (code, adjustment basis) on the partition, so every handle of the world shares it.
import { splitActionsByCode, splitsKnownOn, type SplitAction } from "@/lib/agents/candidates";
import type { IndexViewBar, ViewBar } from "@/lib/agents/decisionView";
import type { IndexChangeFact, RegimeLabel } from "@/lib/agents/families/types";
import { regimeSeries } from "@/lib/agents/regime";
import type { CorpActionRecord } from "@/lib/arena/corpActions";
import { buildCodeSeries, dividendTermsOf, type DividendTerm } from "./adjust";
import { instantMs, knownTimeOf, makeSessionClock } from "./knownTime";
import { buildManifest } from "./manifest";
import {
  INPUT_KINDS,
  type AsOfView,
  type AsOfWorld,
  type CodeSeries,
  type EventRow,
  type HaltRow,
  type IndexChangeRow,
  type IndexCode,
  type IndustryRow,
  type InputKind,
  type InputManifest,
  type KnownTimeRow,
  type MacroPoint,
  type MacroRow,
  type ManifestSource,
  type SessionClock,
  type ShortPoint,
  type TierRow,
} from "./types";

/** Thrown when a caller asks for a session index the handle does not answer (beyond its truncation). */
export class AsOfError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "AsOfError";
  }
}

// ---- stores ---------------------------------------------------------------------------------------------------

/** Rows of one source sorted by known instant (stable), with the instant beside each row. */
type Store<T> = {
  readonly kind: InputKind;
  readonly rows: readonly T[];
  readonly knownMs: readonly number[];
};

function makeStore<T>(
  kind: InputKind,
  rows: readonly T[],
  toRow: (r: T) => KnownTimeRow,
  clock: SessionClock,
): Store<T> {
  const stamped = rows.map((r, i) => ({ r, i, ms: instantMs(knownTimeOf(kind, toRow(r), clock)) }));
  stamped.sort((a, b) => a.ms - b.ms || a.i - b.i);
  return { kind, rows: stamped.map((s) => s.r), knownMs: stamped.map((s) => s.ms) };
}

/** Number of rows known at or before `cutoffMs` (rows are sorted by known instant). */
function knownCount<T>(store: Store<T>, cutoffMs: number): number {
  let lo = 0;
  let hi = store.knownMs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (store.knownMs[mid]! <= cutoffMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The last `count` of the first `n` rows, in one slice. */
function lastOf<T>(rows: readonly T[], n: number, count: number): readonly T[] {
  if (count >= n) return n === rows.length ? rows : rows.slice(0, n);
  return rows.slice(n - count, n);
}

/** A copy of `obj` without `key` (the view returns the fact without its known-time stamp). */
function stripKey<T extends object, K extends keyof T>(obj: T, key: K): Omit<T, K> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (k !== key) out[k] = v;
  return out as Omit<T, K>;
}

/** Index of the last row with d <= `d` in a d-sorted array, plus one (= the count of such rows). */
function countUpToDate<T extends { readonly d: string }>(rows: readonly T[], d: string): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid]!.d <= d) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function assertIncreasing<T extends { readonly d: string }>(
  rows: readonly T[],
  what: string,
): void {
  for (let i = 1; i < rows.length; i += 1) {
    if (!(rows[i - 1]!.d < rows[i]!.d))
      throw new RangeError(`${what}: dates not increasing at ${i}`);
  }
}

const INDEX_KIND: Readonly<Record<IndexCode, InputKind>> = {
  AXJO: "index_au",
  GSPC: "index_us",
  VIX: "index_us",
};

function indexChangeRow(r: IndexChangeRow): KnownTimeRow {
  return { knownAt: r.knownAt ?? null, d: r.announced ?? r.effective };
}

/** A macro row with its series id attached, so the known-time rule can look the series up. */
type MacroRowS = MacroRow & { readonly series: string };

/**
 * A world sorted by known time: the stores every handle of the view reads, plus the per-code
 * adjusted-series cache. Opaque to callers; built by `partitionWorld`, consumed by `buildAsOfView`
 * (through `buildAsOfViewFrom`) and `cutPartitioned`.
 */
export type PartitionedWorld = {
  readonly world: AsOfWorld;
  readonly clock: SessionClock;
  readonly cutoffMs: readonly number[];
  readonly bars: ReadonlyMap<string, Store<ViewBar>>;
  readonly tiers: ReadonlyMap<string, readonly TierRow[]>;
  readonly index: ReadonlyMap<IndexCode, Store<IndexViewBar>>;
  readonly shorts: ReadonlyMap<string, Store<ShortPoint>>;
  readonly macro: ReadonlyMap<string, Store<MacroRowS>>;
  readonly events: ReadonlyMap<string, Store<EventRow>>;
  readonly corpActions: ReadonlyMap<string, Store<CorpActionRecord>>;
  readonly indexChanges: ReadonlyMap<string, Store<IndexChangeRow>> | null;
  readonly industry: ReadonlyMap<string, Store<IndustryRow>>;
  readonly halts: ReadonlyMap<string, readonly HaltRow[]>;
  readonly calendarStore: Store<{ readonly d: string }>;
  /** Every store, for the manifest counts. */
  readonly all: readonly Store<unknown>[];
  /** Regime state per ^AXJO bar (full series; the state at i depends only on closes <= i). */
  readonly regimeStates: readonly RegimeLabel[];
  /** code -> adjustment-basis key -> the CodeSeries over every bar of the code on that basis. */
  readonly adjCache: Map<string, Map<string, CodeSeries>>;
};

function mapStores<T>(
  kind: InputKind,
  source: ReadonlyMap<string, readonly T[]> | undefined,
  toRow: (r: T) => KnownTimeRow,
  clock: SessionClock,
  all: Store<unknown>[],
): Map<string, Store<T>> {
  const out = new Map<string, Store<T>>();
  if (!source) return out;
  for (const [key, rows] of [...source.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const s = makeStore(kind, rows, toRow, clock);
    out.set(key, s);
    all.push(s);
  }
  return out;
}

// The macro store needs the series id on each row for the rule; `toRow` cannot see the map key,
// so the series is attached before the store is built.
function withSeries(
  macro: ReadonlyMap<string, readonly MacroRow[]> | undefined,
): Map<string, readonly MacroRowS[]> | undefined {
  if (!macro) return undefined;
  const out = new Map<string, readonly MacroRowS[]>();
  for (const [series, rows] of macro)
    out.set(
      series,
      rows.map((r) => ({ ...r, series })),
    );
  return out;
}

/** Sorts every source of the world by known time, once. Throws on unsorted inputs or bad stamps. */
export function partitionWorld(world: AsOfWorld): PartitionedWorld {
  if (world.sessions.length === 0) throw new RangeError("a world needs at least one session");
  const clock = makeSessionClock(world.sessions, world.cutoffHhmm);
  const cutoffMs = world.sessions.map((d) => instantMs(clock.cutoffUtc(d)));
  const all: Store<unknown>[] = [];
  const bars = new Map<string, Store<ViewBar>>();
  for (const [code, rows] of [...world.bars.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    assertIncreasing(rows, `bars of ${code}`);
    const s = makeStore("bar_au", rows, (b) => ({ d: b.d }), clock);
    bars.set(code, s);
    all.push(s);
  }
  const tiers = new Map<string, readonly TierRow[]>();
  for (const [code, rows] of world.tiers ?? []) {
    assertIncreasing(rows, `tiers of ${code}`);
    tiers.set(code, rows);
  }
  const index = new Map<IndexCode, Store<IndexViewBar>>();
  for (const code of ["AXJO", "GSPC", "VIX"] as const) {
    const rows = world.index?.[code];
    if (!rows) continue;
    assertIncreasing(rows, `index ${code}`);
    const s = makeStore(INDEX_KIND[code], rows, (b) => ({ d: b.d }), clock);
    index.set(code, s);
    all.push(s);
  }
  const halts = new Map<string, readonly HaltRow[]>();
  for (const [code, rows] of world.halts ?? []) {
    assertIncreasing(rows, `halts of ${code}`);
    halts.set(code, rows);
  }
  const calendarStore = makeStore(
    "calendar",
    world.calendar.map((r) => ({ d: r.d })),
    () => ({}),
    clock,
  );
  all.push(calendarStore);
  // Regime over the whole benchmark series once: the value at index i depends only on closes <= i
  // (hysteresis carried forward), so the full-series state at i equals the truncated-series state.
  const axjo = index.get("AXJO");
  const regimeStates: readonly RegimeLabel[] = axjo
    ? regimeSeries(
        axjo.rows.map((b) => b.close),
        world.regimeParams,
      ).map((r) => r.state)
    : [];
  return {
    world,
    clock,
    cutoffMs,
    bars,
    tiers,
    index,
    shorts: mapStores("asic_short", world.shorts, (p) => ({ asOf: p.asOf }), clock, all),
    macro: mapStores(
      "macro",
      withSeries(world.macro),
      (m) => ({ d: m.obsD, publishedAt: m.publishedAt ?? null, series: m.series }),
      clock,
      all,
    ),
    events: mapStores(
      "announcement",
      world.events,
      (e) => ({ publishedAt: e.publishedAt }),
      clock,
      all,
    ),
    corpActions: mapStores(
      "corp_action",
      world.corpActions,
      (a) => ({ knownAt: a.knownAt ?? null, exDate: a.exDate }),
      clock,
      all,
    ),
    indexChanges:
      world.indexChanges === null
        ? null
        : mapStores("index_change", world.indexChanges, indexChangeRow, clock, all),
    industry: mapStores("sector_map", world.industry, (r) => ({ asOf: r.asOf }), clock, all),
    halts,
    calendarStore,
    all,
    regimeStates,
    adjCache: new Map(),
  };
}

// ---- adjustment cache ------------------------------------------------------------------------------------------

/** The adjustment basis of (code, t): the splits and dividends known at the cut-off with ex-date <= d. */
function basisAt(
  stores: PartitionedWorld,
  code: string,
  t: number,
): { readonly key: string; readonly splits: SplitAction[]; readonly dividends: DividendTerm[] } {
  const d = stores.world.sessions[t]!;
  const store = stores.corpActions.get(code);
  const actions = store ? store.rows.slice(0, knownCount(store, stores.cutoffMs[t]!)) : [];
  const splits = splitsKnownOn(
    splitActionsByCode(actions).byCode.get(code) ?? [],
    d,
    stores.world.cutoffHhmm,
  );
  const dividends = dividendTermsOf(actions).filter((dv) => dv.exDate <= d);
  const key =
    splits.map((s) => `${s.exDate}:${s.ratio.num}/${s.ratio.den}`).join(",") +
    "|" +
    dividends.map((dv) => `${dv.exDate}:${dv.dpsMicro.num}/${dv.dpsMicro.den}`).join(",");
  return { key, splits, dividends };
}

/**
 * The series of `code` over every bar of the code on the basis of (code, t), from the cache. Valid
 * because `adjustBars` scales a bar by the splits with a later ex-date only, and the dividend factor
 * of a bar reads only bars before each ex-date <= d: both are the same whether the series is built
 * over all bars or over the bars known at t, so one full series per basis serves every t.
 */
function seriesOnBasis(stores: PartitionedWorld, code: string, t: number): CodeSeries {
  const { key, splits, dividends } = basisAt(stores, code, t);
  let perCode = stores.adjCache.get(code);
  if (!perCode) {
    perCode = new Map();
    stores.adjCache.set(code, perCode);
  }
  let series = perCode.get(key);
  if (!series) {
    series = buildCodeSeries(code, stores.bars.get(code)?.rows ?? [], splits, dividends);
    perCode.set(key, series);
  }
  return series;
}

// ---- the view -----------------------------------------------------------------------------------------------------

/** Builds the view of a world; `maxT` = the last session. */
export function buildAsOfView(world: AsOfWorld): AsOfView {
  return buildAsOfViewFrom(partitionWorld(world));
}

/** Builds the view over an existing partition (shares its stores and caches). */
export function buildAsOfViewFrom(stores: PartitionedWorld): AsOfView {
  const { world, clock, cutoffMs } = stores;
  const sessions = world.sessions;
  const lastT = sessions.length - 1;
  const axjo = stores.index.get("AXJO");
  const codesCache = new Map<number, readonly string[]>();

  function makeView(maxT: number): AsOfView {
    const checkT = (t: number): void => {
      if (!Number.isInteger(t) || t < 0 || t > maxT)
        throw new AsOfError(`session index ${t} is outside this view (0..${maxT})`);
    };
    const cut = (t: number): number => {
      checkT(t);
      return cutoffMs[t]!;
    };
    const known = <T>(store: Store<T> | undefined, t: number): readonly T[] =>
      store ? lastOf(store.rows, knownCount(store, cut(t)), Number.POSITIVE_INFINITY) : [];
    const corpActionsAt = (code: string, t: number): readonly CorpActionRecord[] =>
      known(stores.corpActions.get(code), t);
    const haltRowsAt = (
      code: string,
      t: number,
    ): { rows: readonly HaltRow[]; n: number } | null => {
      checkT(t);
      const rows = stores.halts.get(code);
      if (!rows) return null;
      return { rows, n: countUpToDate(rows, sessions[t]!) };
    };

    const view: AsOfView = {
      market: world.market,
      sessions,
      cutoffHhmm: world.cutoffHhmm,
      maxT,
      indexChangesLoaded: stores.indexChanges !== null,
      calendar: world.calendar,
      cutoffUtc(t) {
        checkT(t);
        return clock.cutoffUtc(sessions[t]!);
      },
      codes(t) {
        checkT(t);
        let cached = codesCache.get(t);
        if (cached === undefined) {
          const d = sessions[t]!;
          const out: string[] = [];
          for (const [code, store] of stores.bars) {
            const n = countUpToDate(store.rows, d);
            if (n === 0 || store.rows[n - 1]!.d !== d) continue;
            if (stores.tiers.size > 0 && view.tier(code, t) === null) continue;
            out.push(code);
          }
          cached = out; // insertion order of `stores.bars` is code-sorted
          codesCache.set(t, cached);
        }
        return cached;
      },
      tier(code, t) {
        checkT(t);
        const rows = stores.tiers.get(code);
        if (!rows) return null;
        const n = countUpToDate(rows, sessions[t]!);
        return n === 0 ? null : rows[n - 1]!.tier;
      },
      barCount(code, t) {
        const store = stores.bars.get(code);
        return store ? knownCount(store, cut(t)) : (checkT(t), 0);
      },
      bars(code, t, count) {
        const store = stores.bars.get(code);
        return store ? lastOf(store.rows, knownCount(store, cut(t)), count) : (checkT(t), []);
      },
      adj(code, t, count): CodeSeries {
        const store = stores.bars.get(code);
        if (!store) {
          checkT(t);
          return { code, d: [], raw: [], adj: [], adjClose: [], adjVolume: [], divFactor: [] };
        }
        const n = knownCount(store, cut(t));
        const full = seriesOnBasis(stores, code, t);
        if (count >= n && n === full.d.length) return full;
        const from = count >= n ? 0 : n - count;
        return {
          code,
          d: full.d.slice(from, n),
          raw: full.raw.slice(from, n),
          adj: full.adj.slice(from, n),
          adjClose: full.adjClose.slice(from, n),
          adjVolume: full.adjVolume.slice(from, n),
          divFactor: full.divFactor.slice(from, n),
        };
      },
      index(indexCode, t, count) {
        const store = stores.index.get(indexCode);
        return store ? lastOf(store.rows, knownCount(store, cut(t)), count) : (checkT(t), []);
      },
      shorts(code, t, limit) {
        const store = stores.shorts.get(code);
        if (!store) {
          checkT(t);
          return [];
        }
        return [...lastOf(store.rows, knownCount(store, cut(t)), limit)].reverse();
      },
      macro(series, t, count): readonly MacroPoint[] {
        const store = stores.macro.get(series);
        if (!store) {
          checkT(t);
          return [];
        }
        return lastOf(store.rows, knownCount(store, cut(t)), count).map((m) => ({
          obsD: m.obsD,
          value: m.value,
        }));
      },
      events(code, t): readonly EventRow[] {
        const d = sessions[t]!;
        return known(stores.events.get(code), t)
          .filter((e) => e.day0 <= d)
          .map((e) => {
            // reversedNextClose is known at day 0 + 1 (families/types.ts), not at the row's known
            // time: null until the session after day 0 is at or before sessions[t].
            if (e.reversedNextClose === undefined) return e;
            const next = clock.nextSession(e.day0);
            return next !== null && next <= d ? e : { ...e, reversedNextClose: null };
          });
      },
      corpActions: corpActionsAt,
      indexChanges(code, t): readonly IndexChangeFact[] {
        if (stores.indexChanges === null) {
          checkT(t);
          return [];
        }
        return known(stores.indexChanges.get(code), t).map((r) => stripKey(r, "knownAt"));
      },
      industry(code, t) {
        const rows = known(stores.industry.get(code), t);
        return rows.length === 0 ? null : rows[rows.length - 1]!.industry;
      },
      halted(code, t) {
        const h = haltRowsAt(code, t);
        return h === null || h.n === 0 ? null : h.rows[h.n - 1]!.halted;
      },
      haltSince(code, t) {
        const h = haltRowsAt(code, t);
        if (h === null || h.n === 0 || !h.rows[h.n - 1]!.halted) return null;
        let i = h.n - 1;
        while (i > 0 && h.rows[i - 1]!.halted) i -= 1;
        return h.rows[i]!.d;
      },
      regime(t) {
        if (!axjo) {
          checkT(t);
          return "unknown";
        }
        const n = knownCount(axjo, cut(t));
        return n === 0 ? "unknown" : stores.regimeStates[n - 1]!;
      },
      manifest(t): InputManifest {
        const c = cut(t);
        const sources: ManifestSource[] = INPUT_KINDS.map((kind) => {
          let rows = 0;
          let last: number | null = null;
          for (const s of stores.all) {
            if (s.kind !== kind) continue;
            const n = knownCount(s, c);
            rows += n;
            if (n > 0) {
              const ms = s.knownMs[n - 1]!;
              if (last === null || ms > last) last = ms;
            }
          }
          return { kind, rows, lastKnownAt: last === null ? null : new Date(last).toISOString() };
        });
        return buildManifest({
          market: world.market,
          d: sessions[t]!,
          schemaSha: world.schemaSha,
          sources,
        });
      },
      truncated(t) {
        checkT(t);
        return t === maxT ? view : makeView(t);
      },
    };
    return view;
  }

  return makeView(lastT);
}

/** The session index of `d` in `sessions`; throws when `d` is not a session. */
export function sessionIndexOf(sessions: readonly string[], d: string): number {
  const n = countUpToDate(
    sessions.map((s) => ({ d: s })),
    d,
  );
  if (n === 0 || sessions[n - 1] !== d) throw new RangeError(`${d} is not a session`);
  return n - 1;
}

/**
 * The world physically cut at session index `t` from an existing partition: sessions up to t and,
 * per source, only the rows whose known time is at or before cutoffUtc(sessions[t]). Building a
 * view from this world and asking it about t must give the same answers as the full view
 * (TST-109, truncation.ts). Row order inside each source is the known-time order.
 */
export function cutPartitioned(stores: PartitionedWorld, t: number): AsOfWorld {
  const { world } = stores;
  if (!Number.isInteger(t) || t < 0 || t >= world.sessions.length)
    throw new RangeError(`cut index ${t} outside 0..${world.sessions.length - 1}`);
  const c = stores.cutoffMs[t]!;
  const d = world.sessions[t]!;
  const cutMap = <T>(m: ReadonlyMap<string, Store<T>>): Map<string, readonly T[]> =>
    new Map([...m].map(([k, s]) => [k, s.rows.slice(0, knownCount(s, c))]));
  const index: Partial<Record<IndexCode, readonly IndexViewBar[]>> = {};
  for (const [code, s] of stores.index) index[code] = s.rows.slice(0, knownCount(s, c));
  const macro = new Map<string, readonly MacroRow[]>();
  for (const [series, s] of stores.macro)
    macro.set(
      series,
      s.rows.slice(0, knownCount(s, c)).map((r) => stripKey(r, "series")),
    );
  return {
    market: world.market,
    sessions: world.sessions.slice(0, t + 1),
    cutoffHhmm: world.cutoffHhmm,
    calendar: world.calendar,
    schemaSha: world.schemaSha,
    bars: cutMap(stores.bars),
    tiers: new Map(
      [...stores.tiers].map(([k, rows]) => [k, rows.slice(0, countUpToDate(rows, d))]),
    ),
    index,
    shorts: cutMap(stores.shorts),
    macro,
    events: cutMap(stores.events),
    corpActions: cutMap(stores.corpActions),
    indexChanges: stores.indexChanges === null ? null : cutMap(stores.indexChanges),
    industry: cutMap(stores.industry),
    halts: new Map(
      [...stores.halts].map(([k, rows]) => [k, rows.slice(0, countUpToDate(rows, d))]),
    ),
    regimeParams: world.regimeParams,
  };
}

/** `cutPartitioned(partitionWorld(world), t)`: one cut of a world that is not partitioned yet. */
export function cutWorld(world: AsOfWorld, t: number): AsOfWorld {
  return cutPartitioned(partitionWorld(world), t);
}
