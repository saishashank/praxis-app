// cortex_decision and cortex_outcome (CTX-013, CTX-023, CTX-054). Decisions are written by the
// batch 2b Cortex stage (live arm, shadow arm, blocked candidates); outcomes by batch 3 when the
// hold closes. Both are insert-or-ignore: a re-run of a night or a re-score keeps the first row.
import {
  insertIgnore,
  jsonText,
  numOrNull,
  parseJson,
  str,
  strOrNull,
  type Arm,
  type CortexFamily,
  type BatchExec,
  type Exec,
  type WriteResult,
} from "./common";

export type DecisionRow = {
  market: string;
  d: string;
  /** The E cohort id of the book. */
  bookId: string;
  code: string;
  arm: Arm;
  family: CortexFamily;
  s: number | null;
  p: number | null;
  expectedNetMicro: number | null;
  /** The ranking key as canonical text (Rationals are text). */
  rankKey: string | null;
  limitMicro: number | null;
  stopMicro: number | null;
  qty: number | null;
  /** Ordered [{gateId, pass, value}]. */
  gateTrace: readonly unknown[];
  /** Set on a blocked candidate: the first gate that failed. */
  firstFailGate: string | null;
  signalId: string | null;
  orderId: string | null;
  cardId: string | null;
  sectorTilt: unknown | null;
  manifestId: string;
};

export async function insertDecision(db: Exec, x: DecisionRow): Promise<WriteResult> {
  return insertIgnore(db, {
    sql: `INSERT INTO cortex_decision (market, d, book_id, code, arm, family, s, p, expected_net_micro,
            rank_key, limit_micro, stop_micro, qty, gate_trace_json, first_fail_gate, signal_id,
            order_id, card_id, sector_tilt_json, manifest_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      x.market,
      x.d,
      x.bookId,
      x.code,
      x.arm,
      x.family,
      x.s,
      x.p,
      x.expectedNetMicro,
      x.rankKey,
      x.limitMicro,
      x.stopMicro,
      x.qty,
      jsonText(x.gateTrace),
      x.firstFailGate,
      x.signalId,
      x.orderId,
      x.cardId,
      x.sectorTilt === null ? null : jsonText(x.sectorTilt),
      x.manifestId,
    ],
  });
}

const DECISIONS_PER_BATCH = 200;

/** Writes many decisions in batches (insert-or-ignore); returns how many were new. */
export async function insertDecisions(
  db: BatchExec,
  rows: readonly DecisionRow[],
): Promise<{ inserted: number }> {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += DECISIONS_PER_BATCH) {
    const results = await db.batch(
      rows.slice(i, i + DECISIONS_PER_BATCH).map((x) => ({
        sql: `INSERT INTO cortex_decision (market, d, book_id, code, arm, family, s, p, expected_net_micro,
                rank_key, limit_micro, stop_micro, qty, gate_trace_json, first_fail_gate, signal_id,
                order_id, card_id, sector_tilt_json, manifest_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        args: [
          x.market,
          x.d,
          x.bookId,
          x.code,
          x.arm,
          x.family,
          x.s,
          x.p,
          x.expectedNetMicro,
          x.rankKey,
          x.limitMicro,
          x.stopMicro,
          x.qty,
          jsonText(x.gateTrace),
          x.firstFailGate,
          x.signalId,
          x.orderId,
          x.cardId,
          x.sectorTilt === null ? null : jsonText(x.sectorTilt),
          x.manifestId,
        ],
      })),
      "write",
    );
    inserted += results.reduce((n, r) => n + r.rowsAffected, 0);
  }
  return { inserted };
}

const toDecision = (r: Record<string, unknown>): DecisionRow => ({
  market: str(r.market),
  d: str(r.d),
  bookId: str(r.book_id),
  code: str(r.code),
  arm: str(r.arm) as Arm,
  family: str(r.family) as CortexFamily,
  s: numOrNull(r.s),
  p: numOrNull(r.p),
  expectedNetMicro: numOrNull(r.expected_net_micro),
  rankKey: strOrNull(r.rank_key),
  limitMicro: numOrNull(r.limit_micro),
  stopMicro: numOrNull(r.stop_micro),
  qty: numOrNull(r.qty),
  gateTrace: parseJson<unknown[]>(r.gate_trace_json),
  firstFailGate: strOrNull(r.first_fail_gate),
  signalId: strOrNull(r.signal_id),
  orderId: strOrNull(r.order_id),
  cardId: strOrNull(r.card_id),
  sectorTilt: r.sector_tilt_json === null ? null : parseJson(r.sector_tilt_json),
  manifestId: str(r.manifest_id),
});

/** All decisions of a night in key order; optionally one family and/or one arm. */
export async function decisionsForNight(
  db: Exec,
  market: string,
  d: string,
  filter: { family?: CortexFamily; arm?: Arm } = {},
): Promise<DecisionRow[]> {
  const where = ["market = ?", "d = ?"];
  const args: (string | number)[] = [market, d];
  if (filter.family) {
    where.push("family = ?");
    args.push(filter.family);
  }
  if (filter.arm) {
    where.push("arm = ?");
    args.push(filter.arm);
  }
  const r = await db.execute({
    sql: `SELECT * FROM cortex_decision WHERE ${where.join(" AND ")} ORDER BY book_id, code, arm`,
    args,
  });
  return r.rows.map((x) => toDecision(x as Record<string, unknown>));
}

// ---- would-have outcomes ----

export type OutcomeRow = {
  market: string;
  d: string;
  bookId: string;
  code: string;
  arm: Arm;
  fillStatus: "filled" | "unfilled" | "cancelled";
  fillMicro: number | null;
  fillD: string | null;
  exitD: string | null;
  exitRule: string | null;
  grossMicro: number | null;
  netMicro: number | null;
  outcomeClass: string | null;
  scoredAt: string;
};

export async function insertOutcome(db: Exec, o: OutcomeRow): Promise<WriteResult> {
  return insertIgnore(db, {
    sql: `INSERT INTO cortex_outcome (market, d, book_id, code, arm, fill_status, fill_micro, fill_d,
            exit_d, exit_rule, gross_micro, net_micro, outcome_class, scored_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      o.market,
      o.d,
      o.bookId,
      o.code,
      o.arm,
      o.fillStatus,
      o.fillMicro,
      o.fillD,
      o.exitD,
      o.exitRule,
      o.grossMicro,
      o.netMicro,
      o.outcomeClass,
      o.scoredAt,
    ],
  });
}

const toOutcome = (r: Record<string, unknown>): OutcomeRow => ({
  market: str(r.market),
  d: str(r.d),
  bookId: str(r.book_id),
  code: str(r.code),
  arm: str(r.arm) as Arm,
  fillStatus: str(r.fill_status) as OutcomeRow["fillStatus"],
  fillMicro: numOrNull(r.fill_micro),
  fillD: strOrNull(r.fill_d),
  exitD: strOrNull(r.exit_d),
  exitRule: strOrNull(r.exit_rule),
  grossMicro: numOrNull(r.gross_micro),
  netMicro: numOrNull(r.net_micro),
  outcomeClass: strOrNull(r.outcome_class),
  scoredAt: str(r.scored_at),
});

/** Decisions up to `d` that batch 3 has not scored yet (no outcome row), oldest first. */
export async function unscoredDecisions(
  db: Exec,
  market: string,
  d: string,
  limit: number,
): Promise<DecisionRow[]> {
  const r = await db.execute({
    sql: `SELECT c.* FROM cortex_decision c
          WHERE c.market = ? AND c.d <= ? AND NOT EXISTS (
            SELECT 1 FROM cortex_outcome o WHERE o.market = c.market AND o.d = c.d
              AND o.book_id = c.book_id AND o.code = c.code AND o.arm = c.arm)
          ORDER BY c.d, c.book_id, c.code, c.arm LIMIT ?`,
    args: [market, d, limit],
  });
  return r.rows.map((x) => toDecision(x as Record<string, unknown>));
}

/** Scored outcomes of one family over a date range (the economic gate's live sample reads these). */
export async function outcomesForFamily(
  db: Exec,
  market: string,
  family: CortexFamily,
  from: string,
  to: string,
): Promise<OutcomeRow[]> {
  const r = await db.execute({
    sql: `SELECT o.* FROM cortex_outcome o
          JOIN cortex_decision c ON c.market = o.market AND c.d = o.d AND c.book_id = o.book_id
            AND c.code = o.code AND c.arm = o.arm
          WHERE o.market = ? AND c.family = ? AND o.d >= ? AND o.d <= ?
          ORDER BY o.d, o.book_id, o.code, o.arm`,
    args: [market, family, from, to],
  });
  return r.rows.map((x) => toOutcome(x as Record<string, unknown>));
}
