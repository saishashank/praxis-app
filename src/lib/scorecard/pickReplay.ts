// D-1062…D-1066 (Owner O-84): the night-by-night driver of the pick scorecard. For each of the last N
// sessions d that have a following session, it builds the night's picks from data known at the close of
// d only, with today's FIXED rules and the current risk bands, and hands them to the pure scoring
// (./pickScorecard.ts). A REPORT: nothing here writes to a config, Cortex, learner, promotion or arena
// table (the only database reads are the rule-version set, the labels dated on or before d and the
// stored development track records, all dated before every holdout).
//
// As-of safety (the guard the test pins):
//   * strategy signals: `SnapshotWorld.familyInputs(d)` (sessions up to d, bars up to d, adjusted closes
//     with ex-dates up to d, tiers from the bars BEFORE d) run through `runFamilies` with the live rule
//     versions. No bar after d is handed in.
//   * shortlist: the usable bars of the liquid codes cut at `b.d <= d` (and `shortlistInputs` itself
//     drops every day on or after d from its evidence and finishes its trades by d).
//   * history of a strategy (bad / typical / good case, aim reach): the stored development-split replay
//     summary (replayHistoryOf), which uses development rows only, dated before every holdout. The live
//     forward ledger history is not used (it cannot reach scenario_min_n inside the replay window).
//   * Cortex: `createCortexReplay` builds the AsOfView (known-time cut-off per source) and runs the
//     fixed night; the evening scores use equal cluster weights, no learner, no stored weights.
//   * labels: the newest label dated on or before d.
//   The scoring side reads the bars of d+1 and later, which the picks never saw.
//   Left out (said in the report): candidate measures (CAND.v1), intraday ideas, announcements (the
//   snapshot carries no titles or stamps, so "news" causes are never assigned), factor lines (display only).
import type { Client } from "@libsql/client";
import { microToFloat } from "@/lib/agents/indicators";
import { runFamilies } from "@/lib/agents/families";
import { initialStop } from "@/lib/agents/families/exits";
import type { CodeFacts, Family } from "@/lib/agents/families/types";
import type { AgentParams } from "@/lib/agents/params";
import { liveParams, loadVersionSet } from "@/lib/agents/versionRuns";
import { addDays } from "@/lib/data/calendar";
import { industryUnknown } from "@/lib/data/referenceData";
import { classifyCause } from "@/lib/learning/dailyMovers";
import { generatePicks } from "@/lib/picks/generate";
import { advValueOf, historyLine, replayHistoryOf, volOf, type BarPoint } from "@/lib/picks/inputs";
import { shortlistFromBars, usableBar } from "@/lib/picks/shortlistLoad";
import { SHORTLIST_RULE, type DayBar } from "@/lib/picks/shortlist";
import type { PickInput, Tier, UniverseCode } from "@/lib/picks/types";
import type { AngleStatus } from "@/lib/cortex/angles/types";
import { createCortexReplay, cortexTierFrom, type CortexReplay } from "@/lib/replay/cortexReplay";
import { signalId } from "@/lib/replay/ledger";
import type { SnapshotWorld } from "@/lib/replay/snapshotWorld";
import type { FeatureNight } from "@/lib/cortex/learn/scorecard";
import type { ViewBar } from "@/lib/agents/decisionView";
import {
  cortexDay,
  scoreDay,
  type CortexBasis,
  type CortexDay,
  type DayResult,
  type LaterBar,
  type ScoredPick,
} from "./pickScorecard";
import { top5Movers } from "@/lib/learning/dailyTop5";

const MARKET = "AU";
const WINDOW_DAYS = 480; // threshold-ok: same bar window as the nightly shortlist (shortlistLoad.ts)
const INDEX_CODE = "AXJO";
/** The manifest's schema stamp: a constant, so a night's manifest id does not depend on the snapshot file. */
const SCHEMA_SHA = "pick-scorecard-replay";
const PPM = 1_000_000; // threshold-ok: parts per million
const VOLUME_WINDOW = 20; // threshold-ok: sessions of the usual volume (the daily loop's volume ratio)
const LIQUID: readonly string[] = ["U1", "U2"];

/** The bars of a code up to and including d (binary search; the list is sorted by date). */
export function barsUpTo(list: readonly ViewBar[], d: string): readonly ViewBar[] {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.d <= d) lo = mid + 1;
    else hi = mid;
  }
  return list.slice(0, lo);
}

/** The last session of the replay window and the nights to replay (sessions with a following one). */
export function replayNights(sessions: readonly string[], n: number): string[] {
  const last = sessions.length - 1; // the newest session has no following one
  return sessions.slice(Math.max(0, last - n), last);
}

const toDayBar = (b: ViewBar): DayBar => ({
  d: b.d,
  openMicro: b.open,
  highMicro: b.high,
  lowMicro: b.low,
  closeMicro: b.close,
  volume: Number(b.volume), // money-float-ok: share count
});

export type PickReplayDeps = {
  readonly db: Client;
  readonly world: SnapshotWorld;
  readonly params: AgentParams;
  readonly market?: string;
};

type History = NonNullable<Awaited<ReturnType<typeof replayHistoryOf>>>;

/** What the replay needs of the database (read only), built once per run. */
export async function openReplay(deps: PickReplayDeps) {
  const market = deps.market ?? MARKET;
  const set = await loadVersionSet(deps.db, market, []);
  const live = liveParams(deps.params, set);
  const ruleVersions: Partial<Record<Family, string>> = {};
  for (const [family, v] of set === null ? [] : [...set.live]) ruleVersions[family] = v.id;
  const histories = new Map<string, History | null>();
  const labels = new Map<string, string>();
  const historyOf = async (family: string, ruleVersion: string, variant: string) => {
    const key = `${family}|${ruleVersion}|${variant}`;
    if (!histories.has(key)) {
      histories.set(key, await replayHistoryOf(deps.db, { family, ruleVersion, variant }));
    }
    return histories.get(key)!;
  };
  const labelOf = async (family: string, ruleVersion: string, d: string): Promise<string> => {
    const key = `${family}|${ruleVersion}|${d}`;
    const hit = labels.get(key);
    if (hit !== undefined) return hit;
    // the newest label dated on or before d (what the nightly read that evening)
    const r = await deps.db.execute({
      sql: `SELECT l.label FROM label l JOIN execution e ON e.id = l.execution_id
            WHERE e.family = ? AND l.rule_version = ? AND l.d <= ?
            ORDER BY l.d DESC, l.id DESC LIMIT 1`,
      args: [family, ruleVersion, d],
    });
    const v = r.rows.length === 0 ? "UNVALIDATED" : String(r.rows[0]!.label);
    labels.set(key, v);
    return v;
  };
  return { market, live, ruleVersions, historyOf, labelOf };
}

export type Opened = Awaited<ReturnType<typeof openReplay>>;

/** Tonight's inputs from the world as of d: strategy signals, shortlist and the universe (no bar after d). */
export async function inputsAsOf(
  deps: PickReplayDeps,
  opened: Opened,
  d: string,
): Promise<{ inputs: PickInput[]; universe: UniverseCode[] }> {
  const { world } = deps;
  const { live } = opened;
  const day = world.familyInputs(d);
  const count = Math.max(live.windows.adv, live.windows.vol + 1);
  const pointsOf = (code: string): BarPoint[] =>
    barsUpTo(world.barsOf(code), d)
      .slice(-count)
      .map((b) => ({ c: b.close, volume: b.volume }));
  const facts = new Map<string, CodeFacts>(day.codes.map((c) => [c.code, c]));
  const universe: UniverseCode[] = day.codes
    .filter((c) => !c.halted)
    .map((c) => ({
      code: c.code,
      tier: c.tier as Tier,
      vol: volOf(pointsOf(c.code), live.windows.vol),
    }));

  const out = runFamilies(day, live, { ruleVersions: opened.ruleVersions });
  const inputs: PickInput[] = [];
  for (const c of out.candidates) {
    const f = facts.get(c.code);
    if (f === undefined) continue;
    const close = f.bar.close;
    let stop: bigint | null = null;
    for (const s of c.plan.initialStops) {
      const v = initialStop(s.spec, close);
      if (stop === null || v > stop) stop = v;
    }
    const h = await opened.historyOf(c.family, c.ruleVersion, c.variant);
    const scenario = h === null ? null : h.scenario;
    const pts = pointsOf(c.code);
    inputs.push({
      signalId: signalId(world.market, d, c.family, c.ruleVersion, c.variant, c.code),
      cardId: null,
      family: c.family,
      ruleVersion: c.ruleVersion,
      variant: c.variant,
      code: c.code,
      tier: c.tier as Tier,
      rankScore: c.rankText,
      label: await opened.labelOf(c.family, c.ruleVersion, d),
      referenceMicro: close,
      stopMicro: stop,
      advValueMicro: advValueOf(pts, live.windows.adv),
      vol: volOf(pts, live.windows.vol),
      scenario,
      aimReachPpm: h === null || scenario === null ? null : h.aimReachByGood(scenario.goodPpm),
      holdMedianSessions: h === null ? null : h.holdMedian,
      medianDropPpm: h === null ? null : h.medianDropPpm,
      factors: [],
      basedOn: [
        ...(h !== null && scenario !== null
          ? [historyLine(scenario.n, h.source, h.winRatePpm)]
          : []),
        ...c.rules.filter((r) => r.pass).map((r) => `${r.id}: ${r.value} (needed ${r.threshold})`),
      ],
    });
  }

  // the nightly shortlist: liquid codes, bars cut at d, same pure rule as the live night
  const from = addDays(d, -WINDOW_DAYS);
  const tierOf = new Map<string, Tier>();
  const bars = new Map<string, DayBar[]>();
  for (const c of day.codes) {
    if (c.halted || !LIQUID.includes(c.tier)) continue;
    tierOf.set(c.code, c.tier as Tier);
    const list = barsUpTo(world.barsOf(c.code), d)
      .filter((b) => b.d >= from)
      .map(toDayBar)
      .filter(usableBar);
    bars.set(c.code, list);
  }
  const shortlist = shortlistFromBars({
    market: world.market,
    d,
    tierOf,
    codes: [...tierOf.keys()].sort(),
    bars,
    exclude: new Set(inputs.map((x) => x.code)),
  });
  return { inputs: [...inputs, ...shortlist], universe };
}

/** Tonight's picks as the scorer wants them (candidate measures are not replayed). */
export async function picksAsOf(
  deps: PickReplayDeps,
  opened: Opened,
  d: string,
): Promise<ScoredPick[]> {
  const { inputs, universe } = await inputsAsOf(deps, opened, d);
  const picks = generatePicks(inputs, {
    market: deps.world.market,
    d,
    calendar: deps.world.calendarRows(),
    picks: opened.live.picks,
    universe,
    createdAt: `${d}T00:00:00.000Z`,
  });
  return picks.map((p) => ({
    profile: p.profile,
    rank: p.rank,
    code: p.code,
    source: p.ruleVersion === SHORTLIST_RULE ? "shortlist" : "strategy",
    stopMicro: p.stopMicro,
    aimMicro: p.aimMicro,
  }));
}

/** Score night d on session nd (the scoring side: it may read bars after d). */
export function scoreNight(
  deps: PickReplayDeps,
  d: string,
  nd: string,
  picks: readonly ScoredPick[],
  night: FeatureNight | null,
  basis: CortexBasis = "live",
): DayResult | null {
  const { world } = deps;
  const next = world.familyInputs(nd);
  const liquidFacts = next.codes.filter((c) => !c.halted && LIQUID.includes(c.tier));
  const liquid = liquidFacts.map((c) => c.code).sort();
  const moves: { code: string; movePpm: number }[] = [];
  const returns = new Map<string, number>();
  for (const c of next.codes) {
    if (c.halted) continue;
    const a = world.bar(c.code, nd)?.close;
    const b = world.bar(c.code, d)?.close;
    if (a === undefined || b === undefined || a <= 0n || b <= 0n) continue;
    const ppm = Math.round(Number(((a - b) * BigInt(PPM)) / b)); // money-float-ok: ppm integer
    moves.push({ code: c.code, movePpm: ppm });
    returns.set(c.code, microToFloat(a) / microToFloat(b) - 1);
  }
  if (moves.length === 0) return null;
  const sets = top5Movers(moves, liquid);
  const moveOf = new Map(moves.map((m) => [m.code, m.movePpm]));
  const sectorOf = new Map<string, string>();
  for (const c of liquidFacts) {
    if (c.industry !== undefined && c.industry !== null && !industryUnknown(c.industry)) {
      sectorOf.set(c.code, c.industry);
    }
  }
  const members = new Map<string, string[]>();
  for (const [code, sec] of sectorOf) members.set(sec, [...(members.get(sec) ?? []), code]);
  const ix = world.indexBarsOf(INDEX_CODE);
  const ixNow = ix.find((b) => b.d === nd)?.close;
  const ixPrev = ix.find((b) => b.d === d)?.close;
  const indexMovePpm =
    ixNow === undefined || ixPrev === undefined || ixPrev <= 0n
      ? null
      : Math.round(Number(((ixNow - ixPrev) * BigInt(PPM)) / ixPrev)); // money-float-ok: ppm integer
  const explain = (code: string, side: "gainer" | "loser") => {
    void side;
    const sector = sectorOf.get(code) ?? null;
    const others =
      sector === null ? [] : (members.get(sector) ?? []).filter((c) => c !== code && moveOf.has(c));
    const sectorMovePpm =
      others.length === 0
        ? null
        : Math.round(others.reduce((s, c) => s + moveOf.get(c)!, 0) / others.length);
    const list = barsUpTo(world.barsOf(code), nd);
    const today = list[list.length - 1];
    const prior = list.slice(-(VOLUME_WINDOW + 1), -1);
    let volumeVsUsualPpm: number | null = null;
    if (today !== undefined && today.d === nd && prior.length > 0) {
      const avg = prior.reduce((s, b) => s + Number(b.volume), 0) / prior.length; // money-float-ok: share counts
      volumeVsUsualPpm = avg > 0 ? Math.round((Number(today.volume) / avg) * PPM) : null; // money-float-ok: ratio
    }
    const { cause } = classifyCause({
      movePpm: moveOf.get(code) ?? 0,
      indexMovePpm,
      sectorName: sector,
      sectorMovePpm,
      sectorShares: others.length + 1,
      volumeVsUsualPpm,
      newsBefore: [], // the snapshot carries no announcement titles or stamps (D-1065)
      newsDuring: [],
    });
    return { cause, name: null };
  };
  const cortex: CortexDay | null = cortexDay(night, sets, liquid, returns, basis);
  return scoreDay({
    d,
    nextD: nd,
    picks,
    moves,
    liquid,
    explain,
    later: (code): readonly LaterBar[] =>
      world
        .barsOf(code)
        .filter((b) => b.d >= nd)
        .map((b) => ({ d: b.d, open: b.open, high: b.high, low: b.low, close: b.close })),
    cortex,
  });
}

/**
 * The angle statuses the fixed Cortex had at the end of d: for each angle the newest passport version
 * frozen on or before d (D-1066: a version frozen later is knowledge after d and is not used). D-1070:
 * for a night before the first frozen passport, the EARLIEST frozen set (the go-live set, basis
 * "golive"), never today's; an empty table gives no statuses. Read only, no OFFSET.
 */
export async function passportsAsOf(
  db: Pick<Client, "execute">,
  market: string,
  d: string,
): Promise<{ statuses: Map<string, AngleStatus>; basis: CortexBasis }> {
  let cut = `${d}T23:59:59.999Z`;
  let basis: CortexBasis = "live";
  const first = await db.execute({
    sql: "SELECT MIN(frozen_at) AS f FROM angle_passport WHERE market = ?",
    args: [market],
  });
  const f = first.rows[0]?.f;
  if (typeof f === "string" && f > cut) {
    cut = f;
    basis = "golive";
  }
  const r = await db.execute({
    sql: `SELECT p.angle_id, p.status FROM angle_passport p
          WHERE p.market = ? AND p.frozen_at <= ?
            AND p.version = (SELECT MAX(q.version) FROM angle_passport q
                             WHERE q.market = p.market AND q.angle_id = p.angle_id AND q.frozen_at <= ?)
          ORDER BY p.angle_id`,
    args: [market, cut, cut],
  });
  return {
    statuses: new Map(r.rows.map((x) => [String(x.angle_id), String(x.status) as AngleStatus])),
    basis,
  };
}

/** The fixed Cortex's features of the evening of d as a FeatureNight (null when it abstained). */
export function featureNightOf(
  out: {
    readonly features: ReadonlyMap<string, ReadonlyMap<string, unknown>>;
    readonly activeSetHash: string;
    readonly manifest: { readonly manifestId: string };
  },
  d: string,
): FeatureNight | null {
  if (out.features.size === 0) return null;
  return {
    d,
    rows: [...out.features.entries()].map(([code, m]) => ({
      code,
      features: Object.fromEntries(m),
      activeSetHash: out.activeSetHash,
      manifestId: out.manifest.manifestId,
    })),
  };
}

/** D-1083: counts of why a Cortex night gave no features (counts and statuses only, no data). */
export type CortexTally = {
  /** Nights asked for. */
  nights: number;
  /** Nights whose session is not in the snapshot. */
  noSession: number;
  /** Nights with no frozen passport statuses. */
  noPassports: number;
  /** Nights that gave features. */
  featured: number;
  /** Nights the Cortex ran but gave no features or abstained: reason (or "no_features") to count. */
  abstained: Map<string, number>;
};

export const newCortexTally = (): CortexTally => ({
  nights: 0,
  noSession: 0,
  noPassports: 0,
  featured: 0,
  abstained: new Map(),
});

/** `featureNightOf` that also tallies the outcome; what it returns is unchanged. */
export function featureNightTallied(
  out: Parameters<typeof featureNightOf>[0] & { readonly reason: string | null },
  d: string,
  tally: CortexTally,
): FeatureNight | null {
  const night = featureNightOf(out, d);
  if (night !== null) tally.featured += 1;
  else {
    const why = out.reason ?? "no_features";
    tally.abstained.set(why, (tally.abstained.get(why) ?? 0) + 1);
  }
  return night;
}

/** `reason:count` pairs, sorted by reason; "none" when empty. */
export function histogramText(h: ReadonlyMap<string, number>): string {
  return h.size === 0
    ? "none"
    : [...h]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([k, v]) => `${k}:${v}`)
        .join(",");
}

export type ReplayProgress = (done: number, total: number) => void;

/** Replay every night (sequential, deterministic order); a night without a scorable day is skipped. */
export async function replayNightsScored(
  deps: PickReplayDeps,
  n: number,
  progress?: ReplayProgress,
): Promise<{ days: DayResult[]; nights: string[]; cortex: CortexTally }> {
  const { world } = deps;
  const nights = replayNights(world.sessions, n);
  const tally = newCortexTally();
  // D-1082: bar-derived tiers from the first night (less the lookback) on, not the whole history
  const fromD = nights.length === 0 ? undefined : cortexTierFrom(world.sessions, nights[0]!);
  const opened = await openReplay(deps);
  // one Cortex replay per distinct angle set (the set only changes when a passport version is frozen)
  const cortexBy = new Map<string, CortexReplay>();
  const cortexOf = (passports: Map<string, AngleStatus>): CortexReplay => {
    const key = JSON.stringify([...passports]);
    let c = cortexBy.get(key);
    if (c === undefined) {
      c = createCortexReplay({
        world,
        params: opened.live,
        passports,
        schemaSha: SCHEMA_SHA,
        ...(fromD === undefined ? {} : { fromD }),
      });
      cortexBy.set(key, c);
    }
    return c;
  };
  const days: DayResult[] = [];
  let done = 0;
  for (const d of nights) {
    const nd = world.sessions[world.sessions.indexOf(d) + 1]!;
    const picks = await picksAsOf(deps, opened, d);
    const { statuses: passports, basis } = await passportsAsOf(deps.db, opened.market, d);
    tally.nights += 1;
    let night: FeatureNight | null = null;
    if (passports.size === 0) tally.noPassports += 1;
    else night = featureNightTallied(cortexOf(passports).hook.night(d, []), d, tally);
    const day = scoreNight(deps, d, nd, picks, night, basis);
    if (day !== null) days.push(day);
    done += 1;
    progress?.(done, nights.length);
  }
  return { days, nights, cortex: tally };
}
