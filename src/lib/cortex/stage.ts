// The Cortex nightly stage (M15 P2; docs/M15_design.md 2 "P2", 3, 3a, 3c "Live hook"; D-265, D-266,
// D-280, D-281, D-289, D-307, D-321, D-332, D-336). Batch 2b calls `cortexStage` once per night after
// the v1 rule interpreter (`runVersions`) and before the cohort loop:
//
//   loadStageRows      DB reads -> plain rows (bars, tiers, indexes, shorts, events, corporate actions
//                      with provenance, index changes, industry, halts)
//   worldFromRows      PURE: rows -> `AsOfWorld`
//   buildNightInputs   PURE: world view + store reads + books -> `NightInputs`
//   runNight           the pure core (src/lib/cortex/night.ts)
//   persistNight       night, manifest, features, abstain, shadow and blocked decisions (one write)
//
// The LIVE-arm decision rows are written by `persistLiveDecisions` AFTER the cohort loop, once batch 2b
// knows which decisions became orders (the tables are append-only, so the signal, card and order links
// cannot be added later). Batch 3 scores would-have outcomes with `scoreOutcomes`.
//
// V1 stays unchanged while every family is `shadow` (D-280/D-281): the stage only WRITES cortex_* rows.
// The data window the live world carries is bounded (`STAGE_BAR_SESSIONS` raw sessions per code,
// `STAGE_INDEX_DAYS` calendar days of index closes) so a night reads a bounded amount of history.
import type { Client } from "@libsql/client";
import { eventRowOf } from "@/lib/agents/candidates";
import type { IndexViewBar, ViewBar } from "@/lib/agents/decisionView";
import { decisionCutoffUtc } from "@/lib/agents/decisionView";
import { eventFactFromRow } from "@/lib/agents/families/facts";
import type { Family, RegimeLabel, StopSpec, Tier } from "@/lib/agents/families/types";
import { loadAgentParams, type AgentParams } from "@/lib/agents/params";
import { controlStates } from "@/lib/agents/controls";
import type { LimitFillOutcome } from "@/lib/arena/fills";
import { cardIdOf } from "@/lib/agents/cards";
import { assertBar } from "@/lib/arena/fills";
import { COST_PROFILES } from "@/lib/arena/costs";
import { carriesSleeve, parseCohortParams, sha256Hex, type CohortParams } from "@/lib/arena/cohort";
import { loadExecutions, loadUnresolvedCohorts } from "@/lib/arena/cohortWriter";
import type { CorpActionRecord } from "@/lib/arena/corpActions";
import {
  balancesFromRows,
  pendingSettlements,
  type LedgerFill,
  type QtyAdjustment,
} from "@/lib/arena/ledger";
import { loadLedgerFills, loadLedgerRows, toBig } from "@/lib/arena/ledgerWriter";
import { loadQtyAdjustments } from "@/lib/arena/corpActionWriter";
import { derivePositions } from "@/lib/arena/nav";
import { priceMicro } from "@/lib/arena/marketData";
import { addDays, sessionsBetween, type CalendarRow } from "@/lib/data/calendar";
import { parseNote, stateOf } from "@/lib/data/corporateActions/rules.mjs";
import type { Micro } from "@/lib/money/micro";
import { scopedPrng } from "@/lib/stats/rng";
import type { CellStatistic } from "@/lib/stats/cells";
import type { AngleDef, AngleStatus } from "./angles/types";
import {
  atr20Micro,
  familyPlan,
  wouldHaveOutcome,
  type BookState,
  type Decision,
  type FamilyNightRule,
  type FamilyStatusMap,
  type NightInputs,
  type NightOutput,
  type StateRef,
} from "./night";
import { runNight } from "./night";
import { buildAsOfView } from "./pit/asOfView";
import type {
  AsOfView,
  AsOfWorld,
  EventRow,
  HaltRow,
  IndexChangeRow,
  IndexCode,
  IndustryRow,
  InputKind,
  ShortPoint,
  TierRow,
} from "./pit/types";
import { openTimeChecks } from "./gates/openTime";
import type { OpenId, OpenTraceEntry } from "./gates/types";
import type { CortexMap } from "./score/types";
import type {
  CandidateSource,
  CorpActionProvenance,
  CorpActionStatus,
  CortexCorpAction,
} from "./states/types";
import {
  CORTEX_FAMILIES,
  cellsOfKind,
  familyStatusMap,
  insertAbstain,
  insertDecisions,
  insertFeatureRows,
  insertManifest,
  insertNight,
  insertOutcome,
  latestMaps,
  latestPassports,
  statesInForce,
  unscoredDecisions,
  type CortexFamily,
  type DecisionRow,
  type FeatureRow,
  type MapRow,
  type PassportRow,
} from "./store";

// ---- constants --------------------------------------------------------------------------------------

/** Raw sessions of bars per code the live world carries (angles' longest warm-up is about 312, D-325). */
export const STAGE_BAR_SESSIONS = 420; // threshold-ok: bounded read window, not a rule
/** Calendar days of index closes (regime needs 1,281 closes). */
export const STAGE_INDEX_DAYS = 2100; // threshold-ok: bounded read window, not a rule
/** Calendar days of ASIC short-interest points. */
export const STAGE_SHORT_DAYS = 400; // threshold-ok: bounded read window, not a rule
/** Ledger cell kind that carries a matched-setup `CellStatistic` as its result (the import writes it). */
export const MATCHED_CELL_KIND = "matched_cell";
/** `signal.variant` of every Cortex signal (design 3 note). */
export const CORTEX_VARIANT = "cortex";

const INDEX_CODE_LIST: readonly IndexCode[] = ["AXJO", "GSPC", "VIX"];
const V1_FAMILIES: readonly Family[] = ["F1", "F2", "F3", "F4", "F5", "F6"];
/** The v1 live universe tiers of each family (rankScore.ts FAMILY_TIERS; F5 on U2/U3 with ARN-011). */
export const DEFAULT_FAMILY_TIERS: Readonly<Record<Family, readonly Tier[]>> = {
  F1: ["U1"],
  F2: ["U1", "U2"],
  F3: ["U1", "U2"],
  F4: ["U1"],
  F5: ["U2", "U3"],
  F6: ["U1", "U2"],
};

const text = (v: unknown): string => String(v);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const isV1Family = (f: string): f is Family => (V1_FAMILIES as readonly string[]).includes(f);

// ---- ids (deterministic; batch 2b and the tests use the same functions) -----------------------------------

/** `signal.rule_version` of a Cortex signal (design 3 note). */
export const cortexRuleVersion = (family: Family, mapRuleVersion: string): string =>
  `${family}.cortex.${mapRuleVersion}`;

export const cortexSignalId = (
  market: string,
  d: string,
  family: Family,
  ruleVersion: string,
  code: string,
): string => `sig:${market}:${d}:${family}:${ruleVersion}:${CORTEX_VARIANT}:${code}`;

/** The v1 entry order id (batch2b `entryOrderId`; a test asserts they agree). */
export const cortexOrderId = (cohortId: string, d: string, code: string): string =>
  `EN:${cohortId}:${d}:${code}`;

export { cardIdOf };

// ---- corporate-action provenance (D-321) -------------------------------------------------------------------

export type ActionRow = {
  readonly id: string;
  readonly code: string;
  readonly type: string;
  readonly exDate: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** `corporate_action.known_at` (GL-02): set once at confirmation. */
  readonly knownAt: string | null;
  /** `corporate_action.evidence_json` parsed (`{sources: [{src, ref}]}`), or null. */
  readonly evidence: unknown;
};
export type ActionEventRow = {
  readonly actionId: string;
  /** `corporate_action_event.at`. */
  readonly at: string;
  readonly status: string;
  readonly note: string | null;
};

const isSource = (s: unknown): s is CandidateSource =>
  s === "announcement" || s === "vendor" || s === "price";

/**
 * D-321 producer: one `CortexCorpAction` per action row. `sources` = evidence_json sources plus every
 * `add_source` note; `status` from the newest event (queued pending/owner/blocked and an action with
 * no event read `pending`); the action is known at the FIRST event for a pending row (first
 * ingestion) and at `known_at` for a confirmed one (null = known since before the column, the view
 * then applies the ex-date rule). A vendor-only confirmed row therefore carries sources ["vendor"],
 * which the state machine never re-bases on.
 */
export function corpActionsWithProvenance(
  actions: readonly ActionRow[],
  events: readonly ActionEventRow[],
): CortexCorpAction[] {
  const byAction = new Map<string, ActionEventRow[]>();
  for (const e of events) {
    const list = byAction.get(e.actionId) ?? [];
    list.push(e);
    byAction.set(e.actionId, list);
  }
  const out: CortexCorpAction[] = [];
  for (const a of actions) {
    const evs = byAction.get(a.id) ?? [];
    const sources = new Set<CandidateSource>();
    const ev = a.evidence as { sources?: unknown } | null;
    if (ev !== null && typeof ev === "object" && Array.isArray(ev.sources)) {
      for (const s of ev.sources) {
        const src = (s as { src?: unknown } | null)?.src;
        if (isSource(src)) sources.add(src);
      }
    }
    for (const e of evs) {
      const added = (parseNote(e.note) as { add_source?: { src?: unknown } }).add_source;
      if (added !== undefined && added !== null && isSource(added.src)) sources.add(added.src);
    }
    const latest = evs.length === 0 ? null : evs[evs.length - 1]!;
    const state = stateOf(latest === null ? null : { status: latest.status, note: latest.note });
    const status: CorpActionStatus =
      state.state === "confirmed"
        ? "confirmed"
        : state.state === "reversed"
          ? "reversed"
          : state.state === "rejected"
            ? "rejected"
            : "pending";
    const knownAt = status === "pending" ? (evs.length === 0 ? null : evs[0]!.at) : a.knownAt;
    const provenance: CorpActionProvenance = { sources: [...sources].sort(), status };
    out.push({
      id: a.id,
      code: a.code,
      type: a.type,
      exDate: a.exDate,
      payload: a.payload,
      knownAt,
      ...provenance,
    });
  }
  return out;
}

// ---- rows read from the database ------------------------------------------------------------------------------

export type StageRows = {
  readonly sessions: readonly string[];
  readonly bars: ReadonlyMap<string, readonly ViewBar[]>;
  readonly tiers: ReadonlyMap<string, readonly TierRow[]>;
  readonly halts: ReadonlyMap<string, readonly HaltRow[]>;
  readonly index: Partial<Record<IndexCode, readonly IndexViewBar[]>>;
  readonly shorts: ReadonlyMap<string, readonly ShortPoint[]>;
  readonly events: ReadonlyMap<string, readonly EventRow[]>;
  readonly corpActions: ReadonlyMap<string, readonly CorpActionRecord[]>;
  /** null = the DAT-234 list was never loaded (G08 fails closed). */
  readonly indexChanges: ReadonlyMap<string, readonly IndexChangeRow[]> | null;
  readonly industry: ReadonlyMap<string, readonly IndustryRow[]>;
  readonly schemaSha: string;
};

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k);
  if (list === undefined) m.set(k, [v]);
  else list.push(v);
}

/** PURE: rows -> the world the as-of view is built from. */
export function worldFromRows(
  rows: StageRows,
  o: { market: string; cutoffHhmm: string; calendar: readonly CalendarRow[]; params: AgentParams },
): AsOfWorld {
  return {
    market: o.market,
    sessions: rows.sessions,
    cutoffHhmm: o.cutoffHhmm,
    calendar: o.calendar,
    schemaSha: rows.schemaSha,
    bars: rows.bars,
    tiers: rows.tiers,
    index: rows.index,
    shorts: rows.shorts,
    events: rows.events,
    corpActions: rows.corpActions,
    indexChanges: rows.indexChanges,
    industry: rows.industry,
    halts: rows.halts,
    regimeParams: o.params,
  };
}

export type LoadOptions = {
  readonly market: string;
  readonly d: string;
  readonly params: AgentParams;
  readonly calendar: readonly CalendarRow[];
  /** Live runs: a bar ingested after the cut-off does not exist for the night (decisionView). */
  readonly liveIngestBound: boolean;
  readonly heldCodes: readonly string[];
};

const MIN_CALENDAR_SPAN_DAYS = 14; // threshold-ok: slack before the first session

export async function loadStageRows(db: Client, o: LoadOptions): Promise<StageRows> {
  const { market, d } = o;
  const cutoff = decisionCutoffUtc(d, o.params.decisionCutoff);
  const span = Math.ceil((STAGE_BAR_SESSIONS * 7) / 5) + MIN_CALENDAR_SPAN_DAYS; // threshold-ok: weekdays to days
  const all = sessionsBetween(addDays(d, -span), d, o.calendar);
  const sessions = all.slice(-STAGE_BAR_SESSIONS);
  const first = sessions[0] ?? d;

  // universe rows (tier and halt flag per session, kept as change points)
  const uni = await db.execute({
    sql: `SELECT code, d, tier, halted FROM universe_snapshot
          WHERE market = ? AND d >= ? AND d <= ? AND status = 'active' ORDER BY code, d`,
    args: [market, first, d],
  });
  const tiers = new Map<string, TierRow[]>();
  const halts = new Map<string, HaltRow[]>();
  const lastTier = new Map<string, string>();
  const lastHalt = new Map<string, boolean>();
  const onD = new Set<string>();
  for (const r of uni.rows) {
    const code = text(r.code);
    const tier = text(r.tier);
    const halted = toBig(r.halted) === 1n;
    if (text(r.d) === d) onD.add(code);
    if (lastTier.get(code) !== tier) {
      push(tiers, code, { d: text(r.d), tier: tier as Tier });
      lastTier.set(code, tier);
    }
    if (lastHalt.get(code) !== halted) {
      push(halts, code, { d: text(r.d), halted });
      lastHalt.set(code, halted);
    }
  }
  const wanted = new Set<string>([...onD, ...o.heldCodes]);

  // bars
  const barArgs: (string | number)[] = [market, first, d];
  if (o.liveIngestBound) barArgs.push(cutoff);
  const barRs = await db.execute({
    sql: `SELECT code, d, o, h, l, c, volume FROM price_bar
          WHERE market = ? AND d >= ? AND d <= ?${o.liveIngestBound ? " AND ingested_at <= ?" : ""}
          ORDER BY code, d`,
    args: barArgs,
  });
  const bars = new Map<string, ViewBar[]>();
  for (const r of barRs.rows) {
    const code = text(r.code);
    if (!wanted.has(code)) continue;
    const bar: ViewBar = {
      d: text(r.d),
      open: priceMicro(r.o),
      high: priceMicro(r.h),
      low: priceMicro(r.l),
      close: priceMicro(r.c),
      volume: toBig(r.volume),
    };
    try {
      assertBar({
        openMicro: bar.open,
        highMicro: bar.high,
        lowMicro: bar.low,
        closeMicro: bar.close,
      });
    } catch {
      continue; // a malformed bar is unusable evidence (DAT-200 flags it)
    }
    push(bars, code, bar);
  }

  // indexes (AXJO is bounded by its publication; the US closes by the index_us rule in the view)
  const idxRs = await db.execute({
    sql: `SELECT index_code, d, c_micro, published_at FROM index_bar
          WHERE market = ? AND d >= ? AND d <= ? ORDER BY index_code, d`,
    args: [market, addDays(d, -STAGE_INDEX_DAYS), d],
  });
  const index: Partial<Record<IndexCode, IndexViewBar[]>> = {};
  for (const r of idxRs.rows) {
    const code = text(r.index_code) as IndexCode;
    if (!INDEX_CODE_LIST.includes(code)) continue;
    if (code === "AXJO" && !(text(r.published_at) < cutoff)) continue;
    (index[code] ??= []).push({ d: text(r.d), close: toBig(r.c_micro) });
  }

  // ASIC short interest
  const shortRs = await db.execute({
    sql: `SELECT code, as_of, short_ppm FROM short_interest
          WHERE market = ? AND as_of <= ? AND as_of >= ? AND published_at < ? ORDER BY code, as_of`,
    args: [market, d, addDays(d, -STAGE_SHORT_DAYS), cutoff],
  });
  const shorts = new Map<string, ShortPoint[]>();
  for (const r of shortRs.rows) {
    if (!wanted.has(text(r.code))) continue;
    push(shorts, text(r.code), { asOf: text(r.as_of), ppm: Number(r.short_ppm) });
  }

  // events (day 0 <= D, published before the cut-off), with the instant they were published
  const evRs = await db.execute({
    sql: `SELECT * FROM event WHERE market = ? AND day0_d >= ? AND day0_d <= ? AND published_at < ?
          ORDER BY code, day0_d, source, ann_id`,
    args: [market, first, d, cutoff],
  });
  const events = new Map<string, EventRow[]>();
  for (const r of evRs.rows) {
    const row = eventRowOf(r as Record<string, unknown>);
    if (!wanted.has(row.code)) continue;
    const day0 = (bars.get(row.code) ?? []).find((b) => b.d === row.day0_d);
    push(events, row.code, {
      ...eventFactFromRow(row, day0 === undefined ? null : day0.low),
      publishedAt: row.published_at,
    });
  }

  // corporate actions with provenance (D-321)
  const caRs = await db.execute({
    sql: `SELECT id, code, type, ex_date, payload_json, evidence_json, known_at FROM corporate_action
          WHERE market = ? AND ex_date >= ? ORDER BY id`,
    args: [market, addDays(first, -5)],
  });
  const evtRs = await db.execute({
    sql: `SELECT e.action_id, e.at, e.status, e.note FROM corporate_action_event e
          JOIN corporate_action a ON a.id = e.action_id WHERE a.market = ? ORDER BY e.id`,
    args: [market],
  });
  const actionRows: ActionRow[] = caRs.rows.map((a) => {
    let payload: unknown = {};
    try {
      payload = JSON.parse(text(a.payload_json));
    } catch {
      payload = {};
    }
    let evidence: unknown = null;
    try {
      evidence = a.evidence_json === null ? null : JSON.parse(text(a.evidence_json));
    } catch {
      evidence = null;
    }
    return {
      id: text(a.id),
      code: text(a.code),
      type: text(a.type),
      exDate: text(a.ex_date),
      payload:
        payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>) : {},
      knownAt: a.known_at === null || a.known_at === undefined ? null : text(a.known_at),
      evidence,
    };
  });
  const actionEvents: ActionEventRow[] = evtRs.rows.map((e) => ({
    actionId: text(e.action_id),
    at: text(e.at),
    status: text(e.status),
    note: e.note === null ? null : text(e.note),
  }));
  const corpActions = new Map<string, CortexCorpAction[]>();
  for (const a of corpActionsWithProvenance(actionRows, actionEvents)) push(corpActions, a.code, a);

  // DAT-234 index changes: absent list (no row at all) = null; a row counts once announced (else
  // effective) on or before D and loaded by the cut-off (D-285); known at its load instant
  const icCount = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM index_change WHERE market = ?",
    args: [market],
  });
  let indexChanges: Map<string, IndexChangeRow[]> | null = null;
  if (Number(icCount.rows[0]?.n ?? 0) > 0) {
    indexChanges = new Map();
    const icRs = await db.execute({
      sql: `SELECT code, index_name, kind, announced_d, effective_d,
                   strftime('%Y-%m-%dT%H:%M:%fZ', loaded_at) AS known_at
            FROM index_change
            WHERE market = ? AND COALESCE(announced_d, effective_d) <= ?
              AND strftime('%Y-%m-%dT%H:%M:%fZ', loaded_at) <= ?
            ORDER BY code, effective_d, index_name, kind`,
      args: [market, d, cutoff],
    });
    for (const r of icRs.rows) {
      push(indexChanges, text(r.code), {
        indexName: text(r.index_name),
        kind: text(r.kind) === "add" ? "add" : "delete",
        announced: r.announced_d === null ? null : text(r.announced_d),
        effective: text(r.effective_d),
        knownAt: r.known_at === null ? null : text(r.known_at),
      });
    }
  }

  // industry: the finer manual class (loaded by the cut-off) else the ASX group (D-285)
  const industry = new Map<string, IndustryRow[]>();
  const classRs = await db.execute({
    sql: `SELECT code, industry, as_of FROM instrument_class
          WHERE market = ? AND as_of <= ? AND strftime('%Y-%m-%dT%H:%M:%fZ', loaded_at) <= ?
          ORDER BY code, as_of`,
    args: [market, d, cutoff],
  });
  for (const r of classRs.rows) {
    push(industry, text(r.code), { asOf: text(r.as_of), industry: text(r.industry) });
  }
  const groupRs = await db.execute({
    sql: "SELECT code, industry FROM instrument WHERE market = ? AND industry IS NOT NULL",
    args: [market],
  });
  for (const r of groupRs.rows) {
    const code = text(r.code);
    if (!industry.has(code)) industry.set(code, [{ asOf: first, industry: text(r.industry) }]);
  }

  const names = await db.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  );
  const schemaSha = sha256Hex(names.rows.map((r) => text(r.name)).join(","));

  return {
    sessions,
    bars,
    tiers,
    halts,
    index,
    shorts,
    events,
    corpActions,
    indexChanges,
    industry,
    schemaSha,
  };
}

// ---- books (the 12 E cohorts) ----------------------------------------------------------------------------------

export async function loadBookStates(
  db: Client,
  o: { market: string; d: string; calendar: readonly CalendarRow[]; includeLeverage?: boolean },
): Promise<BookState[]> {
  const execs = new Map((await loadExecutions(db)).map((e) => [e.id, e] as const));
  const cohorts = (await loadUnresolvedCohorts(db, o.d))
    .filter((c) => c.live)
    .sort((a, b) => cmp(a.id, b.id));
  const out: BookState[] = [];
  for (const cohort of cohorts) {
    const exec = execs.get(cohort.executionId);
    if (exec === undefined || exec.kind !== "E" || exec.family === null) continue;
    if (!isV1Family(exec.family)) continue;
    if (o.includeLeverage !== true && carriesSleeve(exec)) continue; // D-191
    const nav = await db.execute({
      sql: "SELECT nav_micro, invariants_ok FROM nav_daily WHERE cohort_id = ? AND d = ?",
      args: [cohort.id, o.d],
    });
    if (nav.rows.length === 0 || toBig(nav.rows[0]!.invariants_ok) !== 1n) continue;
    const params: CohortParams = parseCohortParams(cohort.paramsJson);
    const [fills, adjustments, rows] = await Promise.all([
      loadLedgerFills(db, cohort.id),
      loadQtyAdjustments(db, cohort.id),
      loadLedgerRows(db, cohort.id),
    ]);
    const settled = new Set(
      rows.filter((r) => r.kind === "settle" && r.refType === "fill").map((r) => text(r.refId)),
    );
    const held = derivePositions(
      fills as LedgerFill[],
      adjustments as QtyAdjustment[],
      o.d,
    ).positions;
    const trades = await db.execute({
      sql: `SELECT t.code, t.stop_micro, f.value_micro, f.d,
                   (SELECT MAX(s.level_micro) FROM stop_level s WHERE s.trade_id = t.id AND s.d <= ?) AS lvl
            FROM trade t JOIN fill f ON f.id = t.entry_fill_id
            WHERE t.cohort_id = ? AND t.exit_type IS NULL ORDER BY t.code`,
      args: [o.d, cohort.id],
    });
    const positions = [...held.entries()]
      .filter(([, qty]) => qty > 0n)
      .map(([code, qty]) => {
        const tr = trades.rows.find((r) => text(r.code) === code);
        const stop =
          tr === undefined
            ? 0n
            : tr.lvl !== null && tr.lvl !== undefined
              ? toBig(tr.lvl)
              : toBig(tr.stop_micro);
        return {
          code,
          qty,
          costMicro: tr === undefined ? 0n : toBig(tr.value_micro),
          stopMicro: stop,
          entryD: tr === undefined ? o.d : text(tr.d),
        };
      });
    const navDays = await db.execute({
      sql: "SELECT COUNT(*) AS n FROM nav_daily WHERE cohort_id = ? AND d <= ?",
      args: [cohort.id, o.d],
    });
    out.push({
      bookId: cohort.id,
      family: exec.family as Family,
      executionId: exec.id,
      positions,
      settledCashMicro: balancesFromRows(rows, o.d).cash_settled,
      pending: pendingSettlements(fills as LedgerFill[], settled, o.calendar),
      navMicro: toBig(nav.rows[0]!.nav_micro),
      costProfile: COST_PROFILES[params.costProfile],
      sessionsSinceGoLive: Number(navDays.rows[0]?.n ?? 0),
    });
  }
  return out;
}

// ---- store reads -> night inputs --------------------------------------------------------------------------------

export type StoreReads = {
  readonly status: Readonly<Record<CortexFamily, "shadow" | "allowed" | "suspended">>;
  readonly maps: readonly MapRow[];
  readonly cellRows: readonly { readonly result: unknown }[];
  readonly passports: readonly PassportRow[];
  readonly states: readonly {
    code: string;
    kind: StateRef["kind"];
    state: string;
    basis: unknown;
  }[];
  readonly sourcesOff: ReadonlySet<InputKind>;
};

/** Sources switched off in `source_status` as the input kinds the Cortex names them (DAT-127). */
export async function loadSourcesOff(db: Client): Promise<ReadonlySet<InputKind>> {
  const src = await db.execute(
    "SELECT source, mode FROM source_status WHERE source IN ('asx_announcements', 'asic_short')",
  );
  const sourcesOff = new Set<InputKind>();
  for (const name of ["asx_announcements", "asic_short"]) {
    const row = src.rows.find((r) => text(r.source) === name);
    if (row === undefined || text(row.mode) !== "on") {
      sourcesOff.add(name === "asic_short" ? "asic_short" : "announcement");
    }
  }
  return sourcesOff;
}

export async function loadStoreReads(
  db: Client,
  o: { market: string; d: string },
): Promise<StoreReads> {
  const cellRows: { result: unknown }[] = [];
  for (const f of V1_FAMILIES) {
    for (const c of await cellsOfKind(db, o.market, f, MATCHED_CELL_KIND)) {
      if (c.result !== null && c.result !== undefined) cellRows.push({ result: c.result });
    }
  }
  const sourcesOff = await loadSourcesOff(db);
  return {
    status: await familyStatusMap(db, o.market, o.d),
    maps: await latestMaps(db, o.market),
    cellRows,
    passports: await latestPassports(db, o.market),
    states: (await statesInForce(db, o.market, o.d)).map((s) => ({
      code: s.code,
      kind: s.kind,
      state: s.state,
      basis: s.basis,
    })),
    sourcesOff,
  };
}

/** A matched cell stored as the result JSON of a ledger cell (numbers; NaN and Infinity arrive as text). */
function cellFromResult(result: unknown): CellStatistic | null {
  if (result === null || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  if (typeof r.cellKey !== "string") return null;
  const n = (v: unknown): number => {
    const x = typeof v === "string" ? Number(v) : (v as number);
    return Number.isFinite(x) ? x : Number.NaN;
  };
  return {
    ...(r as unknown as CellStatistic),
    n: n(r.n),
    blocks: n(r.blocks),
    nEff: r.nEff === undefined || r.nEff === null ? undefined : n(r.nEff),
    meanNet: n(r.meanNet),
    lower90: n(r.lower90),
    lReal: n(r.lReal),
    gap95: n(r.gap95),
    excludedUnfilledShare: n(r.excludedUnfilledShare),
  };
}

/** The newest map of each family (newest fit over all rule versions, as `currentMap`). */
function newestPerFamily(rows: readonly MapRow[]): Map<Family, MapRow> {
  const out = new Map<Family, MapRow>();
  for (const m of rows) {
    if (!isV1Family(m.family)) continue;
    const have = out.get(m.family);
    if (
      have === undefined ||
      m.fittedAt > have.fittedAt ||
      (m.fittedAt === have.fittedAt && m.ruleVersion > have.ruleVersion)
    ) {
      out.set(m.family, m);
    }
  }
  return out;
}

/**
 * The per-family night rule from the stored map (data of the import, D-281). Optional fields the
 * import may carry in `params_json`: `family_mean_net`, `tiers`, `top3_min_s`, `p_hidden`, `gain`,
 * `loss`, `slots`. A family without a map gets a rule with no clusters, so its candidates are
 * recorded as blocked rows at G04 `map_missing` (D-335).
 */
export function ruleFromMap(family: Family, map: MapRow | undefined): FamilyNightRule {
  if (map === undefined) {
    return {
      ruleVersion: `${family}.none`,
      clusters: [],
      familyMeanNet: 0,
      tiers: DEFAULT_FAMILY_TIERS[family],
    };
  }
  const p = map.params as unknown as Record<string, unknown>;
  const tiers = Array.isArray(p.tiers)
    ? (p.tiers.filter((t) => t === "U1" || t === "U2" || t === "U3") as Tier[])
    : DEFAULT_FAMILY_TIERS[family];
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const gain = num(p.gain);
  const loss = num(p.loss);
  const top3 = num(p.top3_min_s);
  const slots = num(p.slots);
  return {
    ruleVersion: map.ruleVersion,
    clusters: map.params.clusters as FamilyNightRule["clusters"],
    familyMeanNet: num(p.family_mean_net) ?? 0,
    tiers,
    ...(top3 === undefined ? {} : { top3MinS: top3 }),
    ...(p.p_hidden === true ? { pHidden: true } : {}),
    ...(gain !== undefined && loss !== undefined ? { gainLoss: { gain, loss } } : {}),
    ...(slots === undefined ? {} : { slots }),
  };
}

export type InputBuild = {
  readonly market: string;
  readonly d: string;
  readonly view: AsOfView;
  readonly params: AgentParams;
  readonly store: StoreReads;
  readonly books: readonly BookState[];
  readonly kills: NightInputs["kills"];
  readonly arn011Failed?: ReadonlyMap<string, readonly string[]>;
  readonly angles?: readonly AngleDef[];
  readonly goLiveD?: string | null;
  readonly elapsedMinutes: number;
};

/** PURE: everything `runNight` needs, from plain data. */
export function buildNightInputs(b: InputBuild): NightInputs {
  const t = b.view.sessions.length - 1;
  if (b.view.sessions[t] !== b.d) {
    throw new RangeError(`the world ends on ${b.view.sessions[t]}, not ${b.d}`);
  }
  const newest = newestPerFamily(b.store.maps);
  const maps = new Map<Family, CortexMap>();
  const rules = new Map<Family, FamilyNightRule>();
  for (const family of V1_FAMILIES) {
    const m = newest.get(family);
    if (m !== undefined) {
      maps.set(family, {
        family,
        ruleVersion: m.ruleVersion,
        fittedAt: m.fittedAt,
        a: m.params.a,
        b: m.params.b,
        sMean: m.params.s_mean,
        sSd: m.params.s_sd,
        K: m.params.K,
        clusters: m.params.clusters as CortexMap["clusters"],
        activeSetHash: m.activeSetHash,
        nEff: m.nEff,
      });
    }
    rules.set(family, ruleFromMap(family, m));
  }
  const cells = new Map<string, CellStatistic>();
  for (const c of b.store.cellRows) {
    const cell = cellFromResult(c.result);
    if (cell !== null) cells.set(cell.cellKey, cell);
  }
  // a killed family or arena is `suspended` (no live arm); D-280: absent / shadow stays shadow
  const status: Partial<Record<Family | "F7", "shadow" | "allowed" | "suspended">> = {};
  for (const f of CORTEX_FAMILIES) {
    const s = b.store.status[f];
    status[f] =
      s === "allowed" && f !== "F7" && (b.kills.arena || b.kills.families.has(f as Family))
        ? "suspended"
        : s;
  }
  const passports = new Map<string, AngleStatus>();
  for (const p of b.store.passports) passports.set(p.angleId, p.status);
  return {
    market: b.market,
    d: b.d,
    t,
    view: b.view,
    params: b.params,
    status: status as FamilyStatusMap,
    maps,
    cells,
    books: b.books,
    rules,
    states: b.store.states.map((s) => ({
      code: s.code,
      kind: s.kind,
      state: s.state,
      basis: s.basis,
    })),
    passports,
    ...(b.angles === undefined ? {} : { angles: b.angles }),
    kills: b.kills,
    degrade: { elapsedMinutes: b.elapsedMinutes },
    ...(b.arn011Failed === undefined ? {} : { arn011Failed: b.arn011Failed }),
    ...(b.goLiveD === undefined ? {} : { goLiveD: b.goLiveD }),
    prng: (scope) => scopedPrng(scope),
  };
}

// ---- persistence --------------------------------------------------------------------------------------------------

function featureRowsOf(
  market: string,
  d: string,
  out: NightOutput,
  hash: string,
  manifestId: string,
): FeatureRow[] {
  const rows: FeatureRow[] = [];
  for (const [code, feats] of [...out.features.entries()].sort((a, b) => cmp(a[0], b[0]))) {
    const features: Record<string, number | null> = {};
    const flags: Record<string, string> = {};
    for (const [id, v] of [...feats.entries()].sort((a, b) => cmp(a[0], b[0]))) {
      if (typeof v === "number") features[id] = Number.isFinite(v) ? v : null;
      else if (v === undefined) features[id] = null;
      else {
        features[id] = null;
        flags[id] = "flag" in v ? v.flag : v.bucket;
      }
    }
    rows.push({ market, d, code, features, flags, activeSetHash: hash, manifestId });
  }
  return rows;
}

type AnyDecision = Omit<Decision, "limitMicro" | "stopMicro" | "qty" | "orderValueMicro"> & {
  readonly limitMicro: Micro | null;
  readonly stopMicro: Micro | null;
  readonly qty: bigint | null;
  readonly firstFail?: string;
};

function decisionRowOf(
  market: string,
  d: string,
  manifestId: string,
  dec: AnyDecision,
  tilt: readonly unknown[],
  links?: { signalId: string; orderId: string; cardId: string },
): DecisionRow {
  return {
    market,
    d,
    bookId: dec.bookId,
    code: dec.code,
    arm: dec.arm,
    family: dec.family,
    s: dec.s,
    p: dec.p,
    expectedNetMicro: dec.expectedNetMicro === null ? null : Number(dec.expectedNetMicro),
    rankKey: dec.rankKey.length === 0 ? null : JSON.stringify(dec.rankKey),
    limitMicro: dec.limitMicro === null ? null : Number(dec.limitMicro),
    stopMicro: dec.stopMicro === null ? null : Number(dec.stopMicro),
    qty: dec.qty === null ? null : Number(dec.qty),
    gateTrace: dec.trace,
    firstFailGate: dec.firstFail ?? null,
    signalId: links?.signalId ?? null,
    orderId: links?.orderId ?? null,
    cardId: links?.cardId ?? null,
    sectorTilt: tilt.length === 0 ? null : tilt,
    manifestId,
  };
}

export type PersistResult = {
  readonly manifestId: string;
  readonly featureRows: number;
  readonly decisionRows: number;
  readonly abstainRows: number;
};

/**
 * Night, manifest, features, abstains and every non-live decision (shadow arm and blocked candidates
 * of both arms). Insert-or-ignore everywhere: a re-run of the same night keeps the first record.
 */
export async function persistNight(
  db: Client,
  o: {
    market: string;
    d: string;
    inputs: NightInputs;
    out: NightOutput;
    runtimeMs: number;
    createdAt: string;
  },
): Promise<PersistResult> {
  const { market, d, out, inputs } = o;
  const view = inputs.view;
  const t = inputs.t;
  const codes = view.codes(t);
  const barsN = codes.filter((c) => {
    const b = view.bars(c, t, 1);
    return b.length > 0 && b[b.length - 1]!.d === d;
  }).length;
  const { manifestId } = await insertManifest(
    db,
    {
      market,
      d,
      sources: out.manifest.sources,
      schemaSha: out.manifest.schemaSha,
      rowCounts: Object.fromEntries(out.manifest.sources.map((s) => [s.kind, s.rows])),
    },
    o.createdAt,
  );
  const features = featureRowsOf(market, d, out, out.activeSetHash, manifestId);
  const fit = [...inputs.maps.values()].map((m) => m.fittedAt).sort(cmp);
  await insertNight(db, {
    market,
    d,
    status: out.status,
    reason: out.reason,
    manifestId,
    universeN: codes.length,
    barsN,
    featureRows: features.length,
    runtimeMs: o.runtimeMs,
    activeSetHash: out.activeSetHash,
    mapFittedAt: fit.length === 0 ? null : fit[fit.length - 1]!,
  });
  await insertFeatureRows(db, features);
  const tiltOf = (bookId: string): unknown[] =>
    out.sectorTilt
      .filter((x) => x.bookId === bookId)
      .map((x) => ({ sector: x.sector, tiltPp: x.tiltPp }));
  const rows: DecisionRow[] = [
    ...out.shadow.map((x) => decisionRowOf(market, d, manifestId, x, tiltOf(x.bookId))),
    ...out.blocked.map((x) => decisionRowOf(market, d, manifestId, x, tiltOf(x.bookId))),
  ];
  await insertDecisions(db, rows);
  for (const a of out.abstains) {
    await insertAbstain(db, {
      market,
      d,
      bookId: a.bookId,
      gateId: a.gateId,
      label: a.label,
      detail: a.detail,
    });
  }
  return {
    manifestId,
    featureRows: features.length,
    decisionRows: rows.length,
    abstainRows: out.abstains.length,
  };
}

export type LiveLink = {
  readonly signalId: string;
  readonly orderId: string;
  readonly cardId: string;
};

/** Live-arm decisions (taken and queued) with the links of the orders batch 2b actually wrote. */
export async function persistLiveDecisions(
  db: Client,
  o: {
    market: string;
    d: string;
    manifestId: string;
    out: NightOutput;
    /** key = `${bookId}|${code}` */
    links: ReadonlyMap<string, LiveLink>;
  },
): Promise<number> {
  const tiltOf = (bookId: string): unknown[] =>
    o.out.sectorTilt
      .filter((x) => x.bookId === bookId)
      .map((x) => ({ sector: x.sector, tiltPp: x.tiltPp }));
  const rows = [...o.out.decisions, ...o.out.queued].map((x) =>
    decisionRowOf(
      o.market,
      o.d,
      o.manifestId,
      x,
      tiltOf(x.bookId),
      o.links.get(`${x.bookId}|${x.code}`),
    ),
  );
  await insertDecisions(db, rows);
  return rows.length;
}

// ---- the stage ---------------------------------------------------------------------------------------------------------

export type StageOptions = {
  readonly market: string;
  readonly d: string;
  readonly params: AgentParams;
  readonly calendar: readonly CalendarRow[];
  readonly replay?: boolean;
  /** Stamps manifests and outcomes only. */
  readonly now: () => string;
  /** Wall clock in ms for the D-289 quota-degrade measure (the core never reads a clock). */
  readonly nowMs?: () => number;
  /** Owner switches from arena_control: paused or killed (D-280: the book then trades nothing). */
  readonly killedArena?: boolean;
  readonly killedFamilies?: ReadonlySet<Family>;
  readonly arn011Failed?: ReadonlyMap<string, readonly string[]>;
  /** A synthetic registry (tests); default is the code registry. */
  readonly angles?: readonly AngleDef[];
  readonly goLiveD?: string | null;
  readonly includeLeverage?: boolean;
};

export type StageResult = {
  readonly inputs: NightInputs;
  readonly out: NightOutput;
  readonly manifestId: string;
  readonly runtimeMs: number;
  /** Families whose status is `allowed` and not killed: their books trade the live arm (D-266). */
  readonly allowed: ReadonlySet<Family>;
  /** family -> signal.rule_version of the Cortex signals of tonight. */
  readonly signalRuleVersion: ReadonlyMap<Family, string>;
  readonly persisted: PersistResult;
};

export async function cortexStage(db: Client, o: StageOptions): Promise<StageResult> {
  const nowMs = o.nowMs ?? (() => Date.now());
  const started = nowMs();
  const books = await loadBookStates(db, {
    market: o.market,
    d: o.d,
    calendar: o.calendar,
    includeLeverage: o.includeLeverage,
  });
  const rows = await loadStageRows(db, {
    market: o.market,
    d: o.d,
    params: o.params,
    calendar: o.calendar,
    liveIngestBound: o.replay !== true,
    heldCodes: [...new Set(books.flatMap((b) => b.positions.map((p) => p.code)))].sort(cmp),
  });
  const view = buildAsOfView(
    worldFromRows(rows, {
      market: o.market,
      cutoffHhmm: o.params.decisionCutoff,
      calendar: o.calendar,
      params: o.params,
    }),
  );
  const store = await loadStoreReads(db, { market: o.market, d: o.d });
  const inputs = buildNightInputs({
    market: o.market,
    d: o.d,
    view,
    params: o.params,
    store,
    books,
    kills: {
      arena: o.killedArena === true,
      families: o.killedFamilies ?? new Set<Family>(),
      sourcesOff: store.sourcesOff,
    },
    arn011Failed: o.arn011Failed,
    angles: o.angles,
    goLiveD: o.goLiveD,
    elapsedMinutes: (nowMs() - started) / 60_000, // threshold-ok: ms to minutes
  });
  const out = runNight(inputs);
  const runtimeMs = Math.max(0, Math.round(nowMs() - started));
  const persisted = await persistNight(db, {
    market: o.market,
    d: o.d,
    inputs,
    out,
    runtimeMs,
    createdAt: o.now(),
  });
  const allowed = new Set<Family>();
  for (const f of V1_FAMILIES) if (inputs.status[f] === "allowed") allowed.add(f);
  const signalRuleVersion = new Map<Family, string>();
  for (const [f, r] of inputs.rules) signalRuleVersion.set(f, cortexRuleVersion(f, r.ruleVersion));
  return {
    inputs,
    out,
    manifestId: persisted.manifestId,
    runtimeMs,
    allowed,
    signalRuleVersion,
    persisted,
  };
}

// ---- batch 3: would-have scoring (CTX-023, CTX-054) ---------------------------------------------------------------------

export type ScoreResult = {
  readonly scored: number;
  readonly unscorable: number;
  readonly open: number;
};

export const SCORE_BATCH = 5000; // threshold-ok: rows per nightly scoring pass

/**
 * Scores every decision (live, shadow, blocked) whose hold has closed: the limit fill on the first
 * later bar, then the family's v1 plan walked to its exit (`wouldHaveOutcome`). A decision with no
 * limit, quantity or plan (blocked before sizing, a family whose plan is not wired) is recorded
 * `cancelled`. Insert-or-ignore: running it twice writes nothing new.
 */
export async function scoreOutcomes(
  db: Client,
  o: { market: string; d: string; params: AgentParams; now: () => string; limit?: number },
): Promise<ScoreResult> {
  const pending = await unscoredDecisions(db, o.market, o.d, o.limit ?? SCORE_BATCH);
  const barCache = new Map<string, ViewBar[]>();
  const barsOf = async (code: string): Promise<ViewBar[]> => {
    const hit = barCache.get(code);
    if (hit !== undefined) return hit;
    const rs = await db.execute({
      sql: `SELECT d, o, h, l, c, volume FROM price_bar WHERE market = ? AND code = ? AND d <= ?
            ORDER BY d DESC LIMIT ?`,
      args: [o.market, code, o.d, STAGE_BAR_SESSIONS + 300], // threshold-ok: history for ATR and hold
    });
    const list: ViewBar[] = [];
    for (const r of rs.rows) {
      list.push({
        d: text(r.d),
        open: priceMicro(r.o),
        high: priceMicro(r.h),
        low: priceMicro(r.l),
        close: priceMicro(r.c),
        volume: toBig(r.volume),
      });
    }
    list.reverse();
    barCache.set(code, list);
    return list;
  };
  const profileCache = new Map<string, (typeof COST_PROFILES)[keyof typeof COST_PROFILES]>();
  const profileOf = async (bookId: string) => {
    const hit = profileCache.get(bookId);
    if (hit !== undefined) return hit;
    const rs = await db.execute({
      sql: "SELECT params_json FROM cohort WHERE id = ?",
      args: [bookId],
    });
    const profile =
      rs.rows.length === 0
        ? COST_PROFILES.P5
        : COST_PROFILES[parseCohortParams(text(rs.rows[0]!.params_json)).costProfile];
    profileCache.set(bookId, profile);
    return profile;
  };
  const scoredAt = o.now();
  let scored = 0;
  let unscorable = 0;
  let open = 0;
  for (const dec of pending) {
    const family = dec.family;
    const all = await barsOf(dec.code);
    const upTo = all.filter((b) => b.d <= dec.d);
    const after = all.filter((b) => b.d > dec.d);
    const atr = atr20Micro(upTo.slice(-250)); // threshold-ok: ATR_HISTORY
    const plan = isV1Family(family) ? familyPlan(family, o.params, atr) : null;
    if (
      plan === null ||
      dec.limitMicro === null ||
      dec.qty === null ||
      dec.qty <= 0 ||
      !isV1Family(family)
    ) {
      await insertOutcome(db, {
        market: o.market,
        d: dec.d,
        bookId: dec.bookId,
        code: dec.code,
        arm: dec.arm,
        fillStatus: "cancelled",
        fillMicro: null,
        fillD: null,
        exitD: null,
        exitRule: null,
        grossMicro: null,
        netMicro: null,
        outcomeClass: null,
        scoredAt,
      });
      unscorable += 1;
      continue;
    }
    const advBars = upTo.slice(-o.params.windows.adv);
    let value = 0n;
    for (const b of advBars) value += b.close * b.volume;
    const advMicro = advBars.length === 0 ? 0n : value / BigInt(advBars.length);
    const res = wouldHaveOutcome({
      code: dec.code,
      family,
      qty: BigInt(dec.qty),
      limitMicro: BigInt(dec.limitMicro),
      plan,
      atrMicro: atr,
      bars: after,
      profile: await profileOf(dec.bookId),
      advMicro,
    });
    if (res === null) {
      open += 1;
      continue;
    }
    await insertOutcome(db, {
      market: o.market,
      d: dec.d,
      bookId: dec.bookId,
      code: dec.code,
      arm: dec.arm,
      fillStatus: res.fillStatus,
      fillMicro: res.fillMicro === null ? null : Number(res.fillMicro),
      fillD: res.fillD,
      exitD: res.exitD,
      exitRule: res.exitRule,
      grossMicro: res.grossMicro === null ? null : Number(res.grossMicro),
      netMicro: res.netMicro === null ? null : Number(res.netMicro),
      outcomeClass: res.outcomeClass,
      scoredAt,
    });
    scored += 1;
  }
  return { scored, unscorable, open };
}

// ---- open-time list for Cortex orders (CTX-028; run at the 09:55 re-check and at the fill) -----------------

export type OpenGuardInput = {
  readonly market: string;
  /** The session the check runs for (the fill session; the 09:55 session at the re-check). */
  readonly d: string;
  /** The session whose bars measure the universe staleness (the decision night at 09:55, else d). */
  readonly barD: string;
  readonly orderId: string;
  readonly signalId: string | null;
  readonly family: Family;
  /** null at the 09:55 run; the limit fill outcome at the fill. */
  readonly fill: LimitFillOutcome | null;
  /** The stop rule of the order's plan (first initial stop), for O06 at the fill. */
  readonly stopSpec: StopSpec | null;
  /** True when a 09:55 re-check ran for this order (O07). */
  readonly rechecked: boolean;
};

export type OpenGuardResult = {
  readonly firstFail: OpenId | null;
  readonly trace: readonly OpenTraceEntry[];
};

/**
 * `openTimeChecks` (gates/openTime.ts) with its inputs read from the database: Owner switches
 * (arena_control), sources off, the sources the night read (its input manifest), the regime, the
 * universe staleness, `max_loss_pct` and the matched cell's gap95 (kept on the Cortex signal's
 * evidence). Called for orders that carry `limit_micro` only; v1 orders never reach it.
 */
export async function cortexOpenGuard(db: Client, a: OpenGuardInput): Promise<OpenGuardResult> {
  const params = await loadAgentParams(db);
  const ctrl = await db.execute("SELECT scope, scope_key, state FROM arena_control ORDER BY id");
  const states = controlStates(
    ctrl.rows.map((r) => ({
      scope: text(r.scope),
      scopeKey: text(r.scope_key),
      state: text(r.state),
    })),
  );
  const off = (key: string): boolean => {
    const v = states.get(key);
    return v === "paused" || v === "killed";
  };
  const families = new Set<Family>(V1_FAMILIES.filter((f) => off(`family|${f}`)));
  const sourcesOff = await loadSourcesOff(db);
  const man = await db.execute({
    sql: `SELECT m.sources_json FROM cortex_decision c JOIN input_manifest m ON m.manifest_id = c.manifest_id
          WHERE c.market = ? AND c.book_id IN (SELECT cohort_id FROM arena_order WHERE id = ?)
            AND c.order_id = ? LIMIT 1`,
    args: [a.market, a.orderId, a.orderId],
  });
  const needed: InputKind[] = [];
  if (man.rows.length > 0) {
    const list = JSON.parse(text(man.rows[0]!.sources_json)) as { kind: InputKind; rows: number }[];
    for (const s of list) if (s.rows > 0) needed.push(s.kind);
  }
  const reg = await db.execute({
    sql: "SELECT state FROM regime_daily WHERE market = ? AND d < ? ORDER BY d DESC LIMIT 1",
    args: [a.market, a.d],
  });
  const regime = (reg.rows.length === 0 ? "unknown" : text(reg.rows[0]!.state)) as RegimeLabel;
  const uni = await db.execute({
    sql: `SELECT COUNT(*) AS n,
                 COALESCE(SUM(EXISTS (SELECT 1 FROM price_bar b WHERE b.market = u.market
                   AND b.code = u.code AND b.d = u.d)), 0) AS have
          FROM universe_snapshot u WHERE u.market = ? AND u.d = ? AND u.status = 'active'`,
    args: [a.market, a.barD],
  });
  const n = Number(uni.rows[0]?.n ?? 0);
  const have = Number(uni.rows[0]?.have ?? 0);
  let gap95: number | undefined;
  if (a.signalId !== null) {
    const ev = await db.execute({
      sql: "SELECT evidence_json FROM signal WHERE id = ?",
      args: [a.signalId],
    });
    if (ev.rows.length > 0) {
      const g = (JSON.parse(text(ev.rows[0]!.evidence_json)) as { gap95?: unknown }).gap95;
      if (typeof g === "number" && Number.isFinite(g)) gap95 = g;
    }
  }
  const checks = openTimeChecks({
    family: a.family,
    kills: { arena: off(`market|${a.market}`), families, sourcesOff },
    sourcesNeeded: needed,
    regime,
    staleShare: n === 0 ? 0 : 1 - have / n,
    staleUniverseMaxShare: params.cortex.staleUniverseMaxShare,
    fill: a.fill,
    stopSpec: a.stopSpec ?? { atr_micro: null, k: null, cap: null, level_micro: null },
    gap95,
    maxLoss: params.cortex.maxLoss,
    rechecked: a.rechecked,
  });
  return { firstFail: checks.firstFail, trace: checks.trace };
}
