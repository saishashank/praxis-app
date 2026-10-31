// Steelman opinion tracking (M11-lite WP4; CTX-041, D-488, D-485). One `opinion_track` row per written
// subject at write time (kind `steelman`); settlement is read-after: a later night reads the closed
// `trade` row of an order, or `pick_outcome` of a pick, and settles the opinion once with the net
// result. Never a hook in the writers of those rows. Opinions are tracked and read only by the Cortex
// opinion count; they are never an input to scoring (PRD-033).
import { settleRecordedOpinion } from "@/lib/llm/textLabels";
import { unsettledOpinions } from "@/lib/cortex/store/labels";
import type { Exec } from "./store";

export type OpinionValue = { bull: number; bear: number; monitorable: number };

const PPM = 1_000_000n; // threshold-ok: unit conversion to parts per million

/** The recorded value: how many points of each side were shown, and how many bear points are monitorable. */
export function opinionValue(
  shown: readonly { side: "bull" | "bear"; monitorable: boolean }[],
): OpinionValue {
  return {
    bull: shown.filter((p) => p.side === "bull").length,
    bear: shown.filter((p) => p.side === "bear").length,
    monitorable: shown.filter((p) => p.side === "bear" && p.monitorable).length,
  };
}

export type SubjectOutcome =
  | { kind: "order"; netPpm: number; exit: string }
  | { kind: "order"; legacy: true }
  | { kind: "pick"; netPpm: number }
  | { kind: "pick"; missed: true };

const big = (v: unknown): bigint => BigInt(String(v));

/** The settled outcome of an order subject, or null while its trade is open or unknown. */
async function orderOutcome(db: Exec, cardId: string): Promise<SubjectOutcome | null> {
  const r = await db.execute({
    sql: `SELECT t.exit_type AS exit_type, t.exit_fill_id AS exit_fill_id, e.value_micro AS buy_value,
                 e.brokerage_micro AS buy_fee, x.value_micro AS sell_value, x.brokerage_micro AS sell_fee
            FROM decision_card c
            JOIN fill e ON e.order_id = c.order_id
            JOIN trade t ON t.entry_fill_id = e.id
            LEFT JOIN fill x ON x.id = t.exit_fill_id
           WHERE c.id = ?`,
    args: [cardId],
  });
  const row = r.rows[0];
  if (!row || row.exit_type === null) return null;
  if (row.exit_fill_id === null) return { kind: "order", legacy: true };
  const cost = big(row.buy_value) + big(row.buy_fee);
  if (cost <= 0n) return null;
  const net = big(row.sell_value) - big(row.sell_fee) - cost;
  return { kind: "order", netPpm: Number((net * PPM) / cost), exit: String(row.exit_type) };
}

/** The settled outcome of a pick subject (`market|d|profile|rank`), or null while it is open. */
async function pickOutcome(db: Exec, subjectId: string): Promise<SubjectOutcome | null> {
  const [market, d, profile, rank] = subjectId.split("|");
  if (!market || !d || !profile || !rank) return null;
  const r = await db.execute({
    sql: `SELECT state, net_ppm FROM pick_outcome
           WHERE market = ? AND d = ? AND profile = ? AND rank = ? AND kind = 'pick'`,
    args: [market, d, profile, Number(rank)],
  });
  const row = r.rows[0];
  if (!row) return null;
  if (row.state === "closed" && row.net_ppm !== null)
    return { kind: "pick", netPpm: Number(row.net_ppm) };
  if (row.state === "missed") return { kind: "pick", missed: true };
  return null;
}

/**
 * Settles every due steelman opinion whose subject has since closed (or, for a pick, been missed).
 * `d` is the night doing the reading. Returns how many were settled. A failure on one opinion leaves it
 * unsettled for the next night and never throws.
 */
export async function settleDue(db: Exec, market: string, d: string): Promise<number> {
  let settled = 0;
  let open;
  try {
    open = (await unsettledOpinions(db, market, d)).filter((o) => o.kind === "steelman");
  } catch {
    return 0;
  }
  for (const o of open) {
    try {
      const packs = await db.execute({
        sql: `SELECT subject_kind, subject_id, card_id FROM steelman_pack
               WHERE market = ? AND d = ? AND code = ? ORDER BY subject_kind`,
        args: [market, o.d, o.code],
      });
      // D-508: an order subject decides when one exists for the code and night (the opinion was
      // written for the order first, AGT-133); a pick decides only when no order was taken.
      const orders = packs.rows.filter((p) => p.subject_kind === "order");
      for (const p of orders.length > 0 ? orders : packs.rows) {
        const out =
          p.subject_kind === "order"
            ? p.card_id === null
              ? null
              : await orderOutcome(db, String(p.card_id))
            : await pickOutcome(db, String(p.subject_id));
        if (out === null) continue;
        if (await settleRecordedOpinion(db, market, o.opinionId, d, out)) settled += 1;
        break;
      }
    } catch {
      // stays unsettled; tried again tomorrow
    }
  }
  return settled;
}
