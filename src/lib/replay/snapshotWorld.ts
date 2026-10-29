// Snapshot-backed replay source (M4 T16, D-095 draft): a `CohortReplaySource` (and so a
// `LedgerSource`) over one loaded replay snapshot (DAT-140). Bars are the snapshot's RAW bars;
// indicator facts are built per (code, session) from the last `barsNeeded` raw bars adjusted by the
// confirmed splits with ex-date <= that session (DAT-126), exactly as the live batch builds them
// (`LiveWorld`), and only from data up to the session. The benchmark regime is the A3 series over the
// snapshot's index bars. The snapshot carries no event rows, short-interest or insider history, so
// the world reports no event coverage and both sources off: F4 runs as its "no event filter"
// variant, and the event/short-interest families output BLOCKED-DATA until those inputs exist
// (ARN-082 labels this). No clock, no randomness.
import { AU_TIME_ZONE, decisionCutoffUtc, type ViewBar } from "@/lib/agents/decisionView";
import { addDays, marketDate } from "@/lib/data/calendar";
import { announcementIngestBound } from "@/lib/sentinel/cutoffPoll";
import {
  adjustBars,
  barsNeeded,
  splitActionsByCode,
  splitsKnownOn,
  withReferenceData,
} from "@/lib/agents/candidates";
import {
  buildCodeFacts,
  type CodeFacts,
  type FamilyInputs,
  type IndexChangeFact,
  type Tier,
} from "@/lib/agents/families";
import { logReturns, microToFloat, stdevFloat, volumeRatio } from "@/lib/agents/indicators";
import type { AgentParams } from "@/lib/agents/params";
import { regimeSeries, type RegimeLabel } from "@/lib/agents/regime";
import type { CorpActionRecord } from "@/lib/arena/corpActions";
import { assignTiers, TIER_RULES } from "@/lib/data/universe/tiers.mjs";
import { toMicroFromVendor } from "@/lib/money/micro";
import { floorRat } from "@/lib/money/round";
import type { PoolCode } from "./controlLibrary";
import type { CohortReplaySource } from "./cohortReplay";
import type { PositionFacts } from "./returns";
import { loadSnapshot, type SnapshotAnnouncement } from "./snapshot";

type LoadedSnapshot = ReturnType<typeof loadSnapshot>;

const MAX_SPLIT_DENOM = 20; // threshold-ok: search bound for a small-integer split ratio
const RATIO_EPS = 1e-9; // threshold-ok: numeric-stability epsilon
const RATIO_LOOKBACK = 4; // threshold-ok: last five sessions of volume ratios, as in agents/forwardLedger

type UniverseRow = { d: string; code: string; tier: Tier; halted: number };
type IndexRow = { index_code: string; d: string; c_micro: number };
type IndustryRow = { code: string; industry: string; source: string; as_of: string };
type IndexChangeRow = {
  code: string;
  index_name: string;
  kind: "add" | "delete";
  announced: string | null;
  effective: string;
};

/** price factor (<1 for a split) -> shares-per-share ratio as a small integer pair, or null. */
export function ratioPayload(type: string, factor: number): { new: number; old: number } | null {
  if (!(factor > 0)) return null;
  const inv = 1 / factor; // shares after per share before
  for (let old = 1; old <= MAX_SPLIT_DENOM; old += 1) {
    const nw = Math.round(inv * old);
    if (nw >= 1 && Math.abs(nw / old - inv) < RATIO_EPS) {
      if (type === "bonus_issue") return nw > old ? { new: nw - old, old } : null;
      return { new: nw, old };
    }
  }
  return null;
}

/** Confirmed quantity-changing actions of the snapshot as arena records (others are not replayed). */
export function corpRecordsOf(snap: LoadedSnapshot): CorpActionRecord[] {
  const out: CorpActionRecord[] = [];
  for (const a of snap.corporateActions) {
    if (a.type !== "split" && a.type !== "consolidation" && a.type !== "bonus_issue") continue;
    const p = ratioPayload(a.type, a.factor);
    if (p === null) continue;
    out.push({
      id: `snap:${a.code}:${a.ex_date}:${a.action_id}`,
      code: a.code,
      type: a.type,
      exDate: a.ex_date,
      payload: p,
      knownAt: a.known_at ?? null,
    });
  }
  return out;
}

/**
 * GL-05: is the announcement usable by the decision it belongs to? That is the session whose cut-off
 * follows its publication (the same day before the cut-off, else the next day). A row without
 * first_ingested_at is legacy and always visible. The bound is the live rule: the day's stored marker
 * when it lies in [cut-off, cut-off + 4 min], else cut-off + 4 min.
 */
export function snapshotAnnouncementVisible(
  a: SnapshotAnnouncement,
  markers: ReadonlyMap<string, string>,
  decisionCutoffHhmm: string,
): boolean {
  if (a.first_ingested_at === null || a.first_ingested_at === undefined) return true;
  let day = marketDate(new Date(a.published_at), AU_TIME_ZONE);
  if (a.published_at >= decisionCutoffUtc(day, decisionCutoffHhmm)) day = addDays(day, 1);
  const bound = announcementIngestBound(
    markers.get(day) ?? null,
    decisionCutoffUtc(day, decisionCutoffHhmm),
  );
  return a.first_ingested_at <= bound;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * D-185: facts memoised per session, keeping only the most recent sessions. Every pass (ledger,
 * cohorts, controls) walks forward day by day, so recent days hold almost every hit. An unbounded
 * memo held about 2,000 codes x 1,800 sessions of facts and ran the heap out on the 2020-2026
 * history. A miss only recomputes the same pure facts; results never change.
 */
const MEMO_SESSIONS = 8; // threshold-ok: memo window in sessions (memory bound, not a rule)

class DayMemo<T> {
  private readonly days = new Map<string, Map<string, T>>();
  get(d: string, code: string): T | undefined {
    return this.days.get(d)?.get(code);
  }
  set(d: string, code: string, value: T): void {
    let day = this.days.get(d);
    if (day === undefined) {
      if (this.days.size >= MEMO_SESSIONS) {
        const oldest = this.days.keys().next().value as string;
        this.days.delete(oldest);
      }
      day = new Map();
      this.days.set(d, day);
    }
    day.set(code, value);
  }
}

export type SnapshotWorldOptions = {
  readonly params: AgentParams;
  readonly market?: string;
  /** Benchmark index code of the regime classifier (default: the first index in the snapshot). */
  readonly indexCode?: string;
  /**
   * D-189: "bars" computes the ARN-010 tiers of every session from the bars before it (the replay
   * runner); "snapshot" (default) reads them from the universe rows (test worlds set them directly).
   */
  readonly tierSource?: "bars" | "snapshot";
};

export class SnapshotWorld implements CohortReplaySource {
  readonly sessions: readonly string[];
  readonly market: string;
  readonly sha: string;
  readonly firstBarD: string | null;
  private readonly index = new Map<string, number>();
  private readonly bars = new Map<string, ViewBar[]>();
  private readonly barIdx = new Map<string, Map<string, number>>();
  private readonly tiers = new Map<string, UniverseRow[]>();
  private readonly splits: ReturnType<typeof splitActionsByCode>["byCode"];
  private readonly actions: CorpActionRecord[];
  private readonly regime = new Map<string, RegimeLabel>();
  private readonly memo = new DayMemo<CodeFacts>();
  private readonly pfMemo = new DayMemo<PositionFacts | null>();
  private readonly tierDays = new Map<
    string,
    ReadonlyMap<string, { tier: Tier; active: boolean }>
  >();
  private readonly need: number;
  /** FAM-006: industry rows by code (finer manual class and the ASX group), oldest as_of first. */
  private readonly industries = new Map<string, IndustryRow[]>();
  /** DAT-234: index changes by code, oldest effective date first. */
  private readonly indexChanges = new Map<string, IndexChangeFact[]>();
  readonly codes: readonly string[];
  /** Announcement days of the snapshot (DAT-125 list input). */
  readonly announcements: readonly { readonly code: string; readonly d: string }[];
  /** Delisting dates by code, from the confirmed corporate actions of type `delisting`. */
  readonly delistings: ReadonlyMap<string, string>;

  constructor(
    snap: LoadedSnapshot,
    private readonly o: SnapshotWorldOptions,
  ) {
    this.market = o.market ?? "AU";
    this.sha = snap.sha;
    this.sessions = (snap.tables.calendar as unknown as { d: string; kind: string }[])
      .filter((r) => r.kind === "session" || r.kind === "early_close")
      .map((r) => r.d)
      .sort(cmp);
    this.sessions.forEach((d, i) => this.index.set(d, i));
    for (const b of snap.bars) {
      let list = this.bars.get(b.code);
      if (list === undefined) this.bars.set(b.code, (list = []));
      list.push({
        d: b.d,
        open: toMicroFromVendor(b.o),
        high: toMicroFromVendor(b.h),
        low: toMicroFromVendor(b.l),
        close: toMicroFromVendor(b.c),
        volume: BigInt(b.volume),
      });
    }
    let first: string | null = null;
    for (const [code, list] of this.bars) {
      list.sort((a, b) => cmp(a.d, b.d));
      this.barIdx.set(code, new Map(list.map((b, i) => [b.d, i])));
      if (first === null || list[0]!.d < first) first = list[0]!.d;
    }
    this.firstBarD = first;
    this.codes = [...this.bars.keys()].sort(cmp);
    for (const r of snap.tables.universe as unknown as UniverseRow[]) {
      let list = this.tiers.get(r.code);
      if (list === undefined) this.tiers.set(r.code, (list = []));
      list.push(r);
    }
    for (const l of this.tiers.values()) l.sort((a, b) => cmp(a.d, b.d));
    // GL-05: an announcement first stored after the bound live had for its deciding session is not
    // used (the stored marker of that day, else cut-off + 4 min); rows without first_ingested_at stay.
    const markers = new Map(
      ((snap.tables.cutoff_polls ?? []) as unknown as { d: string; at: string }[]).map((m) => [
        m.d,
        m.at,
      ]),
    );
    this.announcements = (snap.tables.announcements as unknown as SnapshotAnnouncement[])
      .filter((a) => snapshotAnnouncementVisible(a, markers, o.params.decisionCutoff))
      .map((a) => ({ code: a.code, d: a.published_at.slice(0, 10) })); // threshold-ok: ISO date prefix length
    const dl = new Map<string, string>();
    for (const a of snap.corporateActions) {
      if (a.type === "delisting" && (dl.get(a.code) ?? "9999") > a.ex_date)
        dl.set(a.code, a.ex_date);
    }
    this.delistings = dl;
    this.actions = corpRecordsOf(snap);
    this.splits = splitActionsByCode(this.actions).byCode;
    this.need = barsNeeded(o.params);
    // reference data (older snapshots have neither table: they read as empty, v1 behaviour)
    for (const r of (snap.tables.industry ?? []) as unknown as IndustryRow[]) {
      const list = this.industries.get(r.code);
      if (list === undefined) this.industries.set(r.code, [r]);
      else list.push(r);
    }
    for (const list of this.industries.values()) list.sort((a, b) => cmp(a.as_of, b.as_of));
    for (const r of (snap.tables.index_changes ?? []) as unknown as IndexChangeRow[]) {
      const fact: IndexChangeFact = {
        indexName: r.index_name,
        kind: r.kind,
        announced: r.announced,
        effective: r.effective,
      };
      const list = this.indexChanges.get(r.code);
      if (list === undefined) this.indexChanges.set(r.code, [fact]);
      else list.push(fact);
    }
    for (const list of this.indexChanges.values()) {
      list.sort((a, b) => cmp(a.effective, b.effective) || cmp(a.indexName, b.indexName));
    }
    this.buildRegime(snap.tables.index_bars as unknown as IndexRow[]);
  }

  private buildRegime(rows: IndexRow[]): void {
    if (rows.length === 0) return;
    const code = this.o.indexCode ?? rows[0]!.index_code;
    const mine = rows.filter((r) => r.index_code === code).sort((a, b) => cmp(a.d, b.d));
    const res = regimeSeries(
      mine.map((r) => BigInt(r.c_micro)),
      this.o.params,
    );
    mine.forEach((r, i) => this.regime.set(r.d, res[i]!.state));
  }

  /** D-189: the ARN-010 tiers of session `d` from the bars of the 60 sessions before it. */
  private tiersAt(d: string): ReadonlyMap<string, { tier: Tier; active: boolean }> {
    const hit = this.tierDays.get(d);
    if (hit !== undefined) return hit;
    const idx = this.index.get(d);
    const from =
      idx === undefined ? d : this.sessions[Math.max(0, idx - TIER_RULES.windowSessions)]!;
    const rows = this.codes.map((code) => {
      const list = this.bars.get(code)!;
      // bars strictly before d, from the window start
      let lo = 0;
      let hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid]!.d < d) lo = mid + 1;
        else hi = mid;
      }
      const traded: bigint[] = [];
      for (let j = lo - 1; j >= 0 && list[j]!.d >= from; j -= 1) {
        traded.push(list[j]!.close * list[j]!.volume);
      }
      return {
        code,
        priceMicro: lo > 0 ? list[lo - 1]!.close : 0n,
        tradedMicro: traded,
        listedSince: list.length > 0 ? list[0]!.d : null,
        mcapMicro: null,
      };
    });
    const out = new Map<string, { tier: Tier; active: boolean }>();
    for (const [code, t] of assignTiers(rows, d)) {
      out.set(code, { tier: t.tier as Tier, active: t.status === "active" });
    }
    if (this.tierDays.size >= MEMO_SESSIONS) {
      this.tierDays.delete(this.tierDays.keys().next().value as string);
    }
    this.tierDays.set(d, out);
    return out;
  }

  /** False for a code below the U3 floor on `d` (bars tier source only): no family sees it. */
  private activeOn(code: string, d: string): boolean {
    return this.o.tierSource !== "bars" || (this.tiersAt(d).get(code)?.active ?? false);
  }

  private tierOn(code: string, d: string): { tier: Tier; halted: boolean } {
    if (this.o.tierSource === "bars") {
      const row = this.tiers.get(code)?.find((x) => x.d === d);
      return { tier: this.tiersAt(d).get(code)?.tier ?? "U3", halted: row?.halted === 1 };
    }
    const list = this.tiers.get(code);
    if (list === undefined) return { tier: "U1", halted: false };
    let lo = 0;
    let hi = list.length - 1;
    let hit = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]!.d <= d) {
        hit = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const r = hit >= 0 ? list[hit]! : list[0]!;
    return { tier: r.tier, halted: list[hit >= 0 ? hit : 0]!.d === d && r.halted === 1 };
  }

  corpActions(code: string): readonly CorpActionRecord[] {
    return this.actions.filter((a) => a.code === code);
  }

  bar(code: string, d: string): ViewBar | null {
    const i = this.barIdx.get(code)?.get(d);
    return i === undefined ? null : this.bars.get(code)![i]!;
  }

  /** The code's industry as of `d`: the newest manual class, else the ASX industry group. */
  private industryOn(code: string, d: string): string | null {
    const list = this.industries.get(code);
    if (list === undefined) return null;
    let cls: string | null = null;
    let grp: string | null = null;
    for (const r of list) {
      if (r.source === "class" && r.as_of <= d) cls = r.industry;
      if (r.source === "instrument") grp = r.industry;
    }
    return cls ?? grp;
  }

  private factsAt(code: string, i: number): CodeFacts {
    const d = this.bars.get(code)![i]!.d;
    let f = this.memo.get(d, code);
    if (f === undefined) {
      const raw = this.bars.get(code)!.slice(Math.max(0, i + 1 - this.need), i + 1);
      const known = splitsKnownOn(this.splits.get(code) ?? [], d, this.o.params.decisionCutoff);
      const { tier, halted } = this.tierOn(code, d);
      f = withReferenceData(
        buildCodeFacts(
          { code, tier, adjusted: adjustBars(raw, known), raw, halted },
          this.o.params,
        ),
        this.industryOn(code, d),
        this.indexChanges.get(code),
      );
      this.memo.set(d, code, f);
    }
    return f;
  }

  /** Codes with a bar on `d`, in code order, with their bar position. */
  private tradedOn(d: string): { code: string; i: number }[] {
    const out: { code: string; i: number }[] = [];
    for (const code of this.codes) {
      const i = this.barIdx.get(code)?.get(d);
      if (i !== undefined) out.push({ code, i });
    }
    return out;
  }

  positionFacts(code: string, d: string): PositionFacts | null {
    const hit = this.pfMemo.get(d, code);
    if (hit !== undefined) return hit;
    const i = this.barIdx.get(code)?.get(d);
    if (i === undefined) return null;
    const f = this.factsAt(code, i);
    const raw = this.bars.get(code)!.slice(Math.max(0, i + 1 - this.need), i + 1);
    const known = splitsKnownOn(this.splits.get(code) ?? [], d, this.o.params.decisionCutoff);
    const volumes = adjustBars(raw, known).map((b) => b.volume);
    const ratios = [];
    for (let j = RATIO_LOOKBACK; j >= 0; j -= 1) {
      ratios.push(
        volumeRatio(volumes.slice(0, volumes.length - j), this.o.params.windows.volumeRatio),
      );
    }
    const facts: PositionFacts = {
      atrMicro: f.ind.atrWarm ? f.ind.atrMicro : null,
      closeAboveExitSma: f.ind.closeAboveSmaShort,
      volumeRatios: ratios,
      events: [],
    };
    this.pfMemo.set(d, code, facts);
    return facts;
  }

  familyInputs(d: string): FamilyInputs {
    const idx = this.index.get(d);
    if (idx === undefined) throw new RangeError(`unknown session ${d}`);
    return {
      market: this.market,
      d,
      regime: this.regime.get(d) ?? "unknown",
      sessions: this.sessions.slice(0, idx + 1),
      sources: { asx: "off", asic: "off" },
      eventCoverage: false,
      codes: this.tradedOn(d)
        .filter(({ code }) => this.activeOn(code, d))
        .map(({ code, i }) => this.factsAt(code, i)),
      events: [],
    };
  }

  halted(code: string, d: string): boolean | null {
    const list = this.tiers.get(code);
    const r = list?.find((x) => x.d === d);
    return r === undefined ? null : r.halted === 1;
  }

  controlUniverse(d: string): readonly PoolCode[] {
    const traded = this.tradedOn(d).filter(({ code }) => this.activeOn(code, d));
    return traded.map(({ code, i }): PoolCode => {
      const f = this.factsAt(code, i);
      const closes = this.bars
        .get(code)!
        .slice(Math.max(0, i - 40), i + 1) // threshold-ok: pre-roll closes feeding the vol window (test-world fixture)
        .map((b) => microToFloat(b.close));
      return {
        code,
        tier: f.tier,
        vol20: stdevFloat(logReturns(closes), this.o.params.windows.vol, 1),
        atrMicro: f.ind.atrMicro,
        advMicro: f.ind.adv === null ? 0n : floorRat(f.ind.adv),
        eligible: f.tier === "U1" && f.ind.atrWarm && !f.halted,
      };
    });
  }
}
