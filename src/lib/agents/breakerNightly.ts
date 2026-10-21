// Nightly thesis-breaker evaluation, database side (M5 T7; AGT-111; docs/M5_design.md 4.4 step 1).
// Batch 2b calls `evaluateNightly` after the CS exits of the night: for every open position of a live
// E cohort (and every pending entry order decided before D) with a Decision Card it builds one
// observation from the DecisionView inputs of D (bars <= D, announcements published before
// cut-off(D)), runs the PURE evaluator (`breakerEval.ts`, shared with the replay) and appends one
// `thesis_breaker_eval` row per breaker (phase nightly, seq 1; ON CONFLICT DO NOTHING, so a rerun
// writes nothing new). A red held position also reaches the alert table as a P0 (batch 2b breakers
// stage, default sink; D-102). It creates no order: batch 2b turns a red held position into an `exit_cs`.
// Controls (C1/C2/C3) have no thesis and are not evaluated.
import type { Client } from "@libsql/client";
import type { CalendarRow } from "@/lib/data/calendar";
import {
  BREAKER_EVAL_RULE_VERSION,
  buildObservation,
  evaluateBreakers,
  itemsFromEvents,
  type AnnouncementText,
  type BreakerPhase,
  type PositionEvaluation,
} from "./breakerEval";
import type { DayInputs } from "./candidates";
import type { AgentParams } from "./params";
import { shortInterestFor } from "./shortInterest";
import type { CardBreaker } from "./thesisBreakers";

type Exec = Pick<Client, "execute">;

export type BreakerSubject = {
  readonly kind: "trade" | "order";
  /** Trade id or entry order id. */
  readonly id: string;
  readonly cohortId: string;
  readonly executionId: string;
  readonly code: string;
  readonly cardId: string;
  /** The card's session and the cut-off instant it was decided at. */
  readonly cardD: string;
  readonly decidedAt: string;
  readonly breakers: readonly CardBreaker[];
};

const text = (v: unknown): string => String(v);

function parseCard(json: unknown): { d: string; breakers: readonly CardBreaker[] } | null {
  try {
    const card = JSON.parse(text(json)) as { d?: unknown; thesis_breakers?: unknown };
    if (typeof card.d !== "string" || !Array.isArray(card.thesis_breakers)) return null;
    return { d: card.d, breakers: card.thesis_breakers as CardBreaker[] };
  } catch {
    return null;
  }
}

/** Open positions and pending entries of live E cohorts that have a card, ordered by kind then id. */
export async function loadBreakerSubjects(db: Exec, d: string): Promise<BreakerSubject[]> {
  const trades = await db.execute(
    `SELECT t.id AS id, t.cohort_id AS cohort_id, t.code AS code, c.execution_id AS execution_id,
            k.id AS card_id, k.card_json AS card_json, k.decided_at AS decided_at
     FROM trade t
     JOIN cohort c ON c.id = t.cohort_id
     JOIN execution e ON e.id = c.execution_id
     JOIN fill f ON f.id = t.entry_fill_id
     JOIN arena_order o ON o.id = f.order_id
     JOIN decision_card k ON k.id = o.card_id
     WHERE t.exit_type IS NULL AND c.terminal_kind IS NULL AND e.kind = 'E'
     ORDER BY t.id`,
  );
  const orders = await db.execute({
    sql: `SELECT o.id AS id, o.cohort_id AS cohort_id, o.code AS code, c.execution_id AS execution_id,
                 k.id AS card_id, k.card_json AS card_json, k.decided_at AS decided_at
          FROM arena_order o
          JOIN cohort c ON c.id = o.cohort_id
          JOIN execution e ON e.id = c.execution_id
          JOIN decision_card k ON k.id = o.card_id
          WHERE o.kind = 'entry' AND o.status = 'pending' AND o.decided_d < ?
            AND c.terminal_kind IS NULL AND e.kind = 'E'
          ORDER BY o.id`,
    args: [d],
  });
  const out: BreakerSubject[] = [];
  for (const [kind, rs] of [
    ["trade", trades],
    ["order", orders],
  ] as const) {
    for (const r of rs.rows) {
      const card = parseCard(r.card_json);
      if (card === null || card.breakers.length === 0) continue;
      out.push({
        kind,
        id: text(r.id),
        cohortId: text(r.cohort_id),
        executionId: text(r.execution_id),
        code: text(r.code),
        cardId: text(r.card_id),
        cardD: card.d,
        decidedAt: text(r.decided_at),
        breakers: card.breakers,
      });
    }
  }
  return out;
}

/** Announcement text by ref for the codes' announcements published at or after `sinceIso`. */
export async function announcementTexts(
  db: Exec,
  market: string,
  code: string,
  sinceIso: string,
): Promise<Map<string, AnnouncementText>> {
  const rs = await db.execute({
    sql: `SELECT source, ann_id, title, type FROM announcement
          WHERE market = ? AND code = ? AND published_at >= ?`,
    args: [market, code, sinceIso],
  });
  return new Map(
    rs.rows.map((r) => [
      `${text(r.source)}|${text(r.ann_id)}`,
      { title: text(r.title), type: r.type === null ? null : text(r.type) },
    ]),
  );
}

export type NightContext = {
  readonly db: Client;
  readonly market: string;
  readonly d: string;
  readonly calendar: readonly CalendarRow[];
  readonly params: AgentParams;
  readonly day: DayInputs;
};

/** The evaluation of one subject on the night of D (reads only; no write). */
export async function evaluateSubject(
  ctx: NightContext,
  s: BreakerSubject,
  phase: BreakerPhase = "nightly",
): Promise<PositionEvaluation> {
  const { db, day, params } = ctx;
  // events recorded after the card's decision (published at or after its cut-off), usable at D
  const fresh = await db.execute({
    sql: `SELECT source, ann_id FROM event WHERE market = ? AND code = ? AND published_at >= ?`,
    args: [ctx.market, s.code, s.decidedAt],
  });
  const ids = new Set(fresh.rows.map((r) => `${text(r.source)}|${text(r.ann_id)}`));
  const events = (day.eventsByCode.get(s.code) ?? []).filter((e) => ids.has(e.id));
  const texts =
    events.length === 0 ? new Map() : await announcementTexts(db, ctx.market, s.code, s.decidedAt);
  let shortDelta: number | null = null;
  try {
    shortDelta = (await shortInterestFor(day.view, s.code, params, ctx.calendar)).delta_ppm;
  } catch {
    shortDelta = null; // an unreadable short-interest series reads "unknown" (green)
  }
  const ref = await day.view.bars(s.code, 1, s.cardD);
  const refBar = ref[ref.length - 1];
  const obs = buildObservation(
    {
      d: ctx.d,
      phase,
      rawBars: day.facts.get(s.code)?.rawBars ?? [],
      refCloseMicro: refBar !== undefined && refBar.d === s.cardD ? refBar.close : null,
      shortDeltaPpm: shortDelta,
      regime: day.regime === null ? null : day.regime.result.state,
      items: itemsFromEvents(events, day.inputs.sessions, ctx.d, texts),
    },
    params,
  );
  return evaluateBreakers(s.breakers, obs, params);
}

/** Appends the evaluation rows of one subject (all breakers); returns the rows really written. */
export async function writeEvaluation(
  db: Exec,
  s: BreakerSubject,
  market: string,
  d: string,
  phase: BreakerPhase,
  seq: number,
  ev: PositionEvaluation,
): Promise<number> {
  let written = 0;
  for (const e of ev.evaluations) {
    const res = await db.execute({
      sql: `INSERT INTO thesis_breaker_eval (subject_id, breaker_id, d, phase, seq, subject_kind,
              card_id, market, code, status, value_text, trigger_text, amber_text, trigger_ref,
              rule_version)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      args: [
        s.id,
        e.id,
        d,
        phase,
        seq,
        s.kind,
        s.cardId,
        market,
        s.code,
        e.status,
        e.valueText,
        e.triggerText,
        e.amberText,
        e.status === "red" ? e.triggerRef : null,
        BREAKER_EVAL_RULE_VERSION,
      ],
    });
    written += res.rowsAffected;
  }
  return written;
}
