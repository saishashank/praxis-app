// text_label, label_validation and opinion_track (CTX-040, CTX-041, D-269, D-270). Nothing in the
// L2 score path reads these tables (static check in P5); they are staging and tracking only.
//
// A label is written together with its validation row in ONE batch (the migration's insert guard
// refuses a label without an existing validation row, and a NOT NULL manifest id).
import {
  insertIgnore,
  jsonText,
  parseJson,
  str,
  strOrNull,
  type BatchExec,
  type Exec,
  type WriteResult,
} from "./common";

export const LABEL_KINDS = ["guidance", "event_confirm", "tone"] as const;
export type LabelKind = (typeof LABEL_KINDS)[number];
export const VALIDATION_KINDS = ["paraphrase", "ar_sign", "golden", "incremental"] as const;
export type ValidationKind = (typeof VALIDATION_KINDS)[number];

export type LabelValidationRow = {
  validationId: string;
  market: string;
  kind: ValidationKind;
  result: unknown;
  createdAt: string;
};

export type TextLabelRow = {
  market: string;
  announcementId: string;
  labelKind: LabelKind;
  modelId: string;
  producedAt: string;
  value: string;
  citedSpan: string | null;
  manifestId: string;
  validationId: string;
};

/** Writes a label with its validation row atomically; the validation id on the label must match. */
export async function insertLabelWithValidation(
  db: BatchExec,
  label: TextLabelRow,
  validation: LabelValidationRow,
): Promise<void> {
  if (label.validationId !== validation.validationId) {
    throw new Error("text_label: validation_id does not match the validation row");
  }
  await db.batch(
    [
      {
        sql: `INSERT INTO label_validation (validation_id, market, kind, result_json, created_at)
              VALUES (?, ?, ?, ?, ?)`,
        args: [
          validation.validationId,
          validation.market,
          validation.kind,
          jsonText(validation.result),
          validation.createdAt,
        ],
      },
      {
        sql: `INSERT INTO text_label (market, announcement_id, label_kind, model_id, produced_at, value,
                cited_span, manifest_id, validation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          label.market,
          label.announcementId,
          label.labelKind,
          label.modelId,
          label.producedAt,
          label.value,
          label.citedSpan,
          label.manifestId,
          label.validationId,
        ],
      },
    ],
    "write",
  );
}

/** A further validation row for an existing label set (golden, incremental). */
export async function insertValidation(db: Exec, v: LabelValidationRow): Promise<void> {
  await db.execute({
    sql: `INSERT INTO label_validation (validation_id, market, kind, result_json, created_at)
          VALUES (?, ?, ?, ?, ?)`,
    args: [v.validationId, v.market, v.kind, jsonText(v.result), v.createdAt],
  });
}

export async function labelsForAnnouncement(
  db: Exec,
  market: string,
  announcementId: string,
): Promise<TextLabelRow[]> {
  const r = await db.execute({
    sql: `SELECT * FROM text_label WHERE market = ? AND announcement_id = ?
          ORDER BY label_kind, model_id, produced_at`,
    args: [market, announcementId],
  });
  return r.rows.map((x) => ({
    market: str(x.market),
    announcementId: str(x.announcement_id),
    labelKind: str(x.label_kind) as LabelKind,
    modelId: str(x.model_id),
    producedAt: str(x.produced_at),
    value: str(x.value),
    citedSpan: strOrNull(x.cited_span),
    manifestId: str(x.manifest_id),
    validationId: str(x.validation_id),
  }));
}

export async function getValidation(
  db: Exec,
  validationId: string,
): Promise<LabelValidationRow | null> {
  const r = await db.execute({
    sql: "SELECT * FROM label_validation WHERE validation_id = ?",
    args: [validationId],
  });
  const x = r.rows[0] as Record<string, unknown> | undefined;
  if (!x) return null;
  return {
    validationId: str(x.validation_id),
    market: str(x.market),
    kind: str(x.kind) as ValidationKind,
    result: parseJson(x.result_json),
    createdAt: str(x.created_at),
  };
}

// ---- opinion tracking (hook only) ----

export type OpinionRow = {
  market: string;
  opinionId: string;
  kind: "committee" | "steelman";
  code: string;
  d: string;
  value: unknown;
  settledD: string | null;
  outcome: unknown | null;
};

/** Records an opinion; a repeat of the same id keeps the first. */
export async function insertOpinion(
  db: Exec,
  o: Omit<OpinionRow, "settledD" | "outcome">,
): Promise<WriteResult> {
  return insertIgnore(db, {
    sql: `INSERT INTO opinion_track (market, opinion_id, kind, code, d, value_json)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [o.market, o.opinionId, o.kind, o.code, o.d, jsonText(o.value)],
  });
}

/**
 * Settles an opinion ONCE (settled_d and outcome_json go from NULL to a value together). Returns
 * false when it was already settled or does not exist; the row is never changed again.
 */
export async function settleOpinion(
  db: Exec,
  market: string,
  opinionId: string,
  settledD: string,
  outcome: unknown,
): Promise<boolean> {
  const r = await db.execute({
    sql: `UPDATE opinion_track SET settled_d = ?, outcome_json = ?
          WHERE market = ? AND opinion_id = ? AND settled_d IS NULL`,
    args: [settledD, jsonText(outcome), market, opinionId],
  });
  return r.rowsAffected > 0;
}

export async function unsettledOpinions(
  db: Exec,
  market: string,
  dBefore: string,
): Promise<OpinionRow[]> {
  const r = await db.execute({
    sql: `SELECT * FROM opinion_track WHERE market = ? AND settled_d IS NULL AND d <= ?
          ORDER BY d, opinion_id`,
    args: [market, dBefore],
  });
  return r.rows.map((x) => ({
    market: str(x.market),
    opinionId: str(x.opinion_id),
    kind: str(x.kind) as OpinionRow["kind"],
    code: str(x.code),
    d: str(x.d),
    value: parseJson(x.value_json),
    settledD: null,
    outcome: null,
  }));
}
