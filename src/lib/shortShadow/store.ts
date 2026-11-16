// The only writer of the shadow short stream's two tables (M21 R1; VAL-121, D-1228). Insert-or-ignore: running a night twice
// writes nothing new. Nothing else is written, not even a log line on success.
import type { Client } from "@libsql/client";

export type ShortOrigin = "lowest_rank" | "event_polarity";
export type ShortStatus = "closed" | "unfilled" | "not_shortable";
export type ShortExitReason = "stop" | "gap" | "time";

export type ShortDecisionRow = {
  readonly market: string;
  readonly d: string;
  readonly code: string;
  readonly origin: ShortOrigin;
  readonly bookId: string;
  readonly rankKey: string | null;
  readonly family: string | null;
  readonly shortable: boolean;
  readonly ruleId: string;
  readonly createdAt: string;
};

export type ShortOutcomeRow = {
  readonly market: string;
  readonly d: string;
  readonly code: string;
  readonly origin: ShortOrigin;
  readonly status: ShortStatus;
  readonly entryD: string | null;
  readonly entryMicro: bigint | null;
  readonly exitD: string | null;
  readonly exitMicro: bigint | null;
  readonly exitReason: ShortExitReason | null;
  readonly feesMicro: bigint | null;
  readonly borrowMicro: bigint | null;
  readonly netMicro: bigint | null;
  readonly netPpm: number | null;
  readonly scoredAt: string;
};

const asNum = (v: bigint | null): number | null => (v === null ? null : Number(v)); // money-float-ok: one parcel's micro fits 2^53

export async function insertShortDecision(db: Client, x: ShortDecisionRow): Promise<boolean> {
  const r = await db.execute({
    sql: `INSERT INTO short_shadow_decision (market, d, code, origin, book_id, rank_key, family, shortable, rule_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    args: [
      x.market,
      x.d,
      x.code,
      x.origin,
      x.bookId,
      x.rankKey,
      x.family,
      x.shortable ? 1 : 0,
      x.ruleId,
      x.createdAt,
    ],
  });
  return r.rowsAffected > 0;
}

export async function insertShortOutcome(db: Client, x: ShortOutcomeRow): Promise<boolean> {
  const r = await db.execute({
    sql: `INSERT INTO short_shadow_outcome (market, d, code, origin, status, entry_d, entry_micro, exit_d, exit_micro,
            exit_reason, fees_micro, borrow_micro, net_micro, net_ppm, scored_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    args: [
      x.market,
      x.d,
      x.code,
      x.origin,
      x.status,
      x.entryD,
      asNum(x.entryMicro),
      x.exitD,
      asNum(x.exitMicro),
      x.exitReason,
      asNum(x.feesMicro),
      asNum(x.borrowMicro),
      asNum(x.netMicro),
      x.netPpm,
      x.scoredAt,
    ],
  });
  return r.rowsAffected > 0;
}
