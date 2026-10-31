// Steelman storage (M11-lite WP2; migration 0021). Typed inserts and reads for the four steelman tables.
// Every function takes `Exec` only (one `execute`), never a batch handle: a client or a transaction.
// Packs, points and night rows are append-only; inserts are idempotent by primary key (INSERT OR IGNORE,
// `inserted: false` = already there). A suggestion moves once, open to dismissed or expired.
import type { Exec, WriteResult } from "@/lib/cortex/store/common";
import { jsonText, num, parseJson, str, strOrNull } from "@/lib/cortex/store/common";

export type { Exec, WriteResult };

export type SubjectKind = "order" | "pick";
export type Side = "bull" | "bear";
export type PointState =
  | "shown"
  | "hidden_critic"
  | "dropped_citation"
  | "dropped_number"
  | "dropped_unsafe";
export type SuggestionStatus = "open" | "dismissed" | "expired";

export type PackItemRow = { id: string; kind: string; text: string; at?: string };

export type PackRow = {
  packId: string;
  market: string;
  d: string;
  subjectKind: SubjectKind;
  subjectId: string;
  code: string;
  cardId: string | null;
  cutoffAt: string;
  items: PackItemRow[];
  itemCount: number;
  createdAt: string;
};

export type PointRow = {
  pointId: string;
  packId: string;
  side: Side;
  n: number;
  text: string;
  citations: string[];
  monitorable: boolean;
  state: PointState;
  authorProvider: string;
  authorModel: string;
  criticProvider: string | null;
  criticModel: string | null;
  criticNote: string | null;
  createdAt: string;
};

export type NightRow = {
  market: string;
  d: string;
  requested: number;
  written: number;
  notWrittenLimit: number;
  notWrittenBudget: number;
  notWrittenNoModel: number;
  notWrittenCritic: number;
  claimsTotal: number;
  claimsValid: number;
  validityPpm: number;
  criticHidden: number;
  createdAt: string;
};

export type SuggestionRow = {
  suggestionId: string;
  market: string;
  d: string;
  pointId: string;
  cardId: string | null;
  code: string;
  family: string;
  status: SuggestionStatus;
  createdAt: string;
  closedAt: string | null;
  closedBy: string | null;
};

export const pointIdOf = (packId: string, side: Side, n: number): string => `${packId}:${side}:${n}`;

type Row = Record<string, unknown>;

const inserted = (r: { rowsAffected: number }): WriteResult => ({ inserted: r.rowsAffected > 0 });

// ---- pack ---------------------------------------------------------------------------------------

export async function insertPack(db: Exec, p: PackRow): Promise<WriteResult> {
  return inserted(
    await db.execute({
      sql: `INSERT INTO steelman_pack (pack_id, market, d, subject_kind, subject_id, code,
              card_id, cutoff_at, items_json, item_count, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT DO NOTHING`,
      args: [
        p.packId,
        p.market,
        p.d,
        p.subjectKind,
        p.subjectId,
        p.code,
        p.cardId,
        p.cutoffAt,
        jsonText(p.items),
        p.itemCount,
        p.createdAt,
      ],
    }),
  );
}

const packOf = (r: Row): PackRow => ({
  packId: str(r.pack_id),
  market: str(r.market),
  d: str(r.d),
  subjectKind: str(r.subject_kind) as SubjectKind,
  subjectId: str(r.subject_id),
  code: str(r.code),
  cardId: strOrNull(r.card_id),
  cutoffAt: str(r.cutoff_at),
  items: parseJson<PackItemRow[]>(r.items_json),
  itemCount: num(r.item_count),
  createdAt: str(r.created_at),
});

export async function readPack(db: Exec, packId: string): Promise<PackRow | null> {
  const r = await db.execute({ sql: `SELECT * FROM steelman_pack WHERE pack_id = ?`, args: [packId] });
  return r.rows[0] ? packOf(r.rows[0] as Row) : null;
}

export async function readPackForSubject(
  db: Exec,
  market: string,
  d: string,
  kind: SubjectKind,
  subjectId: string,
): Promise<PackRow | null> {
  const r = await db.execute({
    sql: `SELECT * FROM steelman_pack WHERE market = ? AND d = ? AND subject_kind = ? AND subject_id = ?`,
    args: [market, d, kind, subjectId],
  });
  return r.rows[0] ? packOf(r.rows[0] as Row) : null;
}

export async function readPackForCard(db: Exec, cardId: string): Promise<PackRow | null> {
  const r = await db.execute({
    sql: `SELECT * FROM steelman_pack WHERE card_id = ? ORDER BY created_at DESC, pack_id LIMIT 1`,
    args: [cardId],
  });
  return r.rows[0] ? packOf(r.rows[0] as Row) : null;
}

export async function listPacks(db: Exec, market: string, d: string): Promise<PackRow[]> {
  const r = await db.execute({
    sql: `SELECT * FROM steelman_pack WHERE market = ? AND d = ? ORDER BY subject_kind, subject_id`,
    args: [market, d],
  });
  return r.rows.map((x) => packOf(x as Row));
}

// ---- points -------------------------------------------------------------------------------------

export async function insertPoint(db: Exec, p: PointRow): Promise<WriteResult> {
  return inserted(
    await db.execute({
      sql: `INSERT INTO steelman_point (point_id, pack_id, side, n, text, citations_json,
              monitorable, state, author_provider, author_model, critic_provider, critic_model,
              critic_note, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT DO NOTHING`,
      args: [
        p.pointId,
        p.packId,
        p.side,
        p.n,
        p.text,
        jsonText(p.citations),
        p.monitorable ? 1 : 0,
        p.state,
        p.authorProvider,
        p.authorModel,
        p.criticProvider,
        p.criticModel,
        p.criticNote,
        p.createdAt,
      ],
    }),
  );
}

const pointOf = (r: Row): PointRow => ({
  pointId: str(r.point_id),
  packId: str(r.pack_id),
  side: str(r.side) as Side,
  n: num(r.n),
  text: str(r.text),
  citations: parseJson<string[]>(r.citations_json),
  monitorable: num(r.monitorable) === 1,
  state: str(r.state) as PointState,
  authorProvider: str(r.author_provider),
  authorModel: str(r.author_model),
  criticProvider: strOrNull(r.critic_provider),
  criticModel: strOrNull(r.critic_model),
  criticNote: strOrNull(r.critic_note),
  createdAt: str(r.created_at),
});

/** All points of a pack (any state), bear before bull alphabetically by side, then by n. */
export async function readPoints(db: Exec, packId: string): Promise<PointRow[]> {
  const r = await db.execute({
    sql: `SELECT * FROM steelman_point WHERE pack_id = ? ORDER BY side, n`,
    args: [packId],
  });
  return r.rows.map((x) => pointOf(x as Row));
}

export async function readPoint(db: Exec, pointId: string): Promise<PointRow | null> {
  const r = await db.execute({ sql: `SELECT * FROM steelman_point WHERE point_id = ?`, args: [pointId] });
  return r.rows[0] ? pointOf(r.rows[0] as Row) : null;
}

/** The points that render: state 'shown' only. */
export async function readShownPoints(db: Exec, packId: string): Promise<PointRow[]> {
  const r = await db.execute({
    sql: `SELECT * FROM steelman_point WHERE pack_id = ? AND state = 'shown' ORDER BY side, n`,
    args: [packId],
  });
  return r.rows.map((x) => pointOf(x as Row));
}

// ---- night --------------------------------------------------------------------------------------

export async function insertNight(db: Exec, n: NightRow): Promise<WriteResult> {
  return inserted(
    await db.execute({
      sql: `INSERT INTO steelman_night (market, d, requested, written, not_written_limit,
              not_written_budget, not_written_no_model, not_written_critic, claims_total, claims_valid,
              validity_ppm, critic_hidden, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT DO NOTHING`,
      args: [
        n.market,
        n.d,
        n.requested,
        n.written,
        n.notWrittenLimit,
        n.notWrittenBudget,
        n.notWrittenNoModel,
        n.notWrittenCritic,
        n.claimsTotal,
        n.claimsValid,
        n.validityPpm,
        n.criticHidden,
        n.createdAt,
      ],
    }),
  );
}

const nightOf = (r: Row): NightRow => ({
  market: str(r.market),
  d: str(r.d),
  requested: num(r.requested),
  written: num(r.written),
  notWrittenLimit: num(r.not_written_limit),
  notWrittenBudget: num(r.not_written_budget),
  notWrittenNoModel: num(r.not_written_no_model),
  notWrittenCritic: num(r.not_written_critic),
  claimsTotal: num(r.claims_total),
  claimsValid: num(r.claims_valid),
  validityPpm: num(r.validity_ppm),
  criticHidden: num(r.critic_hidden),
  createdAt: str(r.created_at),
});

export async function readNight(db: Exec, market: string, d: string): Promise<NightRow | null> {
  const r = await db.execute({
    sql: `SELECT * FROM steelman_night WHERE market = ? AND d = ?`,
    args: [market, d],
  });
  return r.rows[0] ? nightOf(r.rows[0] as Row) : null;
}

/** The most recent nights, newest first (the BLD-041 evidence and the health item). */
export async function readNights(db: Exec, market: string, limit: number): Promise<NightRow[]> {
  const r = await db.execute({
    sql: `SELECT * FROM steelman_night WHERE market = ? ORDER BY d DESC LIMIT ?`,
    args: [market, limit],
  });
  return r.rows.map((x) => nightOf(x as Row));
}

// ---- suggestions --------------------------------------------------------------------------------

export type NewSuggestion = Omit<SuggestionRow, "suggestionId" | "status" | "closedAt" | "closedBy">;

/** suggestion_id = point_id. The migration refuses a point that is not a shown monitorable bear point. */
export async function insertSuggestion(db: Exec, s: NewSuggestion): Promise<WriteResult> {
  return inserted(
    await db.execute({
      sql: `INSERT INTO steelman_suggestion (suggestion_id, market, d, point_id, card_id, code,
              family, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)
            ON CONFLICT DO NOTHING`,
      args: [s.pointId, s.market, s.d, s.pointId, s.cardId, s.code, s.family, s.createdAt],
    }),
  );
}

const suggestionOf = (r: Row): SuggestionRow => ({
  suggestionId: str(r.suggestion_id),
  market: str(r.market),
  d: str(r.d),
  pointId: str(r.point_id),
  cardId: strOrNull(r.card_id),
  code: str(r.code),
  family: str(r.family),
  status: str(r.status) as SuggestionStatus,
  createdAt: str(r.created_at),
  closedAt: strOrNull(r.closed_at),
  closedBy: strOrNull(r.closed_by),
});

export async function readSuggestion(db: Exec, id: string): Promise<SuggestionRow | null> {
  const r = await db.execute({
    sql: `SELECT * FROM steelman_suggestion WHERE suggestion_id = ?`,
    args: [id],
  });
  return r.rows[0] ? suggestionOf(r.rows[0] as Row) : null;
}

export async function readOpenSuggestions(db: Exec, market: string): Promise<SuggestionRow[]> {
  const r = await db.execute({
    sql: `SELECT * FROM steelman_suggestion WHERE market = ? AND status = 'open' ORDER BY d DESC, suggestion_id`,
    args: [market],
  });
  return r.rows.map((x) => suggestionOf(x as Row));
}

/** Closes an open suggestion once. false = it was not open (already closed or unknown). */
export async function closeSuggestion(
  db: Exec,
  id: string,
  status: "dismissed" | "expired",
  closedAt: string,
  closedBy: string,
): Promise<boolean> {
  const r = await db.execute({
    sql: `UPDATE steelman_suggestion SET status = ?, closed_at = ?, closed_by = ?
          WHERE suggestion_id = ? AND status = 'open'`,
    args: [status, closedAt, closedBy, id],
  });
  return r.rowsAffected > 0;
}
