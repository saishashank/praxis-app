// Steelman subjects of a night (M11-lite WP3; AGT-133): orders first by rank score, then picks.
import type { Exec } from "./store";

export type Subject = {
  kind: "order" | "pick";
  id: string;
  code: string;
  cardId: string | null;
  rankScore: number | null;
  pickKey?: { profile: string; rank: number };
};

export async function nightSubjects(
  db: Exec,
  market: string,
  d: string,
  max: number,
): Promise<Subject[]> {
  const limit = Math.max(0, Math.trunc(max));
  if (limit === 0) return [];
  const orders = await db.execute({
    sql: `SELECT c.id AS id, s.code AS code, s.rank_score AS rank_score
            FROM decision_card c JOIN signal s ON s.id = c.signal_id
           WHERE s.market = ? AND s.d = ? AND c.taken = 1
           ORDER BY CAST(s.rank_score AS REAL) DESC, c.id`,
    args: [market, d],
  });
  const out: Subject[] = orders.rows.map((r) => ({
    kind: "order" as const,
    id: String(r.id),
    code: String(r.code),
    cardId: String(r.id),
    rankScore: Number(r.rank_score),
  }));
  if (out.length < limit) {
    const picks = await db.execute({
      sql: "SELECT profile, rank, code, card_id FROM pick WHERE market = ? AND d = ? ORDER BY profile, rank",
      args: [market, d],
    });
    for (const r of picks.rows)
      out.push({
        kind: "pick",
        id: `${market}|${d}|${String(r.profile)}|${Number(r.rank)}`,
        code: String(r.code),
        cardId: r.card_id === null ? null : String(r.card_id),
        rankScore: null,
        pickKey: { profile: String(r.profile), rank: Number(r.rank) },
      });
  }
  return out.slice(0, limit);
}
