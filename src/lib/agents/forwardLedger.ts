// Forward signal ledger (M4 T15; docs/M4_design.md 4.1, 4.10, 4.11; ARN-080, ARN-086, ARN-093;
// D-088 mechanics, D-093 proposed). The LIVE rows of the signal ledger: every night's batch 3 appends
// the new rows and the new closures to `ledger_row` (`forward = 1`) and, once a row's matched C2
// controls have all finished, to `ledger_control`. The rows are produced by the SAME function as the
// development ledger (`replayLedger`, T11) over a window of the last sessions, so they equal a
// replay over the same days; this module only supplies the world (bars from the database, the
// stored candidates of each decision session) and writes the result.
//
// Why a window and stored candidates. A row can stay open for at most the longest holding bound of
// the families (`maxHoldingUpperBound`), and after an IS exit the code is blocked for `reentry_block`
// sessions. Rebuilding the family inputs of every past session each night would cost as much as 2b
// per session; instead each night stores its candidates (replay_stat `fwd:<market>` / `cand:<d>`,
// canonical JSON with bigint tags) and a later night replays the window from those. The window is
// 2 x (hold bound + block + 1) sessions long; rows are only WRITTEN from its second half (the first
// half warms the one-open-row and re-entry state), and it is extended back to the oldest open row.
//
// Controls. A row's 20 matched controls are drawn when the row has closed, from the universe of its
// decision session (rebuilt by `loadDayInputs`), with bars fetched on demand. A control path that is
// still running at the end of the data is force-closed by the library (D-088), and a control that
// would enter on the last session cannot be walked at all: such a draw is not final, so nothing is
// written and the draw is repeated on a later night; once every path has ended the controls never
// change. A final draw with no usable control is recorded as `controls_none`.
//
// Deterministic: no clock, no randomness outside the seeded library. Idempotent: a stored row that
// differs from the recomputed one RAISES (`ForwardLedgerError`), a stored open row that has now
// closed receives the one-way close update, anything else is left alone.
import type { Client } from "@libsql/client";
import { sessionsBetween, type CalendarRow, type MarketHours } from "@/lib/data/calendar";
import { floorRat } from "@/lib/money/round";
import type { ViewBar } from "./decisionView";
import { createDecisionView, decisionCutoffUtc } from "./decisionView";
import { loadConfirmedActions } from "@/lib/arena/corpActionWriter";
import type { CorpActionRecord } from "@/lib/arena/corpActions";
import {
  adjustBars,
  barsNeeded,
  eventRowOf,
  loadDayInputs,
  splitActionsByCode,
  type DayInputs,
} from "./candidates";
import {
  buildCodeFacts,
  eventFactFromRow,
  runFamilies,
  type Candidate,
  type CodeFacts,
  type EventFact,
  type FamilyInputs,
  type FamilyOutput,
  type Family,
  type Tier,
} from "./families";
import type { AgentParams } from "./params";
import { volumeRatio } from "./indicators";
import { createControlLibrary, type ControlDraw, type PoolCode } from "@/lib/replay/controlLibrary";
import {
  anchorsOf,
  ledgerRowId,
  replayLedger,
  signalId,
  type LedgerEntry,
  type LedgerSource,
} from "@/lib/replay/ledger";
import {
  costSetupFrom,
  walkPosition,
  type PathSource,
  type PositionFacts,
} from "@/lib/replay/returns";
import { maxHoldingUpperBound } from "@/lib/stats/splits";

export class ForwardLedgerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ForwardLedgerError";
    this.code = code;
  }
}

const text = (v: unknown): string => String(v);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const FAMILIES: readonly Family[] = ["F1", "F2", "F3", "F4", "F5", "F6"];

// ---- JSON with bigint --------------------------------------------------------------------------------------------

const BIG = "$big";

/** JSON text with every bigint as `{"$big":"123"}`: lossless and byte-stable for equal values. */
export function encodeJson(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    typeof x === "bigint" ? { [BIG]: x.toString() } : x,
  );
}

export function decodeJson<T>(s: string): T {
  return JSON.parse(s, (_k, x: unknown) => {
    if (x !== null && typeof x === "object" && !Array.isArray(x)) {
      const o = x as Record<string, unknown>;
      const keys = Object.keys(o);
      if (keys.length === 1 && keys[0] === BIG && typeof o[BIG] === "string") return BigInt(o[BIG]);
    }
    return x;
  }) as T;
}

// ---- stored candidates -----------------------------------------------------------------------------------------

export type DayCandidates = Pick<FamilyOutput, "candidates" | "blocked">;

export const fwdRunId = (market: string): string => `fwd:${market}`;
const candScope = (d: string): string => `cand:${d}`;
const CHUNK = 400; // threshold-ok: SQL parameter chunk size

/** Store a decision session's candidates (first write wins: a session is decided once). */
export async function putDayCandidates(
  db: Client,
  market: string,
  d: string,
  out: DayCandidates,
): Promise<boolean> {
  const res = await db.execute({
    sql: `INSERT INTO replay_stat (run_id, scope, metric, d, value_json) VALUES (?, ?, 'candidates', ?, ?)
          ON CONFLICT DO NOTHING`,
    args: [
      fwdRunId(market),
      candScope(d),
      d,
      encodeJson({ candidates: out.candidates, blocked: out.blocked }),
    ],
  });
  return res.rowsAffected > 0;
}

export async function loadDayCandidates(
  db: Client,
  market: string,
  days: readonly string[],
): Promise<Map<string, DayCandidates>> {
  const out = new Map<string, DayCandidates>();
  for (let i = 0; i < days.length; i += CHUNK) {
    const part = days.slice(i, i + CHUNK);
    if (part.length === 0) continue;
    const rs = await db.execute({
      sql: `SELECT scope, value_json FROM replay_stat
            WHERE run_id = ? AND metric = 'candidates' AND scope IN (${part.map(() => "?").join(", ")})`,
      args: [fwdRunId(market), ...part.map(candScope)],
    });
    for (const r of rs.rows) {
      out.set(text(r.scope).slice("cand:".length), decodeJson<DayCandidates>(text(r.value_json)));
    }
  }
  return out;
}

// ---- the world ---------------------------------------------------------------------------------------------------

/** A code's bars were not loaded yet: the caller loads them and repeats. */
export class NeedBars extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`bars of ${code} not loaded`);
    this.name = "NeedBars";
    this.code = code;
  }
}

type Series = {
  readonly bars: readonly ViewBar[];
  readonly index: ReadonlyMap<string, number>;
  readonly events: readonly EventFact[];
};

export type WorldOptions = {
  readonly db: Client;
  readonly market: string;
  /** Last session of the world (the decision day of tonight's run). */
  readonly d: string;
  readonly sessions: readonly string[];
  readonly params: AgentParams;
  readonly actions: readonly CorpActionRecord[];
  readonly replay: boolean;
  readonly hours: MarketHours;
};

/** One day's universe as control-pool facts (eligible = the 2b control filter without the quality gate). */
export function poolFromDay(day: Pick<DayInputs, "inputs" | "vol20">): PoolCode[] {
  return day.inputs.codes.map((f: CodeFacts): PoolCode => ({
    code: f.code,
    tier: f.tier,
    vol20: day.vol20.get(f.code) ?? null,
    atrMicro: f.ind.atrMicro,
    advMicro: f.ind.adv === null ? 0n : floorRat(f.ind.adv),
    eligible: !f.halted && f.ind.atrWarm && f.ind.atrMicro !== null,
  }));
}

/**
 * A LedgerSource over the database: bars come from the decision view of tonight (bounded by D and
 * the ingest cut-off), indicator facts are built per (code, session) from the last `barsNeeded`
 * bars with the splits known on that session, exactly as `loadDayInputs` builds them.
 */
export class LiveWorld implements LedgerSource, PathSource {
  readonly sessions: readonly string[];
  readonly market: string;
  private readonly series = new Map<string, Series>();
  private readonly universe = new Map<string, readonly PoolCode[]>();
  private readonly outputs = new Map<string, DayCandidates>();
  private readonly inputs = new Map<string, FamilyInputs>();
  private readonly memo = new Map<string, CodeFacts | null>();
  private readonly pfMemo = new Map<string, PositionFacts | null>();
  private readonly view: ReturnType<typeof createDecisionView>;
  private readonly splits: ReturnType<typeof splitActionsByCode>["byCode"];
  private readonly need: number;
  private readonly index = new Map<string, number>();

  constructor(private readonly o: WorldOptions) {
    this.sessions = o.sessions;
    this.market = o.market;
    this.view = createDecisionView(o.db, {
      market: o.market,
      d: o.d,
      cutoff: decisionCutoffUtc(o.d, o.params.decisionCutoff),
      liveIngestBound: !o.replay,
    });
    this.splits = splitActionsByCode(o.actions).byCode;
    this.need = barsNeeded(o.params);
    o.sessions.forEach((s, i) => this.index.set(s, i));
  }

  /** Fetch bars (back to `need` bars before the first session) and events of codes not yet loaded. */
  async load(codes: readonly string[]): Promise<void> {
    const todo = [...new Set(codes)].filter((c) => !this.series.has(c)).sort(cmp);
    if (todo.length === 0) return;
    const count = this.need + this.sessions.length + 5; // threshold-ok: slack for halted sessions
    const bars = new Map<string, ViewBar[]>();
    for (const code of todo) bars.set(code, await this.view.bars(code, count));
    const first = this.sessions[0] ?? "";
    const events = new Map<string, EventFact[]>();
    const cutoff = decisionCutoffUtc(this.o.d, this.o.params.decisionCutoff);
    for (let i = 0; i < todo.length; i += CHUNK) {
      const part = todo.slice(i, i + CHUNK);
      const rs = await this.o.db.execute({
        sql: `SELECT * FROM event WHERE market = ? AND day0_d >= ? AND day0_d <= ? AND published_at < ?
              AND code IN (${part.map(() => "?").join(", ")}) ORDER BY source, ann_id`,
        args: [this.market, first, this.o.d, cutoff, ...part],
      });
      for (const r of rs.rows) {
        const row = eventRowOf(r as Record<string, unknown>);
        const own = bars.get(row.code) ?? [];
        const day0 = own.find((b) => b.d === row.day0_d);
        const list = events.get(row.code) ?? [];
        list.push(eventFactFromRow(row, day0 === undefined ? null : day0.low));
        events.set(row.code, list);
      }
    }
    for (const code of todo) {
      const list = bars.get(code)!;
      this.series.set(code, {
        bars: list,
        index: new Map(list.map((b, i) => [b.d, i])),
        events: events.get(code) ?? [],
      });
    }
  }

  setOutput(d: string, out: DayCandidates): void {
    this.outputs.set(d, out);
  }
  setInputs(d: string, inputs: FamilyInputs): void {
    this.inputs.set(d, inputs);
  }
  setUniverse(d: string, pool: readonly PoolCode[]): void {
    this.universe.set(d, pool);
  }
  hasUniverse(d: string): boolean {
    return this.universe.has(d);
  }

  corpActions(code: string): readonly CorpActionRecord[] {
    return this.o.actions.filter((a) => a.code === code);
  }

  private seriesOf(code: string): Series {
    const s = this.series.get(code);
    if (s === undefined) throw new NeedBars(code);
    return s;
  }

  bar(code: string, d: string): ViewBar | null {
    const s = this.seriesOf(code);
    const i = s.index.get(d);
    return i === undefined ? null : s.bars[i]!;
  }

  private factsAt(code: string, i: number, tier: Tier): CodeFacts {
    const key = `${code}|${i}`;
    let f = this.memo.get(key) ?? null;
    if (f === null) {
      const s = this.seriesOf(code);
      const raw = s.bars.slice(Math.max(0, i + 1 - this.need), i + 1);
      const d = raw[raw.length - 1]!.d;
      const known = (this.splits.get(code) ?? []).filter((a) => a.exDate <= d);
      f = buildCodeFacts({ code, tier, adjusted: adjustBars(raw, known), raw }, this.o.params);
      this.memo.set(key, f);
    }
    return f;
  }

  positionFacts(code: string, d: string): PositionFacts | null {
    const s = this.seriesOf(code);
    const i = s.index.get(d);
    if (i === undefined) return null;
    const key = `${code}|${i}`;
    const hit = this.pfMemo.get(key);
    if (hit !== undefined) return hit;
    const f = this.factsAt(code, i, "U1");
    const raw = s.bars.slice(Math.max(0, i + 1 - this.need), i + 1);
    const known = (this.splits.get(code) ?? []).filter((a) => a.exDate <= d);
    const volumes = adjustBars(raw, known).map((b) => b.volume);
    const tail = this.o.params.specConstants.f5DryUpSessions;
    const ratios = [];
    for (let j = tail - 1; j >= 0; j -= 1) {
      ratios.push(
        volumeRatio(volumes.slice(0, volumes.length - j), this.o.params.windows.volumeRatio),
      );
    }
    const facts: PositionFacts = {
      atrMicro: f.ind.atrWarm ? f.ind.atrMicro : null,
      closeAboveExitSma: f.ind.closeAboveSmaShort,
      volumeRatios: ratios,
      events: s.events.filter((e) => e.day0 <= d),
    };
    this.pfMemo.set(key, facts);
    return facts;
  }

  familyOutput(d: string): DayCandidates | null {
    return this.outputs.get(d) ?? null;
  }

  familyInputs(d: string): FamilyInputs {
    const i = this.inputs.get(d);
    if (i === undefined) throw new ForwardLedgerError("no_inputs", `no family inputs for ${d}`);
    return i;
  }

  controlUniverse(d: string): readonly PoolCode[] {
    const u = this.universe.get(d);
    if (u === undefined) throw new ForwardLedgerError("no_universe", `no universe for ${d}`);
    return u;
  }
}

// ---- window --------------------------------------------------------------------------------------------------------

/** The longest hold bound of any family plus the re-entry block plus one: a row's reach in sessions. */
export function reachSessions(params: AgentParams): number {
  const hold = Math.max(...FAMILIES.map((f) => maxHoldingUpperBound(f)));
  return hold + params.reentryBlock + 1;
}

// ---- writing ---------------------------------------------------------------------------------------------------------

type Exec = Pick<Client, "execute">;

async function withTx<T>(db: Client, fn: (tx: Exec) => Promise<T>): Promise<T> {
  const tx = await db.transaction("write");
  try {
    const out = await fn(tx);
    await tx.commit();
    return out;
  } catch (error) {
    await tx.rollback();
    throw error;
  } finally {
    tx.close();
  }
}

const same = (a: unknown, b: unknown): boolean =>
  a === null || a === undefined
    ? b === null || b === undefined
    : b !== null && b !== undefined && String(a) === String(b);

const OPEN_COLS = [
  "signal_id",
  "group_key",
  "entry_d",
  "qty",
  "fill_in_micro",
  "brok_in_micro",
  "stress_in_micro",
  "timed",
] as const;

const CLOSE_COLS = [
  "exit_d",
  "exit_tag",
  "fill_out_micro",
  "brok_out_micro",
  "stress_out_micro",
  "qty_out",
  "dividend_micro",
  "gross_num",
  "gross_den",
] as const;

/** Metric of the exit marker (rule id and flags of a closed row; ledger_row keeps only IS / CS). */
export const EXIT_RULE_METRIC = "exit_rule";
export const exitRuleScope = (rowId: string): string => `exit:${rowId}`;

/** First write wins: the rule that closed a row is a fact of its walk and never changes. */
async function putExitRule(tx: Exec, e: LedgerEntry): Promise<void> {
  if (e.row.exit_d === null || e.exitRule === null) return;
  const market = e.lineage.slice(0, e.lineage.lastIndexOf(":"));
  await tx.execute({
    sql: `INSERT INTO replay_stat (run_id, scope, metric, d, value_json) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT DO NOTHING`,
    args: [
      fwdRunId(market),
      exitRuleScope(e.row.id),
      EXIT_RULE_METRIC,
      e.row.exit_d,
      encodeJson({ flags: e.flags, rule: e.exitRule }),
    ],
  });
}

export type WriteCounts = { opened: number; closed: number; unchanged: number; noSignal: number };

/** Insert the open row, or compare with the stored one; apply the one-way close when it is due. */
async function writeEntry(tx: Exec, e: LedgerEntry, counts: WriteCounts): Promise<void> {
  const r = e.row;
  const sig = await tx.execute({ sql: "SELECT 1 FROM signal WHERE id = ?", args: [r.signal_id] });
  if (sig.rows.length === 0) {
    counts.noSignal += 1;
    return;
  }
  const openValues: Record<(typeof OPEN_COLS)[number], unknown> = {
    signal_id: r.signal_id,
    group_key: r.group_key,
    entry_d: r.entry_d,
    qty: r.qty,
    fill_in_micro: r.fill_in_micro,
    brok_in_micro: r.brok_in_micro,
    stress_in_micro: r.stress_in_micro,
    timed: r.timed,
  };
  const stored = await tx.execute({ sql: "SELECT * FROM ledger_row WHERE id = ?", args: [r.id] });
  if (stored.rows.length === 0) {
    await tx.execute({
      sql: `INSERT INTO ledger_row (id, signal_id, group_key, entry_d, exit_d, exit_tag, qty, fill_in_micro,
              fill_out_micro, brok_in_micro, brok_out_micro, stress_in_micro, stress_out_micro, qty_out,
              dividend_micro, gross_num, gross_den, timed, forward)
            VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, NULL, ?, NULL, ?, NULL, NULL, 0, NULL, NULL, ?, 1)`,
      args: [
        r.id,
        r.signal_id,
        r.group_key,
        r.entry_d,
        r.qty,
        r.fill_in_micro,
        r.brok_in_micro,
        r.stress_in_micro,
        r.timed,
      ] as never,
    });
    counts.opened += 1;
  } else {
    const row = stored.rows[0]!;
    for (const c of OPEN_COLS) {
      if (!same(row[c], openValues[c])) {
        throw new ForwardLedgerError("row_conflict", `ledger_row ${r.id}: stored ${c} differs`);
      }
    }
    if (row.exit_d !== null) {
      // already closed: the close must be the one recomputed
      const want: Record<(typeof CLOSE_COLS)[number], unknown> = closeValues(r);
      for (const c of CLOSE_COLS) {
        if (!same(row[c], want[c])) {
          throw new ForwardLedgerError("row_conflict", `ledger_row ${r.id}: stored ${c} differs`);
        }
      }
      await putExitRule(tx, e);
      counts.unchanged += 1;
      return;
    }
  }
  if (r.exit_d === null) {
    if (stored.rows.length > 0) counts.unchanged += 1;
    return;
  }
  const v = closeValues(r);
  await tx.execute({
    sql: `UPDATE ledger_row SET exit_d = ?, exit_tag = ?, fill_out_micro = ?, brok_out_micro = ?,
            stress_out_micro = ?, qty_out = ?, dividend_micro = ?, gross_num = ?, gross_den = ?
          WHERE id = ? AND exit_d IS NULL`,
    args: [...CLOSE_COLS.map((c) => v[c]), r.id] as never,
  });
  await putExitRule(tx, e);
  counts.closed += 1;
}

function closeValues(r: LedgerEntry["row"]): Record<(typeof CLOSE_COLS)[number], unknown> {
  return {
    exit_d: r.exit_d,
    exit_tag: r.exit_tag,
    fill_out_micro: r.fill_out_micro,
    brok_out_micro: r.brok_out_micro,
    stress_out_micro: r.stress_out_micro,
    qty_out: r.qty_out,
    dividend_micro: r.dividend_micro,
    gross_num: r.gross_num,
    gross_den: r.gross_den,
  };
}

// ---- the nightly sync ----------------------------------------------------------------------------------------------

export type ForwardOptions = {
  readonly market: string;
  /** Tonight's decision session (2b has succeeded for it). */
  readonly d: string;
  readonly calendar: readonly CalendarRow[];
  readonly hours: MarketHours;
  readonly params: AgentParams;
  readonly replay: boolean;
  readonly masterSeed: bigint;
  /** Window reach in sessions (default: `reachSessions`); a test seam for the truncated window. */
  readonly reach?: number;
  /** Maximum sessions of candidates rebuilt in one night (catch-up after missed batch 3 runs). */
  readonly maxCatchUp?: number;
  /**
   * Called once after the rows and the final controls of the night are written (M6 T3: attribution of
   * the blocked candidates walks them in this very world). It must not write `ledger_row`.
   */
  readonly afterWrite?: (night: ForwardNight) => Promise<void>;
};

/** What the nightly sync hands to `afterWrite`: the world of the window and the stored candidates. */
export type ForwardNight = {
  readonly db: Client;
  readonly market: string;
  readonly d: string;
  readonly params: AgentParams;
  readonly window: readonly string[];
  /** First decision session whose rows this night wrote (the trusted zone starts here). */
  readonly writeFrom: string;
  readonly stored: ReadonlyMap<string, DayCandidates>;
  readonly world: LiveWorld;
};

export type ForwardResult = {
  readonly firstSignalD: string | null;
  readonly windowSessions: number;
  readonly candidateDays: number;
  readonly candidatesRebuilt: number;
  readonly opened: number;
  readonly closed: number;
  readonly unchanged: number;
  readonly noSignal: number;
  readonly controlRows: number;
  readonly controlsDeferred: number;
  readonly controlsNone: number;
};

const empty = (firstSignalD: string | null): ForwardResult => ({
  firstSignalD,
  windowSessions: 0,
  candidateDays: 0,
  candidatesRebuilt: 0,
  opened: 0,
  closed: 0,
  unchanged: 0,
  noSignal: 0,
  controlRows: 0,
  controlsDeferred: 0,
  controlsNone: 0,
});

/** Days with a successful 2b run in [from, to]. */
async function decidedDays(
  db: Client,
  market: string,
  from: string,
  to: string,
): Promise<Set<string>> {
  const rs = await db.execute({
    sql: `SELECT scheduled_for FROM run_record
          WHERE job = 'arena-signals' AND market = ? AND status IN ('success', 'degraded')
            AND scheduled_for >= ? AND scheduled_for <= ?`,
    args: [market, from, to],
  });
  return new Set(rs.rows.map((r) => text(r.scheduled_for)));
}

async function dayInputs(db: Client, o: ForwardOptions, d: string): Promise<DayInputs> {
  return loadDayInputs(db, {
    market: o.market,
    d,
    calendar: o.calendar,
    hours: o.hours,
    params: o.params,
    replay: o.replay,
    heldCodes: [],
    actions: await loadConfirmedActions(db, o.market, d),
  });
}

/**
 * Append tonight's new rows and closures to the forward ledger, then the controls that are final.
 * Returns counts only.
 */
export async function syncForwardLedger(db: Client, o: ForwardOptions): Promise<ForwardResult> {
  const first = await db.execute({
    sql: "SELECT MIN(d) AS d FROM signal WHERE market = ?",
    args: [o.market],
  });
  const firstD =
    first.rows.length === 0 || first.rows[0]!.d === null ? null : text(first.rows[0]!.d);
  if (firstD === null || firstD > o.d) return empty(firstD);
  const all = sessionsBetween(firstD, o.d, o.calendar);
  const last = all.length - 1;
  if (last < 0) return empty(firstD);
  const reach = o.reach ?? reachSessions(o.params);

  // trusted zone starts one reach back, or at the oldest open row's decision session
  const open = await db.execute({
    sql: `SELECT MIN(s.d) AS d FROM ledger_row lr JOIN signal s ON s.id = lr.signal_id
          WHERE lr.forward = 1 AND lr.exit_d IS NULL AND s.market = ?`,
    args: [o.market],
  });
  const openD = open.rows.length === 0 || open.rows[0]!.d === null ? null : text(open.rows[0]!.d);
  let trusted = Math.max(0, last - reach);
  if (openD !== null) {
    const i = all.indexOf(openD);
    if (i >= 0) trusted = Math.min(trusted, i);
  }
  const start = Math.max(0, trusted - reach);
  const window = all.slice(start);
  const from = window[0]!;

  // candidates of every decided session of the window (tonight always)
  const stored = await loadDayCandidates(db, o.market, window);
  const decided = await decidedDays(db, o.market, from, o.d);
  let rebuilt = 0;
  const cap = o.maxCatchUp ?? Number.POSITIVE_INFINITY;
  for (const d of window) {
    if (stored.has(d) || !decided.has(d)) continue;
    if (d !== o.d && rebuilt >= cap) continue;
    const day = await dayInputs(db, o, d);
    const out = runFamilies(day.inputs, o.params);
    const pick: DayCandidates = { candidates: out.candidates, blocked: out.blocked };
    await putDayCandidates(db, o.market, d, pick);
    stored.set(d, pick);
    rebuilt += 1;
  }

  const actions = await loadConfirmedActions(db, o.market, o.d);
  const world = new LiveWorld({
    db,
    market: o.market,
    d: o.d,
    sessions: window,
    params: o.params,
    actions,
    replay: o.replay,
    hours: o.hours,
  });
  const codes = new Set<string>();
  for (const [d, out] of stored) {
    world.setOutput(d, out);
    for (const c of out.candidates) codes.add(c.code);
  }
  for (const d of window) if (!stored.has(d)) world.setOutput(d, { candidates: [], blocked: [] });
  await world.load([...codes]);

  const result = replayLedger(world, {
    params: o.params,
    from,
    to: o.d,
    masterSeed: o.masterSeed,
    controls: false,
  });
  const writeFrom = all[trusted]!;
  const counts: WriteCounts = { opened: 0, closed: 0, unchanged: 0, noSignal: 0 };
  await withTx(db, async (tx) => {
    for (const e of result.entries) {
      if (e.decisionD < writeFrom) continue;
      await writeEntry(tx, e, counts);
    }
  });

  const ctl = await syncControls(db, o);
  if (o.afterWrite !== undefined) {
    await o.afterWrite({
      db,
      market: o.market,
      d: o.d,
      params: o.params,
      window,
      writeFrom,
      stored,
      world,
    });
  }
  return {
    firstSignalD: firstD,
    windowSessions: window.length,
    candidateDays: stored.size,
    candidatesRebuilt: rebuilt,
    ...counts,
    ...ctl,
  };
}

// ---- controls --------------------------------------------------------------------------------------------------------

type Pending = {
  readonly id: string;
  readonly signalId: string;
  readonly entryD: string;
  readonly decisionD: string;
  readonly family: Family;
  readonly ruleVersion: string;
  readonly variant: string;
  readonly code: string;
};

async function pendingControls(db: Client, market: string): Promise<Pending[]> {
  const rs = await db.execute({
    sql: `SELECT lr.id, lr.signal_id, lr.entry_d, s.d, s.family, s.rule_version, s.variant, s.code
          FROM ledger_row lr JOIN signal s ON s.id = lr.signal_id
          WHERE lr.forward = 1 AND lr.exit_d IS NOT NULL AND s.market = ?
            AND NOT EXISTS (SELECT 1 FROM ledger_control c WHERE c.row_id = lr.id)
            AND NOT EXISTS (SELECT 1 FROM replay_stat t WHERE t.run_id = ? AND t.scope = 'ctl:' || lr.id
                            AND t.metric = 'controls_none')
          ORDER BY lr.id`,
    args: [market, fwdRunId(market)],
  });
  return rs.rows.map((r) => ({
    id: text(r.id),
    signalId: text(r.signal_id),
    entryD: text(r.entry_d),
    decisionD: text(r.d),
    family: text(r.family) as Family,
    ruleVersion: text(r.rule_version),
    variant: text(r.variant),
    code: text(r.code),
  }));
}

async function insertControls(
  db: Client,
  market: string,
  d: string,
  rowId: string,
  draw: ControlDraw,
): Promise<void> {
  await withTx(db, async (tx) => {
    if (draw.controls.length === 0) {
      await tx.execute({
        sql: `INSERT INTO replay_stat (run_id, scope, metric, d, value_json)
              VALUES (?, ?, 'controls_none', ?, ?) ON CONFLICT DO NOTHING`,
        args: [
          fwdRunId(market),
          `ctl:${rowId}`,
          d,
          encodeJson({ note: draw.note, pool: draw.poolSize }),
        ],
      });
      return;
    }
    for (const c of draw.controls) {
      await tx.execute({
        sql: `INSERT INTO ledger_control (row_id, idx, code, entry_d, exit_d, net_num, net_den, stress_num, stress_den)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        args: [
          c.row_id,
          c.idx,
          c.code,
          c.entry_d,
          c.exit_d,
          c.net_num,
          c.net_den,
          c.stress_num,
          c.stress_den,
        ] as never,
      });
    }
  });
}

async function syncControls(
  db: Client,
  o: ForwardOptions,
): Promise<Pick<ForwardResult, "controlRows" | "controlsDeferred" | "controlsNone">> {
  const pending = await pendingControls(db, o.market);
  const out = { controlRows: 0, controlsDeferred: 0, controlsNone: 0 };
  if (pending.length === 0) return out;
  const startD = pending.map((p) => p.decisionD).sort(cmp)[0]!;
  const sessions = sessionsBetween(startD, o.d, o.calendar);
  if (sessions.length === 0) return out;
  const actions = await loadConfirmedActions(db, o.market, o.d);
  const world = new LiveWorld({
    db,
    market: o.market,
    d: o.d,
    sessions,
    params: o.params,
    actions,
    replay: o.replay,
    hours: o.hours,
  });
  const cost = costSetupFrom(o.params);
  const library = createControlLibrary(world, cost, o.masterSeed);
  const endIdx = sessions.length - 1;
  const days = await loadDayCandidates(db, o.market, [...new Set(pending.map((p) => p.decisionD))]);
  for (const p of pending) {
    const day = days.get(p.decisionD);
    const cand = day?.candidates.find(
      (c: Candidate) =>
        signalId(o.market, c.d, c.family, c.ruleVersion, c.variant, c.code) === p.signalId,
    );
    if (day === undefined || cand === undefined) continue; // no stored candidate: nothing to draw from
    if (!world.hasUniverse(p.decisionD)) {
      world.setUniverse(p.decisionD, poolFromDay(await dayInputs(db, o, p.decisionD)));
    }
    const lineage = `${o.market}:${cand.family}`;
    const rowId = ledgerRowId(lineage, cand.ruleVersion, cand.variant, cand.code, p.entryD);
    if (rowId !== p.id)
      throw new ForwardLedgerError("row_id", `ledger_row ${p.id}: id does not match its signal`);
    const decisionIdx = sessions.indexOf(p.decisionD);
    const sameDay = new Set<string>();
    for (const c of [...day.candidates, ...day.blocked])
      if (c.family === cand.family) sameDay.add(c.code);
    let draw: ControlDraw | null = null;
    for (;;) {
      try {
        await world.load([cand.code]);
        const w = walkPosition(
          world,
          {
            code: cand.code,
            plan: cand.plan,
            entryIdx: decisionIdx + 1,
            endIdx,
            advMicro: cand.adv === null ? 0n : floorRat(cand.adv),
            maxOpenMicro: cand.maxOpenMicro,
            forceExit: false,
          },
          cost,
        );
        if (w.kind === "skipped") break;
        const anchors = anchorsOf(cand, w.refInMicro);
        draw =
          anchors === "no_atr"
            ? {
                controls: [],
                forcedIdx: [],
                poolSize: 0,
                usableSize: 0,
                withReplacement: false,
                decile: null,
                note: "no_anchor_atr",
              }
            : library.draw({
                rowId,
                lineage,
                family: cand.family,
                signalCode: cand.code,
                tier: cand.tier,
                decisionIdx,
                entryIdx: decisionIdx + 1,
                endIdx,
                plan: cand.plan,
                anchors,
                excludeCodes: sameDay,
                count: o.params.stats.c2ControlsPerRow,
              });
        break;
      } catch (error) {
        if (error instanceof NeedBars) {
          await world.load([error.code]);
          continue;
        }
        throw error;
      }
    }
    if (draw === null) continue;
    // final only when every control path ended by itself and the controls had at least one session
    // to run in (a control entering on the last session of the data cannot be walked yet)
    if (draw.forcedIdx.length > 0 || decisionIdx + 1 >= endIdx) {
      out.controlsDeferred += 1;
      continue;
    }
    await insertControls(db, o.market, o.d, rowId, draw);
    if (draw.controls.length === 0) out.controlsNone += 1;
    else out.controlRows += 1;
  }
  return out;
}
