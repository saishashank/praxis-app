// Attribution (M6 T3; docs/M6_design.md 2.2, decision 25; ARN-061; D-110, D-111, D-113 proposed).
// One canonical tag record per subject: an arena `trade`, a forward `ledger_row` and a blocked or
// not-taken signal (a Decision Card with `taken = 0`, or a candidate that a gate or ARN-011 filter
// stopped). Written to `attribution` (append-only; a new version only when the content changed,
// `final = 1` once the subject has ended and its figures cannot move) and `blocked_trade` (NULL ->
// value once, final one-way).
//
// MFE / MAE (decision 25) are exact: over the holding sessions (the entry session included, the exit
// session included, an open subject up to D) the highest high and the lowest low of the RAW bars are
// re-based into the entry-fill frame with the exact quantity ratios of the confirmed splits,
// consolidations and bonus issues that went ex after the entry (the arena's `quantityRatio`, the
// D-088 rule), as fractions of the entry fill, in ppm, rounded half away from zero. Nothing is
// float: bigint micro prices and rationals.
//
// A blocked subject's counterfactual is the fixed-notional ledger path of the same signal (the
// forward ledger's row, no capacity; the same fill and exit rules, D-088). A candidate that a gate
// or filter blocked has no ledger row: it is walked with the same `walkPosition` in the nightly world
// (`attributeBlockedCandidates`, the `afterWrite` hook of the forward ledger).
//
// Look-ahead (TST-109): every reader is bounded by D. Entries after D are ignored, an exit after D is
// not seen (the subject is open as of D), bars come from the decision view of D, corporate actions
// with an ex-date after D are not loaded. Deterministic: no clock, no randomness, sorted iteration.
// Idempotent: the same state writes nothing; a stored final row that the recomputation contradicts
// RAISES (`AttributionError`).
import type { Client } from "@libsql/client";
import {
  createDecisionView,
  decisionCutoffUtc,
  type DecisionView,
  type ViewBar,
} from "@/lib/agents/decisionView";
import {
  decodeJson,
  EXIT_RULE_METRIC,
  exitRuleScope,
  fwdRunId,
  NeedBars,
  type ForwardNight,
} from "@/lib/agents/forwardLedger";
import type { BlockedCandidate } from "@/lib/agents/families";
import type { AgentParams } from "@/lib/agents/params";
import { canonicalJson } from "@/lib/arena/cohort";
import { loadConfirmedActions } from "@/lib/arena/corpActionWriter";
import { quantityRatio, type CorpActionRecord } from "@/lib/arena/corpActions";
import { toBig } from "@/lib/arena/ledgerWriter";
import { sessionsBetween, type CalendarRow } from "@/lib/data/calendar";
import { cmpRat, makeRational, mulRat, subRat, type Rational } from "@/lib/money/rational";
import { floorRat, roundHalfAwayFromZero } from "@/lib/money/round";
import { signalId } from "@/lib/replay/ledger";
import {
  costSetupFrom,
  economicsOf,
  fractionToRational,
  pairedExcess,
  walkPosition,
} from "@/lib/replay/returns";

export class AttributionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AttributionError";
    this.code = code;
  }
}

const PPM = 1_000_000n; // threshold-ok: parts per million, the unit of the ppm columns
const TAGS_VERSION = 1; // threshold-ok: version of the tag record layout
const CHUNK = 400; // threshold-ok: SQL parameter chunk size
/** Actions that change the quantity held and re-base the raw prices of the later sessions. */
const QTY_CHANGING: ReadonlySet<string> = new Set(["split", "consolidation", "bonus_issue"]);

const text = (v: unknown): string => String(v);
const textOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : text(v));
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A bigint as a SQL integer; the attribution columns are far below 2^53. */
function sql(v: bigint | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new AttributionError("overflow", `${v} does not fit INTEGER`);
  return n;
}

/** value / 1 as ppm, rounded half away from zero. */
export function ppmOf(num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new RangeError("ppm needs a positive denominator");
  return roundHalfAwayFromZero(makeRational(num * PPM, den));
}

// ---- MFE / MAE ---------------------------------------------------------------------------------------------------

export type ExcursionInput = {
  /** The entry fill (raw price, micro) in the frame of the entry session. */
  readonly entryFillMicro: bigint;
  readonly entryD: string;
  /** Exit session; ignored when after `asOfD` (the subject is then open as of D). */
  readonly exitD: string | null;
  readonly asOfD: string;
  /** The trading calendar, oldest first; it must contain `entryD`. */
  readonly sessions: readonly string[];
  /** The RAW bar of a session or null (no trading). Must not be asked beyond `asOfD`. */
  readonly bar: (d: string) => ViewBar | null;
  /** Confirmed actions of the code (any type; only quantity-changing ones re-base). */
  readonly actions: readonly CorpActionRecord[];
};

export type Excursion = {
  readonly mfePpm: bigint;
  readonly maePpm: bigint;
  /** Sessions from the entry fill to the exit fill (open: to D). */
  readonly holdSessions: number;
  readonly lastD: string;
  readonly barsUsed: number;
};

/**
 * Exact MFE / MAE of one holding. MFE = max over the holding sessions of (high x F_t - fill) / fill,
 * MAE = min of (low x F_t - fill) / fill, F_t the product of the quantity ratios that went ex after
 * the entry and on or before the session t (the arena's exact ratios): the raw price of session t
 * expressed in the entry frame. Null when the entry is after D or no session had a bar.
 */
export function computeExcursion(i: ExcursionInput): Excursion | null {
  if (i.entryFillMicro <= 0n) throw new RangeError("entry fill must be positive");
  const entryIdx = i.sessions.indexOf(i.entryD);
  if (entryIdx < 0) throw new RangeError(`entry session ${i.entryD} is not in the calendar`);
  if (i.entryD > i.asOfD) return null;
  const endD = i.exitD !== null && i.exitD <= i.asOfD ? i.exitD : i.asOfD;
  const byD = new Map<string, Rational[]>();
  for (const a of [...i.actions].sort((x, y) => cmp(x.id, y.id))) {
    if (!QTY_CHANGING.has(a.type) || a.exDate <= i.entryD || a.exDate > endD) continue;
    const list = byD.get(a.exDate);
    if (list === undefined) byD.set(a.exDate, [quantityRatio(a)]);
    else list.push(quantityRatio(a));
  }
  const fill = makeRational(i.entryFillMicro);
  let factor = makeRational(1n);
  let mfe: Rational | null = null;
  let mae: Rational | null = null;
  let used = 0;
  let endIdx = entryIdx;
  for (let k = entryIdx; k < i.sessions.length; k += 1) {
    const d = i.sessions[k]!;
    if (d > endD) break;
    endIdx = k;
    for (const r of byD.get(d) ?? []) factor = mulRat(factor, r);
    const bar = i.bar(d);
    if (bar === null) continue;
    const hi = subRat(mulRat(makeRational(bar.high), factor), fill);
    const lo = subRat(mulRat(makeRational(bar.low), factor), fill);
    if (mfe === null || cmpRat(hi, mfe) > 0) mfe = hi;
    if (mae === null || cmpRat(lo, mae) < 0) mae = lo;
    used += 1;
  }
  if (mfe === null || mae === null) return null;
  const ppm = (r: Rational): bigint =>
    roundHalfAwayFromZero(mulRat(mulRat(r, makeRational(1n, i.entryFillMicro)), makeRational(PPM)));
  return {
    mfePpm: ppm(mfe),
    maePpm: ppm(mae),
    holdSessions: endIdx - entryIdx,
    lastD: i.sessions[endIdx]!,
    barsUsed: used,
  };
}

// ---- the record ----------------------------------------------------------------------------------------------------

export type SubjectKind = "trade" | "ledger_row" | "blocked";

export type AttributionRecord = {
  readonly kind: SubjectKind;
  readonly id: string;
  readonly market: string;
  readonly d: string;
  readonly final: boolean;
  readonly tags: Record<string, unknown>;
  readonly mfePpm: bigint | null;
  readonly maePpm: bigint | null;
  readonly holdSessions: number | null;
  readonly costMicro: bigint | null;
  readonly slippageMicro: bigint | null;
  readonly netMicro: bigint | null;
  readonly excessPpm: bigint | null;
  readonly stressPpm: bigint | null;
};

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

const CONTENT = [
  "tags_json",
  "mfe_ppm",
  "mae_ppm",
  "hold_sessions",
  "cost_micro",
  "slippage_micro",
  "net_micro",
  "excess_ppm",
  "stress_ppm",
] as const;

function contentOf(r: AttributionRecord): Record<(typeof CONTENT)[number], unknown> {
  return {
    tags_json: canonicalJson(r.tags),
    mfe_ppm: sql(r.mfePpm),
    mae_ppm: sql(r.maePpm),
    hold_sessions: r.holdSessions,
    cost_micro: sql(r.costMicro),
    slippage_micro: sql(r.slippageMicro),
    net_micro: sql(r.netMicro),
    excess_ppm: sql(r.excessPpm),
    stress_ppm: sql(r.stressPpm),
  };
}

const same = (a: unknown, b: unknown): boolean =>
  a === null || a === undefined
    ? b === null || b === undefined
    : b !== null && b !== undefined && String(a) === String(b);

export type PutOutcome = "inserted" | "unchanged";

/** Append a new version when the content moved; a final subject never changes (a difference RAISES). */
export async function putAttribution(tx: Exec, r: AttributionRecord): Promise<PutOutcome> {
  const want = contentOf(r);
  const last = await tx.execute({
    sql: "SELECT * FROM attribution WHERE subject_kind = ? AND subject_id = ? ORDER BY version DESC LIMIT 1",
    args: [r.kind, r.id],
  });
  let version = 1;
  if (last.rows.length > 0) {
    const row = last.rows[0]!;
    const equal = CONTENT.every((c) => same(row[c], want[c]));
    const wasFinal = toBig(row.final) === 1n;
    if (wasFinal) {
      if (!equal) {
        throw new AttributionError(
          "final_conflict",
          `attribution ${r.kind} ${r.id}: final row differs`,
        );
      }
      return "unchanged";
    }
    if (equal && toBig(row.final) === (r.final ? 1n : 0n)) return "unchanged";
    version = Number(toBig(row.version)) + 1;
  }
  await tx.execute({
    sql: `INSERT INTO attribution (subject_kind, subject_id, version, market, d, final, tags_json, mfe_ppm,
            mae_ppm, hold_sessions, cost_micro, slippage_micro, net_micro, excess_ppm, stress_ppm)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      r.kind,
      r.id,
      version,
      r.market,
      r.d,
      r.final ? 1 : 0,
      ...CONTENT.map((c) => want[c]),
    ] as never,
  });
  return "inserted";
}

export type BlockedRecord = {
  readonly signalId: string;
  readonly executionId: string;
  readonly market: string;
  readonly d: string;
  readonly reason: string;
  readonly cardId: string | null;
  readonly counterfactualRowId: string | null;
  readonly counterfactualNetPpm: bigint | null;
  readonly final: boolean;
};

/** Insert, or apply the one-way NULL -> value / final transition; a contradiction RAISES. */
export async function putBlocked(tx: Exec, b: BlockedRecord): Promise<PutOutcome> {
  const cur = await tx.execute({
    sql: "SELECT * FROM blocked_trade WHERE signal_id = ? AND execution_id = ?",
    args: [b.signalId, b.executionId],
  });
  const net = sql(b.counterfactualNetPpm);
  if (cur.rows.length === 0) {
    await tx.execute({
      sql: `INSERT INTO blocked_trade (signal_id, execution_id, market, d, reason, card_id,
              counterfactual_row_id, counterfactual_net_ppm, final) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        b.signalId,
        b.executionId,
        b.market,
        b.d,
        b.reason,
        b.cardId,
        b.counterfactualRowId,
        net,
        b.final ? 1 : 0,
      ] as never,
    });
    return "inserted";
  }
  const row = cur.rows[0]!;
  const fixed =
    same(row.market, b.market) &&
    same(row.d, b.d) &&
    same(row.reason, b.reason) &&
    same(row.card_id, b.cardId);
  const rowIdOk =
    row.counterfactual_row_id === null || same(row.counterfactual_row_id, b.counterfactualRowId);
  const netOk = row.counterfactual_net_ppm === null || same(row.counterfactual_net_ppm, net);
  if (!fixed || !rowIdOk || !netOk) {
    throw new AttributionError(
      "blocked_conflict",
      `blocked_trade ${b.signalId}/${b.executionId} differs`,
    );
  }
  const wasFinal = toBig(row.final) === 1n;
  if (wasFinal) {
    if (
      !same(row.counterfactual_row_id, b.counterfactualRowId) ||
      !same(row.counterfactual_net_ppm, net)
    ) {
      throw new AttributionError(
        "blocked_conflict",
        `blocked_trade ${b.signalId}/${b.executionId}: final row differs`,
      );
    }
    return "unchanged";
  }
  const moves =
    (row.counterfactual_row_id === null && b.counterfactualRowId !== null) ||
    (row.counterfactual_net_ppm === null && net !== null) ||
    b.final;
  if (!moves) return "unchanged";
  await tx.execute({
    sql: `UPDATE blocked_trade SET counterfactual_row_id = ?, counterfactual_net_ppm = ?, final = ?
          WHERE signal_id = ? AND execution_id = ?`,
    args: [
      b.counterfactualRowId ?? textOrNull(row.counterfactual_row_id),
      net ?? (row.counterfactual_net_ppm === null ? null : sql(toBig(row.counterfactual_net_ppm))),
      b.final ? 1 : 0,
      b.signalId,
      b.executionId,
    ] as never,
  });
  return "inserted";
}

// ---- readers bounded by D ------------------------------------------------------------------------------------------

export type AttributionOptions = {
  readonly market: string;
  /** The computation date: nothing later is read. */
  readonly d: string;
  readonly calendar: readonly CalendarRow[];
  readonly params: AgentParams;
  /** As the forward ledger: false bounds bars by their ingest time (production). */
  readonly replay: boolean;
};

export type AttributionCounts = { inserted: number; unchanged: number; final: number };
export type AttributionResult = {
  readonly trades: AttributionCounts;
  readonly ledgerRows: AttributionCounts;
  readonly blocked: AttributionCounts & { blockedTrades: number };
};

const zero = (): AttributionCounts => ({ inserted: 0, unchanged: 0, final: 0 });

/** Raw bars by code from the decision view of D, loaded once per code back to its first need. */
class BarBook {
  private readonly bars = new Map<string, Map<string, ViewBar>>();
  private readonly view: DecisionView;
  constructor(
    private readonly sessions: readonly string[],
    o: AttributionOptions,
    db: Client,
  ) {
    this.view = createDecisionView(db, {
      market: o.market,
      d: o.d,
      cutoff: decisionCutoffUtc(o.d, o.params.decisionCutoff),
      liveIngestBound: !o.replay,
    });
  }
  async load(code: string, fromD: string): Promise<void> {
    if (this.bars.has(code)) return;
    const i = this.sessions.indexOf(fromD);
    const count = (i < 0 ? this.sessions.length : this.sessions.length - i) + 1;
    const list = await this.view.bars(code, count);
    this.bars.set(code, new Map(list.map((b) => [b.d, b])));
  }
  bar(code: string, d: string): ViewBar | null {
    const m = this.bars.get(code);
    if (m === undefined) throw new NeedBars(code);
    return m.get(d) ?? null;
  }
}

async function actionsByCode(
  db: Client,
  market: string,
  d: string,
): Promise<Map<string, CorpActionRecord[]>> {
  const out = new Map<string, CorpActionRecord[]>();
  for (const a of await loadConfirmedActions(db, market, d)) {
    if (!QTY_CHANGING.has(a.type)) continue;
    const l = out.get(a.code);
    if (l === undefined) out.set(a.code, [a]);
    else l.push(a);
  }
  return out;
}

async function sessionsFrom(o: AttributionOptions, first: string): Promise<string[]> {
  return first > o.d ? [] : sessionsBetween(first, o.d, o.calendar);
}

const jsonOr = (v: unknown): unknown => {
  if (v === null || v === undefined) return null;
  try {
    return JSON.parse(text(v)) as unknown;
  } catch {
    return null;
  }
};

type SignalRow = Record<string, unknown>;

/** The tags every subject shares: what the signal was and why it fired (rule traces, group, class). */
function signalTags(s: SignalRow): Record<string, unknown> {
  const ev = jsonOr(s.evidence_json) as Record<string, unknown> | null;
  return {
    classes: jsonOr(s.classes),
    code: text(s.code),
    contributors: ev?.contributors ?? [],
    decided_d: text(s.d),
    events: { group_key: textOrNull(s.group_key) },
    family: text(s.family),
    filters: jsonOr(s.rules_json) ?? [],
    flags: ev?.flags ?? [],
    regime: text(s.regime),
    rule_version: text(s.rule_version),
    signal_id: text(s.id),
    tier: ev?.tier ?? null,
    variant: text(s.variant),
  };
}

// ---- forward ledger rows -------------------------------------------------------------------------------------------

type LedgerFacts = {
  readonly closed: boolean;
  readonly costMicro: bigint;
  readonly slippageMicro: bigint;
  readonly netMicro: bigint | null;
  readonly netNum: bigint | null;
  readonly netDen: bigint;
  readonly stressPpm: bigint | null;
  readonly exitRule: string | null;
};

/** Amounts of a ledger row as of D from its stored columns (an exit after D is not seen). */
function ledgerFacts(row: SignalRow, d: string, exitRule: string | null): LedgerFacts {
  const qty = toBig(row.qty);
  const fillIn = toBig(row.fill_in_micro);
  const brokIn = toBig(row.brok_in_micro);
  const grossDen = row.gross_den === null ? null : toBig(row.gross_den);
  const closed = row.exit_d !== null && text(row.exit_d) <= d;
  const costIn = qty * fillIn + brokIn;
  const slipIn = grossDen === null ? 0n : qty * fillIn - grossDen;
  if (!closed || grossDen === null) {
    return {
      closed: false,
      costMicro: brokIn,
      slippageMicro: slipIn,
      netMicro: null,
      netNum: null,
      netDen: costIn,
      stressPpm: null,
      exitRule: null,
    };
  }
  const qtyOut = toBig(row.qty_out);
  const fillOut = toBig(row.fill_out_micro);
  const brokOut = toBig(row.brok_out_micro);
  const div = toBig(row.dividend_micro);
  const stressIn = toBig(row.stress_in_micro);
  const stressOut = toBig(row.stress_out_micro);
  // a corporate-action exit stores the same exact proceeds in the stressed twin (no slippage)
  const corp = exitRule !== null && exitRule.startsWith("corp_action:");
  const proceeds = (corp ? stressOut - div : qtyOut * fillOut - brokOut) + div;
  const grossNum = toBig(row.gross_num);
  const refOutValue = grossNum + grossDen - div; // qty_out x ref_out
  return {
    closed: true,
    costMicro: brokIn + brokOut,
    slippageMicro: slipIn + (refOutValue - qtyOut * fillOut),
    netMicro: proceeds - costIn,
    netNum: proceeds - costIn,
    netDen: costIn,
    stressPpm: ppmOf(stressOut - stressIn, stressIn),
    exitRule,
  };
}

function exitReason(tag: string | null, rule: string | null): string | null {
  if (tag === null) return null;
  if (tag === "IS") return "IS";
  if (rule !== null && rule.startsWith("corp_action:"))
    return `terminal:${rule.slice("corp_action:".length)}`;
  return rule === null || rule === "cs" ? "CS" : `CS:${rule}`;
}

async function exitRules(
  db: Client,
  market: string,
  ids: readonly string[],
): Promise<Map<string, { rule: string; flags: string[] }>> {
  const out = new Map<string, { rule: string; flags: string[] }>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    if (part.length === 0) continue;
    const rs = await db.execute({
      sql: `SELECT scope, value_json FROM replay_stat WHERE run_id = ? AND metric = ?
            AND scope IN (${part.map(() => "?").join(", ")})`,
      args: [fwdRunId(market), EXIT_RULE_METRIC, ...part.map(exitRuleScope)],
    });
    for (const r of rs.rows) {
      const v = decodeJson<{ rule: string; flags: string[] }>(text(r.value_json));
      out.set(text(r.scope).slice("exit:".length), v);
    }
  }
  return out;
}

async function controlsOf(db: Client, ids: readonly string[]): Promise<Map<string, Rational[]>> {
  const out = new Map<string, Rational[]>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    if (part.length === 0) continue;
    const rs = await db.execute({
      sql: `SELECT row_id, net_num, net_den FROM ledger_control
            WHERE row_id IN (${part.map(() => "?").join(", ")}) ORDER BY row_id, idx`,
      args: part,
    });
    for (const r of rs.rows) {
      const k = text(r.row_id);
      const l = out.get(k) ?? [];
      l.push(fractionToRational({ num: toBig(r.net_num), den: toBig(r.net_den) }));
      out.set(k, l);
    }
  }
  return out;
}

async function noControls(
  db: Client,
  market: string,
  ids: readonly string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    if (part.length === 0) continue;
    const rs = await db.execute({
      sql: `SELECT scope FROM replay_stat WHERE run_id = ? AND metric = 'controls_none'
            AND scope IN (${part.map(() => "?").join(", ")})`,
      args: [fwdRunId(market), ...part.map((id) => `ctl:${id}`)],
    });
    for (const r of rs.rows) out.add(text(r.scope).slice("ctl:".length));
  }
  return out;
}

const LEDGER_SQL = `SELECT lr.*, s.id AS sig_id, s.d AS d, s.family, s.rule_version, s.variant, s.code, s.regime,
        s.rules_json, s.evidence_json, s.classes, s.group_key
      FROM ledger_row lr JOIN signal s ON s.id = lr.signal_id
      WHERE s.market = ? AND lr.forward = 1 AND lr.entry_d <= ?
        AND NOT EXISTS (SELECT 1 FROM attribution a WHERE a.subject_kind = 'ledger_row'
                        AND a.subject_id = lr.id AND a.final = 1)
      ORDER BY lr.id`;

type LedgerRowAttr = { record: AttributionRecord; facts: LedgerFacts; excursion: Excursion | null };

async function attributeLedgerRows(
  db: Client,
  o: AttributionOptions,
  actions: ReadonlyMap<string, CorpActionRecord[]>,
): Promise<{ counts: AttributionCounts; byRow: Map<string, LedgerRowAttr> }> {
  const counts = zero();
  const rows = (await db.execute({ sql: LEDGER_SQL, args: [o.market, o.d] })).rows.map((r) => ({
    ...r,
  }));
  const byRow = new Map<string, LedgerRowAttr>();
  if (rows.length === 0) return { counts, byRow };
  const first = rows.map((r) => text(r.entry_d)).sort(cmp)[0]!;
  const sessions = await sessionsFrom(o, first);
  const book = new BarBook(sessions, o, db);
  for (const code of [...new Set(rows.map((r) => text(r.code)))].sort(cmp)) {
    await book.load(
      code,
      rows
        .filter((r) => text(r.code) === code)
        .map((r) => text(r.entry_d))
        .sort(cmp)[0]!,
    );
  }
  const ids = rows.map((r) => text(r.id));
  const rules = await exitRules(db, o.market, ids);
  const ctl = await controlsOf(db, ids);
  const none = await noControls(db, o.market, ids);
  const records: AttributionRecord[] = [];
  for (const row of rows) {
    const id = text(row.id);
    const code = text(row.code);
    const rule = rules.get(id)?.rule ?? null;
    const facts = ledgerFacts(row, o.d, rule);
    const ex = computeExcursion({
      entryFillMicro: toBig(row.fill_in_micro),
      entryD: text(row.entry_d),
      exitD: textOrNull(row.exit_d),
      asOfD: o.d,
      sessions,
      bar: (d) => book.bar(code, d),
      actions: actions.get(code) ?? [],
    });
    if (ex === null) continue;
    const controls = ctl.get(id) ?? [];
    const controlsFinal = controls.length > 0 || none.has(id);
    const net = facts.netNum === null ? null : makeRational(facts.netNum, facts.netDen);
    const excess = net !== null && controls.length > 0 ? pairedExcess(net, controls) : null;
    const tags = {
      ...signalTags({ ...row, id: row.sig_id }),
      costs: {
        brokerage_micro: String(facts.costMicro),
        slippage_micro: String(facts.slippageMicro),
      },
      entry_d: text(row.entry_d),
      exit:
        row.exit_tag === null || !facts.closed
          ? null
          : {
              d: text(row.exit_d),
              reason: exitReason(text(row.exit_tag), rule),
              tag: text(row.exit_tag),
            },
      flags_walk: rules.get(id)?.flags ?? [],
      kind: "ledger_row",
      ledger_row_id: id,
      timed: toBig(row.timed) === 1n,
      v: TAGS_VERSION,
    };
    const record: AttributionRecord = {
      kind: "ledger_row",
      id,
      market: o.market,
      d: o.d,
      final: facts.closed && controlsFinal,
      tags,
      mfePpm: ex.mfePpm,
      maePpm: ex.maePpm,
      holdSessions: ex.holdSessions,
      costMicro: facts.costMicro,
      slippageMicro: facts.slippageMicro,
      netMicro: facts.netMicro,
      excessPpm: excess === null ? null : roundHalfAwayFromZero(mulRat(excess, makeRational(PPM))),
      stressPpm: facts.stressPpm,
    };
    records.push(record);
    byRow.set(id, { record, facts, excursion: ex });
  }
  await withTx(db, async (tx) => {
    for (const r of records) {
      const out = await putAttribution(tx, r);
      counts[out] += 1;
      if (r.final) counts.final += 1;
    }
  });
  return { counts, byRow };
}

// ---- arena trades --------------------------------------------------------------------------------------------------

const TRADE_SQL = `SELECT t.id, t.cohort_id, t.code, t.exit_type, t.legacy,
        ef.d AS entry_d, ef.qty AS entry_qty, ef.fill_price_micro AS entry_fill, ef.ref_price_micro AS entry_ref,
        ef.value_micro AS entry_value, ef.brokerage_micro AS entry_brok, ef.order_id AS entry_order,
        xf.d AS exit_d, xf.qty AS exit_qty, xf.fill_price_micro AS exit_fill, xf.ref_price_micro AS exit_ref,
        xf.value_micro AS exit_value, xf.brokerage_micro AS exit_brok, xf.rule AS exit_fill_rule,
        c.execution_id, c.rule_version AS cohort_rule_version, e.kind AS exec_kind, e.family AS exec_family,
        e.variant AS exec_variant, o.signal_id AS signal_id, o.card_id AS card_id, o.tier AS tier
      FROM trade t
      JOIN fill ef ON ef.id = t.entry_fill_id
      LEFT JOIN fill xf ON xf.id = t.exit_fill_id
      JOIN cohort c ON c.id = t.cohort_id
      JOIN execution e ON e.id = c.execution_id
      LEFT JOIN arena_order o ON o.id = ef.order_id
      WHERE ef.d <= ?
        AND NOT EXISTS (SELECT 1 FROM attribution a WHERE a.subject_kind = 'trade'
                        AND a.subject_id = t.id AND a.final = 1)
      ORDER BY t.id`;

async function signalsById(db: Client, ids: readonly string[]): Promise<Map<string, SignalRow>> {
  const out = new Map<string, SignalRow>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    if (part.length === 0) continue;
    const rs = await db.execute({
      sql: `SELECT * FROM signal WHERE id IN (${part.map(() => "?").join(", ")})`,
      args: part,
    });
    for (const r of rs.rows) out.set(text(r.id), { ...r });
  }
  return out;
}

async function attributeTrades(
  db: Client,
  o: AttributionOptions,
  actions: ReadonlyMap<string, CorpActionRecord[]>,
): Promise<AttributionCounts> {
  const counts = zero();
  const rows = (await db.execute({ sql: TRADE_SQL, args: [o.d] })).rows.map((r) => ({ ...r }));
  if (rows.length === 0) return counts;
  const first = rows.map((r) => text(r.entry_d)).sort(cmp)[0]!;
  const sessions = await sessionsFrom(o, first);
  const book = new BarBook(sessions, o, db);
  for (const code of [...new Set(rows.map((r) => text(r.code)))].sort(cmp)) {
    await book.load(
      code,
      rows
        .filter((r) => text(r.code) === code)
        .map((r) => text(r.entry_d))
        .sort(cmp)[0]!,
    );
  }
  const sigs = await signalsById(
    db,
    [...new Set(rows.flatMap((r) => (r.signal_id === null ? [] : [text(r.signal_id)])))].sort(cmp),
  );
  const records: AttributionRecord[] = [];
  for (const r of rows) {
    const code = text(r.code);
    const closed = r.exit_d !== null && text(r.exit_d) <= o.d;
    const legacy = toBig(r.legacy) === 1n;
    const ex = computeExcursion({
      entryFillMicro: toBig(r.entry_fill),
      entryD: text(r.entry_d),
      exitD: closed ? text(r.exit_d) : null,
      asOfD: o.d,
      sessions,
      bar: (d) => book.bar(code, d),
      actions: actions.get(code) ?? [],
    });
    if (ex === null) continue;
    const entryQty = toBig(r.entry_qty);
    const slipIn = entryQty * (toBig(r.entry_fill) - toBig(r.entry_ref));
    let brok = toBig(r.entry_brok);
    let slip = slipIn;
    let net: bigint | null = null;
    if (closed) {
      const xq = toBig(r.exit_qty);
      brok += toBig(r.exit_brok);
      slip += xq * (toBig(r.exit_ref) - toBig(r.exit_fill));
      net = toBig(r.exit_value) - toBig(r.exit_brok) - (toBig(r.entry_value) + toBig(r.entry_brok));
    }
    const sig = r.signal_id === null ? undefined : sigs.get(text(r.signal_id));
    const exitType = textOrNull(r.exit_type);
    const reason = !closed
      ? legacy
        ? "legacy"
        : null
      : textOrNull(r.exit_fill_rule) === "gap_open"
        ? "gap"
        : exitType;
    const tags = {
      ...(sig === undefined
        ? {
            family: textOrNull(r.exec_family),
            variant: textOrNull(r.exec_variant),
            rule_version: text(r.cohort_rule_version),
            tier: textOrNull(r.tier),
          }
        : { ...signalTags(sig), tier: textOrNull(r.tier) ?? signalTags(sig).tier }),
      card_id: textOrNull(r.card_id),
      code,
      cohort_id: text(r.cohort_id),
      costs: { brokerage_micro: String(brok), slippage_micro: String(slip) },
      entry_d: text(r.entry_d),
      execution: { id: text(r.execution_id), kind: text(r.exec_kind) },
      exit: reason === null ? null : { d: closed ? text(r.exit_d) : null, reason, tag: exitType },
      kind: "trade",
      trade_id: text(r.id),
      v: TAGS_VERSION,
    };
    records.push({
      kind: "trade",
      id: text(r.id),
      market: o.market,
      d: o.d,
      final: closed || legacy,
      tags,
      mfePpm: ex.mfePpm,
      maePpm: ex.maePpm,
      holdSessions: ex.holdSessions,
      costMicro: brok,
      slippageMicro: slip,
      netMicro: net,
      excessPpm: null,
      stressPpm: null,
    });
  }
  await withTx(db, async (tx) => {
    for (const r of records) {
      const out = await putAttribution(tx, r);
      counts[out] += 1;
      if (r.final) counts.final += 1;
    }
  });
  return counts;
}

// ---- blocked and not-taken signals ---------------------------------------------------------------------------------

const BLOCKED_SQL = `SELECT dc.id AS card_id, dc.signal_id, dc.execution_id, dc.not_taken_reason,
        s.id, s.d, s.family, s.rule_version, s.variant, s.code, s.regime, s.rules_json, s.evidence_json,
        s.classes, s.group_key
      FROM decision_card dc JOIN signal s ON s.id = dc.signal_id
      WHERE dc.taken = 0 AND s.market = ? AND s.d <= ?
        AND NOT EXISTS (SELECT 1 FROM blocked_trade b WHERE b.signal_id = dc.signal_id
                        AND b.execution_id = dc.execution_id AND b.final = 1)
      ORDER BY dc.signal_id, dc.execution_id`;

async function attributeBlockedCards(
  db: Client,
  o: AttributionOptions,
  ledger: ReadonlyMap<string, LedgerRowAttr>,
  sessionsAll: readonly string[],
): Promise<AttributionResult["blocked"]> {
  const counts = { ...zero(), blockedTrades: 0 };
  const rows = (await db.execute({ sql: BLOCKED_SQL, args: [o.market, o.d] })).rows.map((r) => ({
    ...r,
  }));
  if (rows.length === 0) return counts;
  const sigIds = [...new Set(rows.map((r) => text(r.signal_id)))].sort(cmp);
  // the ledger path of each signal: the row opened for it (any age), as of D
  const paths = new Map<string, SignalRow>();
  for (let i = 0; i < sigIds.length; i += CHUNK) {
    const part = sigIds.slice(i, i + CHUNK);
    const rs = await db.execute({
      sql: `SELECT * FROM ledger_row WHERE signal_id IN (${part.map(() => "?").join(", ")}) ORDER BY id`,
      args: part,
    });
    for (const r of rs.rows)
      if (!paths.has(text(r.signal_id))) paths.set(text(r.signal_id), { ...r });
  }
  const pathIds = [...paths.values()].map((r) => text(r.id)).sort(cmp);
  const rules = await exitRules(db, o.market, pathIds);
  const byId = new Map([...paths.values()].map((r) => [text(r.id), r]));
  const attrOf = async (
    rowId: string,
  ): Promise<{ record: AttributionRecord; facts: LedgerFacts } | null> => {
    const hit = ledger.get(rowId);
    if (hit !== undefined) return hit;
    // a finished ledger row is not recomputed: read its final attribution and amounts
    const a = await db.execute({
      sql: "SELECT * FROM attribution WHERE subject_kind = 'ledger_row' AND subject_id = ? ORDER BY version DESC LIMIT 1",
      args: [rowId],
    });
    if (a.rows.length === 0) return null;
    const row = a.rows[0]!;
    const lr = byId.get(rowId);
    if (lr === undefined) return null;
    const facts = ledgerFacts(lr, o.d, rules.get(rowId)?.rule ?? null);
    const rec: AttributionRecord = {
      kind: "ledger_row",
      id: rowId,
      market: text(row.market),
      d: text(row.d),
      final: toBig(row.final) === 1n,
      tags: JSON.parse(text(row.tags_json)) as Record<string, unknown>,
      mfePpm: row.mfe_ppm === null ? null : toBig(row.mfe_ppm),
      maePpm: row.mae_ppm === null ? null : toBig(row.mae_ppm),
      holdSessions: row.hold_sessions === null ? null : Number(toBig(row.hold_sessions)),
      costMicro: row.cost_micro === null ? null : toBig(row.cost_micro),
      slippageMicro: row.slippage_micro === null ? null : toBig(row.slippage_micro),
      netMicro: row.net_micro === null ? null : toBig(row.net_micro),
      excessPpm: row.excess_ppm === null ? null : toBig(row.excess_ppm),
      stressPpm: row.stress_ppm === null ? null : toBig(row.stress_ppm),
    };
    return { record: rec, facts };
  };
  const out: { attr: AttributionRecord; blocked: BlockedRecord }[] = [];
  for (const r of rows) {
    const sid = text(r.signal_id);
    const decidedD = text(r.d);
    const path = paths.get(sid);
    let counterfactualRowId: string | null = null;
    let netPpm: bigint | null = null;
    let final = false;
    let cf: { record: AttributionRecord; facts: LedgerFacts } | null = null;
    if (path !== undefined && text(path.entry_d) <= o.d) {
      counterfactualRowId = text(path.id);
      cf = await attrOf(counterfactualRowId);
      if (cf !== null && cf.facts.closed && cf.facts.netNum !== null) {
        netPpm = ppmOf(cf.facts.netNum, cf.facts.netDen);
        final = true;
      }
    } else if (path === undefined) {
      const i = sessionsAll.indexOf(decidedD);
      const entryD = i < 0 ? null : (sessionsAll[i + 1] ?? null);
      // the entry session has been and the ledger opened nothing: no ledger path exists (final, NULL)
      if (entryD !== null && entryD <= o.d) final = true;
    }
    const tags = {
      ...signalTags(r),
      blocked: { card_id: text(r.card_id), reason: text(r.not_taken_reason), source: "card" },
      counterfactual: {
        final,
        ledger_row_id: counterfactualRowId,
        net_ppm: netPpm === null ? null : String(netPpm),
        path: counterfactualRowId === null ? (final ? "none" : "pending") : "ledger_row",
      },
      execution: { id: text(r.execution_id) },
      kind: "blocked",
      v: TAGS_VERSION,
    };
    const base = cf?.record ?? null;
    out.push({
      attr: {
        kind: "blocked",
        id: `${sid}|${text(r.execution_id)}`,
        market: o.market,
        d: o.d,
        final,
        tags,
        mfePpm: base?.mfePpm ?? null,
        maePpm: base?.maePpm ?? null,
        holdSessions: base?.holdSessions ?? null,
        costMicro: base?.costMicro ?? null,
        slippageMicro: base?.slippageMicro ?? null,
        netMicro: base?.netMicro ?? null,
        excessPpm: base?.excessPpm ?? null,
        stressPpm: base?.stressPpm ?? null,
      },
      blocked: {
        signalId: sid,
        executionId: text(r.execution_id),
        market: o.market,
        d: decidedD,
        reason: text(r.not_taken_reason),
        cardId: text(r.card_id),
        counterfactualRowId,
        counterfactualNetPpm: netPpm,
        final,
      },
    });
  }
  await withTx(db, async (tx) => {
    for (const x of out) {
      if ((await putBlocked(tx, x.blocked)) === "inserted") counts.blockedTrades += 1;
      counts[await putAttribution(tx, x.attr)] += 1;
      if (x.attr.final) counts.final += 1;
    }
  });
  return counts;
}

// ---- the nightly entry point -----------------------------------------------------------------------------------------

/**
 * Attribution of every trade, forward ledger row and not-taken signal as of D (nightly, after the
 * forward ledger sync). Finished subjects are skipped; open ones receive a new version when their
 * figures moved. Blocked candidates of the gates are handled by `attributeBlockedCandidates`.
 */
export async function attributeNight(
  db: Client,
  o: AttributionOptions,
): Promise<AttributionResult> {
  const actions = await actionsByCode(db, o.market, o.d);
  const { counts: ledgerRows, byRow } = await attributeLedgerRows(db, o, actions);
  const trades = await attributeTrades(db, o, actions);
  const firstSignal = await db.execute({
    sql: "SELECT MIN(d) AS d FROM signal WHERE market = ?",
    args: [o.market],
  });
  const sessionsAll =
    firstSignal.rows.length === 0 || firstSignal.rows[0]!.d === null
      ? []
      : await sessionsFrom(o, text(firstSignal.rows[0]!.d));
  const blocked = await attributeBlockedCards(db, o, byRow, sessionsAll);
  return { trades, ledgerRows, blocked };
}

// ---- candidates blocked by a gate or filter ------------------------------------------------------------------------

/** Execution id of the family-level block (no execution took part: the gate fired before sizing). */
export const GATE_EXECUTION_ID = "gate";

export type BlockedCandidateResult = {
  readonly considered: number;
  readonly resolved: number;
  readonly pending: number;
  readonly noPath: number;
};

/**
 * The `afterWrite` hook of the forward ledger: every candidate that met the entry rules but was
 * blocked by a gate or an ARN-011 filter (stored with its reasons) is walked from the next open with
 * the SAME `walkPosition` the ledger uses, fixed notional, no capacity. A walk that has not exited
 * stays pending and is repeated while its decision session is inside the window; an entry that
 * cannot be filled is final with no outcome.
 */
export async function attributeBlockedCandidates(
  night: ForwardNight,
): Promise<BlockedCandidateResult> {
  const { db, market, d, params, window, writeFrom, stored, world } = night;
  const cost = costSetupFrom(params);
  const endIdx = window.length - 1;
  const todo: { day: string; idx: number; c: BlockedCandidate }[] = [];
  for (const day of [...stored.keys()].sort(cmp)) {
    if (day < writeFrom || day > d) continue;
    const idx = window.indexOf(day);
    if (idx < 0) continue;
    for (const c of stored.get(day)!.blocked) todo.push({ day, idx, c });
  }
  const result = { considered: 0, resolved: 0, pending: 0, noPath: 0 };
  if (todo.length === 0) return result;
  await world.load([...new Set(todo.map((t) => t.c.code))].sort(cmp));
  const actions = await actionsByCode(db, market, d);
  const records: { attr: AttributionRecord; blocked: BlockedRecord }[] = [];
  for (const t of todo) {
    const c = t.c;
    const sid = signalId(market, c.d, c.family, c.ruleVersion, c.variant, c.code);
    const reason = `gate:${[...c.reasons].sort(cmp).join("+")}`;
    result.considered += 1;
    const base = {
      ...signalTagsOfCandidate(market, c),
      blocked: { card_id: null, reason, reasons: [...c.reasons].sort(cmp), source: "gate" },
      execution: { id: GATE_EXECUTION_ID },
      kind: "blocked",
      v: TAGS_VERSION,
    };
    const blockedBase: BlockedRecord = {
      signalId: sid,
      executionId: GATE_EXECUTION_ID,
      market,
      d: c.d,
      reason,
      cardId: null,
      counterfactualRowId: null,
      counterfactualNetPpm: null,
      final: false,
    };
    const attrBase: AttributionRecord = {
      kind: "blocked",
      id: `${sid}|${GATE_EXECUTION_ID}`,
      market,
      d,
      final: false,
      tags: {
        ...base,
        counterfactual: { final: false, ledger_row_id: null, net_ppm: null, path: "pending" },
      },
      mfePpm: null,
      maePpm: null,
      holdSessions: null,
      costMicro: null,
      slippageMicro: null,
      netMicro: null,
      excessPpm: null,
      stressPpm: null,
    };
    if (t.idx >= endIdx) {
      result.pending += 1;
      records.push({ attr: attrBase, blocked: blockedBase });
      continue;
    }
    const w = walkPosition(
      world,
      {
        code: c.code,
        plan: c.plan,
        entryIdx: t.idx + 1,
        endIdx,
        advMicro: c.adv === null ? 0n : floorRat(c.adv),
        maxOpenMicro: c.maxOpenMicro,
        forceExit: false,
      },
      cost,
    );
    if (w.kind === "skipped") {
      result.noPath += 1;
      const tags = {
        ...base,
        counterfactual: {
          final: true,
          ledger_row_id: null,
          net_ppm: null,
          path: `skipped:${w.reason}`,
        },
      };
      records.push({
        attr: { ...attrBase, final: true, tags },
        blocked: { ...blockedBase, final: true },
      });
      continue;
    }
    const sessions = window;
    const ex = computeExcursion({
      entryFillMicro: w.fillInMicro,
      entryD: w.entryD,
      exitD: w.exit === null ? null : w.exit.d,
      asOfD: d,
      sessions,
      bar: (day) => world.bar(c.code, day),
      actions: actions.get(c.code) ?? [],
    });
    const e = economicsOf(w);
    const x = w.exit;
    const netPpm = e === null ? null : ppmOf(e.net.num, e.net.den);
    const closed = x !== null && e !== null;
    if (closed) result.resolved += 1;
    else result.pending += 1;
    const slip =
      w.qty * (w.fillInMicro - w.refInMicro) +
      (x === null ? 0n : x.qtyOut * (x.refOutMicro - x.fillOutMicro));
    const tags = {
      ...base,
      counterfactual: {
        final: closed,
        ledger_row_id: null,
        net_ppm: netPpm === null ? null : String(netPpm),
        path: "walk",
      },
      entry_d: w.entryD,
      exit: x === null ? null : { d: x.d, reason: exitReason(x.tag, x.rule), tag: x.tag },
    };
    records.push({
      attr: {
        ...attrBase,
        final: closed,
        tags,
        mfePpm: ex?.mfePpm ?? null,
        maePpm: ex?.maePpm ?? null,
        holdSessions: ex?.holdSessions ?? null,
        costMicro: w.brokInMicro + (x === null ? 0n : x.brokOutMicro),
        slippageMicro: slip,
        netMicro: e === null ? null : e.net.num,
        excessPpm: null,
        stressPpm: e === null ? null : ppmOf(e.stress.num, e.stress.den),
      },
      blocked: { ...blockedBase, counterfactualNetPpm: netPpm, final: closed },
    });
  }
  await withTx(db, async (tx) => {
    for (const r of records) {
      await putBlocked(tx, r.blocked);
      await putAttribution(tx, r.attr);
    }
  });
  return result;
}

function signalTagsOfCandidate(market: string, c: BlockedCandidate): Record<string, unknown> {
  return {
    classes: c.classes === null ? null : [...c.classes],
    code: c.code,
    contributors: [...c.contributors].sort(cmp),
    decided_d: c.d,
    events: { group_key: c.groupKey },
    family: c.family,
    filters: c.rules.map((r) => ({
      pass: r.pass,
      rule: r.id,
      threshold: r.threshold,
      value: r.value,
    })),
    flags: [...c.flags],
    regime: c.regime,
    rule_version: c.ruleVersion,
    signal_id: signalId(market, c.d, c.family, c.ruleVersion, c.variant, c.code),
    tier: c.tier,
    variant: c.variant,
  };
}
