// Pre-open re-check (M5 T8; ARN-020a, AGT-111, AGT-012, DAT-127, AT-18 part B; docs/M5_design.md 4.5;
// D-096 decision 38; D-103). Runs at 09:54 Sydney (retry 09:58) from the signed route
// `POST /api/internal/preopen`, and from the replay driver with the same code.
//
// For every PENDING ENTRY order of D (all cohorts, controls included: the order fills at 10:00
// whatever its family) the re-check asks whether anything new since the decision cut-off makes the
// buy wrong. First failing check wins, in this order:
//   halt                    a halt / suspension item since the decision (A2 category)
//   possible_halt_feed_off  the ASX feed is OFF and the code had no bar or zero volume in the last
//                           session (DAT-127 proxy; also a P1 `halt_proxy` alert, never P0)
//   filter:quality          an open entry-blocking quality flag after the decision, or the U1 gate
//                           of the decision session turned to failed (DAT-210)
//   filter:asx_query        U2/U3 only (ARN-011): an exchange query since the decision
//   filter:placement        U2/U3 only (ARN-011): a capital raising since the decision
//   tb:<id>                 an event thesis-breaker of the order's card turned red (AGT-111)
// A failing order goes `pending -> cancelled` with `reject_reason = preopen:<reason>` and gets its
// `preopen_result` row (`cancel`) in ONE batch; a passing order gets `pass`. Exits and sleeve orders
// are never read: only `kind = 'entry'` is. The module never creates an order (AGT-012).
//
// A failed or missing re-check: attempt 2 failing, or no run at all by the time batch 2a fills,
// raises the P1 `preopen:<market>:<d>` alert, and 2a writes `not_rechecked` for each entry it fills
// (`markNotRechecked`). Idempotent everywhere: results are keyed by order, the run by (market, d),
// alerts by key (INSERT ... ON CONFLICT DO NOTHING), breaker rows by their primary key.
// Replay: `preopenDecision` is pure; the replay driver calls `runPreopen` with `replay: true` before
// each session's books are closed, with the evidence bounded by the 09:55 instant of that day.
import type { Client } from "@libsql/client";
import {
  BREAKER_EVAL_RULE_VERSION,
  createAlertRowSink,
  evaluateBreakers,
  INTRADAY_BREAKERS,
  itemFromAnnouncement,
  type BreakerEvaluation,
  type BreakerItem,
  type BreakerObservation,
} from "@/lib/agents/breakerEval";
import { decisionCutoffUtc } from "@/lib/agents/decisionView";
import { loadAgentParams, type AgentParams } from "@/lib/agents/params";
import type { CardBreaker } from "@/lib/agents/thesisBreakers";
import { alertKeys } from "@/lib/alerts/tiers";
import { cortexOpenGuard } from "@/lib/cortex/stage";
import { loadAsxTokenView } from "@/lib/data/asxToken";
import {
  isTradingDay,
  localToUtc,
  previousTradingDay,
  type CalendarKind,
  type CalendarRow,
} from "@/lib/data/calendar";

type Exec = Pick<Client, "execute">;

export const PREOPEN_PURPOSE = "preopen";
/** Exchange-time instant the evidence is bounded by (spec 09:55); the Worker calls at 09:54. */
export const PREOPEN_AT = "09:55";
export const PREOPEN_ATTEMPTS = [1, 2] as const;
const DEFAULT_MARKET = "AU";
const DAY_TZ = "Australia/Sydney";

const text = (v: unknown): string => String(v);

// ---- pure decision -----------------------------------------------------------------------------

export type PreopenOrder = {
  readonly id: string;
  readonly code: string;
  /** U1/U2/U3 as stored on the order; null = unknown (ARN-011 filters then apply). */
  readonly tier: string | null;
  readonly cardId: string | null;
  /** Thesis-breakers of the order's card (empty without a card). */
  readonly breakers: readonly CardBreaker[];
};

export type PreopenEvidence = {
  /** Announcements published since the order's decision cut-off, before the 09:55 bound. */
  readonly items: readonly BreakerItem[];
  /** An open entry-blocking quality flag after the decision, or the U1 gate failed since. */
  readonly qualityBlocked: boolean;
  /** The ASX announcements feed is on (worker_state + source_status). */
  readonly asxOn: boolean;
  /** The last session before D: was there a bar, and its volume. */
  readonly lastSession: { readonly hasBar: boolean; readonly volume: number | null };
};

export type PreopenDecision = {
  readonly outcome: "pass" | "cancel";
  /** `halt`, `possible_halt_feed_off`, `filter:<id>` or `tb:<id>`; null for a pass. */
  readonly reason: string | null;
  /** Event breakers evaluated for the order's card (empty without one). */
  readonly evaluations: readonly BreakerEvaluation[];
};

/** The event breakers of a card (the ones an announcement can move), in card order. */
export const eventBreakers = (list: readonly CardBreaker[]): CardBreaker[] =>
  list.filter((b) => INTRADAY_BREAKERS.includes(b.id));

/** Pure: one order, its evidence and the parameters give the outcome. No clock, no I/O. */
export function preopenDecision(
  order: PreopenOrder,
  evidence: PreopenEvidence,
  params: AgentParams,
  d: string,
): PreopenDecision {
  const obs: BreakerObservation = {
    d,
    phase: "preopen",
    closeMicro: null,
    smaMicro: null,
    refCloseMicro: null,
    shortDeltaPpm: null,
    regime: null,
    items: evidence.items,
  };
  const evaluations = evaluateBreakers(eventBreakers(order.breakers), obs, params).evaluations;
  const cancel = (reason: string): PreopenDecision => ({ outcome: "cancel", reason, evaluations });
  const has = (c: BreakerItem["category"]): boolean => evidence.items.some((i) => i.category === c);

  if (has("halt_suspension")) return cancel("halt");
  if (
    !evidence.asxOn &&
    (!evidence.lastSession.hasBar ||
      evidence.lastSession.volume === null ||
      evidence.lastSession.volume <= 0)
  ) {
    return cancel("possible_halt_feed_off");
  }
  if (evidence.qualityBlocked) return cancel("filter:quality");
  if (order.tier !== "U1") {
    if (has("exchange_query")) return cancel("filter:asx_query");
    if (has("capital_raising")) return cancel("filter:placement");
  }
  const red = evaluations.find((e) => e.status === "red");
  if (red !== undefined) return cancel(`tb:${red.id}`);
  return { outcome: "pass", reason: null, evaluations };
}

// ---- alerts ------------------------------------------------------------------------------------

const insertAlert = async (
  db: Exec,
  a: {
    key: string;
    market: string;
    code: string | null;
    kind: "preopen_failure" | "halt_proxy";
    at: string;
    facts: Record<string, unknown>;
  },
): Promise<boolean> => {
  const w = await db.execute({
    sql:
      "INSERT INTO alert (alert_key, market, code, kind, tier, materiality, published_at, detected_at, facts_json) " +
      "VALUES (?, ?, ?, ?, 'P1', NULL, NULL, ?, ?) ON CONFLICT DO NOTHING",
    args: [a.key, a.market, a.code, a.kind, a.at, JSON.stringify(a.facts)],
  });
  return w.rowsAffected === 1;
};

/** The P1 `preopen:<market>:<d>` alert (ARN-020a s13): the re-check failed or did not run. */
export async function raisePreopenAlert(
  db: Exec,
  market: string,
  d: string,
  at: string,
  cause: "error" | "not_run",
): Promise<boolean> {
  return insertAlert(db, {
    key: alertKeys.preopen(market, d),
    market,
    code: null,
    kind: "preopen_failure",
    at,
    facts: {
      rule: "p1:preopen_failure",
      why:
        cause === "error"
          ? `The pre-open re-check failed twice on ${d}: entry orders fill without it, flagged not re-checked.`
          : `The pre-open re-check did not run on ${d}: entry orders fill without it, flagged not re-checked.`,
      executions: [],
      d,
    },
  });
}

async function raiseProxyAlert(
  db: Exec,
  market: string,
  code: string,
  d: string,
  at: string,
): Promise<void> {
  await insertAlert(db, {
    key: alertKeys.proxy(market, code, d),
    market,
    code,
    kind: "halt_proxy",
    at,
    facts: {
      rule: "p1:halt_proxy",
      why: `${code} had no bar or no volume in the last session and the ASX feed is off: possible halt (DAT-127 proxy).`,
      executions: [],
      d,
    },
  });
}

// ---- run record --------------------------------------------------------------------------------

type RunRow = {
  attempt: 1 | 2;
  status: "ok" | "error" | "not_run";
  checked: number;
  cancelled: number;
};

async function readRun(db: Exec, market: string, d: string): Promise<RunRow | null> {
  const r = await db.execute({
    sql: "SELECT attempt, status, checked, cancelled FROM preopen_run WHERE market = ? AND d = ?",
    args: [market, d],
  });
  if (r.rows.length === 0) return null;
  const x = r.rows[0];
  return {
    attempt: Number(x.attempt) === 2 ? 2 : 1, // money-float-ok: a count or flag, not money
    status: text(x.status) as RunRow["status"],
    checked: Number(x.checked), // money-float-ok: a count or flag, not money
    cancelled: Number(x.cancelled), // money-float-ok: a count or flag, not money
  };
}

async function writeRun(
  db: Exec,
  p: {
    market: string;
    d: string;
    attempt: 1 | 2;
    status: RunRow["status"];
    startedAt: string;
    finishedAt: string;
    checked: number;
    cancelled: number;
    update: boolean;
  },
): Promise<void> {
  if (p.update) {
    await db.execute({
      sql: `UPDATE preopen_run SET attempt = ?, status = ?, finished_at = ?, checked = ?, cancelled = ?
            WHERE market = ? AND d = ?`,
      args: [p.attempt, p.status, p.finishedAt, p.checked, p.cancelled, p.market, p.d],
    });
    return;
  }
  await db.execute({
    sql: `INSERT INTO preopen_run (market, d, attempt, started_at, finished_at, status, checked, cancelled)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    args: [p.market, p.d, p.attempt, p.startedAt, p.finishedAt, p.status, p.checked, p.cancelled],
  });
}

// ---- batch 2a hooks (not_rechecked) --------------------------------------------------------------

/**
 * A missing or failed re-check, seen by batch 2a at fill time: records the run as `not_run` when
 * there is none and raises the P1 alert (idempotent by key). A run that finished `ok` changes
 * nothing; an `error` run raises the alert too (a first attempt that was never retried).
 */
export async function noteRecheckGap(
  db: Exec,
  market: string,
  d: string,
  at: string,
): Promise<void> {
  const run = await readRun(db, market, d);
  if (run === null) {
    await writeRun(db, {
      market,
      d,
      attempt: 1,
      status: "not_run",
      startedAt: at,
      finishedAt: at,
      checked: 0,
      cancelled: 0,
      update: false,
    });
    await raisePreopenAlert(db, market, d, at, "not_run");
  } else if (run.status !== "ok") {
    await raisePreopenAlert(db, market, d, at, run.status === "error" ? "error" : "not_run");
  }
}

/**
 * Batch 2a, just before an entry fills: an order with no `preopen_result` row was not re-checked
 * (ARN-020a, AT-18 part B). Writes `not_rechecked` once; returns true when it wrote it.
 */
export async function markNotRechecked(
  db: Exec,
  p: { market: string; d: string; orderId: string; cardId: string | null; at: string },
): Promise<boolean> {
  const had = await db.execute({
    sql: "SELECT 1 FROM preopen_result WHERE order_id = ?",
    args: [p.orderId],
  });
  if (had.rows.length > 0) return false;
  await noteRecheckGap(db, p.market, p.d, p.at);
  const w = await db.execute({
    sql: `INSERT INTO preopen_result (order_id, market, d, outcome, reason, card_id)
          VALUES (?, ?, ?, 'not_rechecked', NULL, ?) ON CONFLICT DO NOTHING`,
    args: [p.orderId, p.market, p.d, p.cardId],
  });
  return w.rowsAffected === 1;
}

// ---- the run -----------------------------------------------------------------------------------

export type PreopenOptions = {
  readonly market?: string;
  /** The session being opened (Sydney trading date). */
  readonly d: string;
  /** Worker attempt, 1 (09:54) or 2 (09:58). */
  readonly attempt?: 1 | 2;
  /** A replay against a NON-production database: a `data_only` market may then be processed. */
  readonly replay?: boolean;
  /** Stamps run / alert rows only. */
  readonly now: () => string;
  readonly params?: AgentParams;
};

export type PreopenResult =
  | {
      status: "ok" | "already_done" | "final";
      attempt: 1 | 2;
      checked: number;
      cancelled: number;
      /** Orders cancelled by this call, by reason. */
      reasons: Readonly<Record<string, number>>;
    }
  | { status: "skipped"; reason: string }
  | { status: "error"; attempt: 1 | 2 };

type Candidate = PreopenOrder & {
  decidedD: string;
  /** Cortex orders only (migration 0019): the CTX-028 open-time list then follows the v1 checks. */
  limitMicro: bigint | null;
  signalId: string | null;
  family: string | null;
};

async function readCalendar(db: Exec, market: string): Promise<CalendarRow[]> {
  const rs = await db.execute({
    sql: "SELECT d, kind, close_time, confirmed FROM trading_calendar WHERE market = ? ORDER BY d",
    args: [market],
  });
  return rs.rows.map((r) => ({
    d: text(r.d),
    kind: text(r.kind) as CalendarKind,
    close_time: r.close_time === null ? null : text(r.close_time),
    confirmed: Number(r.confirmed) === 1 ? 1 : 0, // money-float-ok: a count or flag, not money
  }));
}

function breakersOf(json: unknown): CardBreaker[] {
  if (json === null || json === undefined) return [];
  try {
    const card = JSON.parse(text(json)) as { thesis_breakers?: unknown };
    return Array.isArray(card.thesis_breakers) ? (card.thesis_breakers as CardBreaker[]) : [];
  } catch {
    return [];
  }
}

async function pendingEntries(db: Exec, market: string, d: string): Promise<Candidate[]> {
  const rs = await db.execute({
    sql: `SELECT o.id AS id, o.code AS code, o.tier AS tier, o.decided_d AS decided_d,
                 o.card_id AS card_id, k.card_json AS card_json,
                 o.limit_micro AS limit_micro, o.signal_id AS signal_id, e.family AS family
          FROM arena_order o
          JOIN cohort c ON c.id = o.cohort_id
          JOIN execution e ON e.id = c.execution_id
          LEFT JOIN decision_card k ON k.id = o.card_id
          WHERE o.kind = 'entry' AND o.status = 'pending' AND o.decided_d < ? AND e.market = ?
            AND NOT EXISTS (SELECT 1 FROM preopen_result r WHERE r.order_id = o.id)
          ORDER BY o.id`,
    args: [d, market],
  });
  return rs.rows.map((r) => ({
    id: text(r.id),
    code: text(r.code),
    tier: r.tier === null ? null : text(r.tier),
    decidedD: text(r.decided_d),
    cardId: r.card_id === null ? null : text(r.card_id),
    breakers: breakersOf(r.card_json),
    limitMicro:
      r.limit_micro === null || r.limit_micro === undefined ? null : BigInt(r.limit_micro as never),
    signalId: r.signal_id === null ? null : text(r.signal_id),
    family: r.family === null || r.family === undefined ? null : text(r.family),
  }));
}

/** The ASX feed counts as on only when the switch is on and the source is neither off nor tripped. */
export async function asxFeedOn(db: Exec, now: Date): Promise<boolean> {
  try {
    const v = await loadAsxTokenView(db, now);
    return v.enabled && v.sourceMode !== "off" && v.sourceMode !== "tripped";
  } catch {
    return false; // unreadable = treat as off: the proxy then errs toward cancelling
  }
}

async function itemsFor(
  db: Exec,
  market: string,
  code: string,
  sinceIso: string,
  untilIso: string,
): Promise<BreakerItem[]> {
  const rs = await db.execute({
    sql: `SELECT source, ann_id, type, title, price_sensitive, published_at FROM announcement
          WHERE market = ? AND code = ? AND published_at >= ? AND published_at < ?
          ORDER BY published_at, source, ann_id`,
    args: [market, code, sinceIso, untilIso],
  });
  return rs.rows.map((r) =>
    itemFromAnnouncement({
      ref: `${text(r.source)}|${text(r.ann_id)}`,
      type: r.type === null ? null : text(r.type),
      title: text(r.title),
      priceSensitive: Number(r.price_sensitive) === 1, // money-float-ok: a count or flag, not money
    }),
  );
}

async function qualityBlocked(db: Exec, market: string, c: Candidate): Promise<boolean> {
  const flag = await db.execute({
    sql: `SELECT 1 FROM data_quality_flag
          WHERE market = ? AND code = ? AND d >= ? AND blocks_entries = 1 AND cleared_at IS NULL
          LIMIT 1`,
    args: [market, c.code, c.decidedD],
  });
  if (flag.rows.length > 0) return true;
  const score = await db.execute({
    sql: "SELECT gate_pass FROM quality_score WHERE market = ? AND d = ? AND tier = 'U1'",
    args: [market, c.decidedD],
  });
  return score.rows.length > 0 && Number(score.rows[0].gate_pass) !== 1; // money-float-ok: a count or flag, not money
}

async function lastSessionOf(
  db: Exec,
  market: string,
  code: string,
  priorD: string,
): Promise<PreopenEvidence["lastSession"]> {
  const r = await db.execute({
    sql: "SELECT volume FROM price_bar WHERE market = ? AND code = ? AND d = ?",
    args: [market, code, priorD],
  });
  if (r.rows.length === 0) return { hasBar: false, volume: null };
  return { hasBar: true, volume: Number(r.rows[0].volume) }; // money-float-ok: a count or flag, not money
}

async function writeBreakerRows(
  db: Exec,
  market: string,
  d: string,
  c: Candidate,
  decision: PreopenDecision,
): Promise<void> {
  if (c.cardId === null) return;
  for (const e of decision.evaluations) {
    await db.execute({
      sql: `INSERT INTO thesis_breaker_eval (subject_id, breaker_id, d, phase, seq, subject_kind,
              card_id, market, code, status, value_text, trigger_text, amber_text, trigger_ref,
              rule_version)
            VALUES (?, ?, ?, 'preopen', 1, 'order', ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      args: [
        c.id,
        e.id,
        d,
        c.cardId,
        market,
        c.code,
        e.status,
        e.valueText,
        e.triggerText,
        e.amberText,
        e.status === "red" ? e.triggerRef : null,
        BREAKER_EVAL_RULE_VERSION,
      ],
    });
  }
}

async function recordOutcome(
  db: Client,
  market: string,
  d: string,
  c: Candidate,
  decision: PreopenDecision,
): Promise<boolean> {
  if (decision.outcome === "pass") {
    await db.execute({
      sql: `INSERT INTO preopen_result (order_id, market, d, outcome, reason, card_id)
            VALUES (?, ?, ?, 'pass', NULL, ?) ON CONFLICT DO NOTHING`,
      args: [c.id, market, d, c.cardId],
    });
    return false;
  }
  const reason = decision.reason as string;
  // one transaction: the cancel and its result row; the result is inserted only if the order really
  // is cancelled now (a concurrent change leaves no row and nothing half-written)
  const res = await db.batch(
    [
      {
        sql: "UPDATE arena_order SET status = 'cancelled', reject_reason = ? WHERE id = ? AND status = 'pending'",
        args: [`preopen:${reason}`, c.id],
      },
      {
        sql: `INSERT INTO preopen_result (order_id, market, d, outcome, reason, card_id)
              SELECT ?, ?, ?, 'cancel', ?, ? WHERE EXISTS
                (SELECT 1 FROM arena_order WHERE id = ? AND status = 'cancelled')
              ON CONFLICT DO NOTHING`,
        args: [c.id, market, d, reason, c.cardId, c.id],
      },
    ],
    "write",
  );
  return res[0].rowsAffected === 1;
}

/** Runs the re-check for D. See the module header; idempotent, never throws for a re-check failure. */
export async function runPreopen(db: Client, o: PreopenOptions): Promise<PreopenResult> {
  const market = o.market ?? DEFAULT_MARKET;
  const d = o.d;
  const m = await db.execute({ sql: "SELECT mode FROM market WHERE code = ?", args: [market] });
  if (m.rows.length === 0) return { status: "skipped", reason: "market_missing" };
  const mode = text(m.rows[0].mode);
  if (mode === "off") return { status: "skipped", reason: "market_off" };
  if (mode !== "full" && o.replay !== true) return { status: "skipped", reason: "data_only_guard" };
  const calendar = await readCalendar(db, market);
  if (!isTradingDay(d, calendar)) return { status: "skipped", reason: "non_trading_day" };

  const existing = await readRun(db, market, d);
  if (existing !== null && !(existing.status === "error" && existing.attempt === 1)) {
    return {
      status: existing.status === "ok" ? "already_done" : "final",
      attempt: existing.attempt,
      checked: existing.checked,
      cancelled: existing.cancelled,
      reasons: {},
    };
  }
  const attempt: 1 | 2 = existing !== null ? 2 : (o.attempt ?? 1);
  const startedAt = o.now();
  const reasons: Record<string, number> = {};
  try {
    const params = o.params ?? (await loadAgentParams(db));
    const asOf = localToUtc(d, PREOPEN_AT, DAY_TZ).toISOString();
    const asxOn = await asxFeedOn(db, new Date(asOf));
    const priorD = previousTradingDay(d, calendar);
    for (const c of await pendingEntries(db, market, d)) {
      const since = decisionCutoffUtc(c.decidedD, params.decisionCutoff);
      const evidence: PreopenEvidence = {
        items: await itemsFor(db, market, c.code, since, asOf),
        qualityBlocked: await qualityBlocked(db, market, c),
        asxOn,
        lastSession: await lastSessionOf(db, market, c.code, priorD),
      };
      let decision = preopenDecision(c, evidence, params, d);
      // M15 P2 (CTX-028): a Cortex order (limit_micro set) also passes the open-time list at 09:55;
      // v1 orders never reach it
      if (decision.outcome === "pass" && c.limitMicro !== null && c.family !== null) {
        const guard = await cortexOpenGuard(db, {
          market,
          d,
          barD: c.decidedD,
          orderId: c.id,
          signalId: c.signalId,
          family: c.family as never,
          fill: null,
          stopSpec: null,
          rechecked: true,
        });
        if (guard.firstFail !== null) {
          decision = {
            outcome: "cancel",
            reason: `filter:open_${guard.firstFail}`,
            evaluations: decision.evaluations,
          };
        }
      }
      await writeBreakerRows(db, market, d, c, decision);
      for (const e of decision.evaluations) {
        if (e.status !== "red") continue;
        await createAlertRowSink(db).record({
          key: alertKeys.thesisBreaker(c.id, e.id, d),
          market,
          code: c.code,
          d,
          phase: "preopen",
          subjectKind: "order",
          subjectId: c.id,
          cardId: c.cardId as string,
          executionId: null,
          breakerId: e.id,
          status: "red",
          valueText: e.valueText,
          triggerText: e.triggerText,
          triggerRef: e.triggerRef,
          effect: "none",
          detectedAt: startedAt,
        });
      }
      if (await recordOutcome(db, market, d, c, decision)) {
        const reason = decision.reason as string;
        reasons[reason] = (reasons[reason] ?? 0) + 1;
        if (reason === "possible_halt_feed_off") {
          await raiseProxyAlert(db, market, c.code, d, startedAt);
        }
      }
    }
    const t = await db.execute({
      sql: `SELECT COUNT(*) AS n, COALESCE(SUM(outcome = 'cancel'), 0) AS c FROM preopen_result
            WHERE market = ? AND d = ? AND outcome IN ('pass','cancel')`,
      args: [market, d],
    });
    const checked = Number(t.rows[0].n); // money-float-ok: a count or flag, not money
    const cancelled = Number(t.rows[0].c); // money-float-ok: a count or flag, not money
    await writeRun(db, {
      market,
      d,
      attempt,
      status: "ok",
      startedAt,
      finishedAt: o.now(),
      checked,
      cancelled,
      update: existing !== null,
    });
    return { status: "ok", attempt, checked, cancelled, reasons };
  } catch {
    try {
      await writeRun(db, {
        market,
        d,
        attempt,
        status: "error",
        startedAt,
        finishedAt: o.now(),
        checked: 0,
        cancelled: 0,
        update: existing !== null,
      });
    } catch {
      // the run row is evidence, not a lock: a failure to write it still ends in the P1 below
    }
    if (attempt === 2) {
      try {
        await raisePreopenAlert(db, market, d, o.now(), "error");
      } catch {
        // the 2a gap path raises it again (same key) when the orders fill
      }
    }
    return { status: "error", attempt };
  }
}
