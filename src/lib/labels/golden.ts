// The golden-set labels (M21 L1; UXN-318, D-1227; CTX-040, DAT-247, CXA-008). The Owner reads a headline and answers three
// things (guidance, event confirmation, tone), or skips it, or flags it as unclear. `golden_label` is append-only: a relabel
// is a new row, nothing is updated or deleted (the table's triggers refuse both). This module never reads the model's own
// labels (`text_label`, `label_validation`) or the classifier store (`label_item`): the Owner's answer stays independent.
import type { Client } from "@libsql/client";
import { LABEL_ENUMS } from "@/lib/llm/textLabels";

/** The number of labelled items the golden set aims for per market (D-1121: an evaluation needs this many). */
export { MIN_LABELS_FOR_EVALUATION as GOLDEN_TARGET } from "@/lib/labels/store";

export const GOLDEN_ANSWERS = ["labelled", "skip", "unclear"] as const;
export type GoldenAnswer = (typeof GOLDEN_ANSWERS)[number];

const MAX_SPAN = 300; // threshold-ok: the table's CHECK bound on a cited span

export type GoldenInput = {
  readonly market: string;
  readonly source: string;
  readonly annId: string;
  readonly actor: string;
  readonly answer: GoldenAnswer;
  readonly guidance?: (typeof LABEL_ENUMS.guidance)[number] | null;
  readonly eventConfirm?: (typeof LABEL_ENUMS.event_confirm)[number] | null;
  readonly tone?: (typeof LABEL_ENUMS.tone)[number] | null;
  /** A piece of the headline that supports the answer (optional). */
  readonly span?: string | null;
  readonly at?: Date | string;
};

export type NextItem = {
  readonly market: string;
  readonly source: string;
  readonly annId: string;
  readonly title: string;
  readonly url: string | null;
  readonly publishedAt: string;
};

const inList = (list: readonly string[], v: unknown): boolean =>
  typeof v === "string" && list.includes(v);

/**
 * Appends one answer. Throws RangeError for a value outside the enums, a labelled answer with a missing part, a skip or
 * unclear answer that carries a label, or a span that is not a piece of the headline; throws Error when the announcement
 * does not exist. A write goes through the table's market guard.
 */
export async function appendGolden(
  db: Pick<Client, "execute">,
  input: GoldenInput,
): Promise<{ labelledAt: string }> {
  if (!(GOLDEN_ANSWERS as readonly string[]).includes(input.answer)) {
    throw new RangeError(`answer must be one of ${GOLDEN_ANSWERS.join(", ")}`);
  }
  const labelled = input.answer === "labelled";
  if (labelled) {
    if (!inList(LABEL_ENUMS.guidance, input.guidance))
      throw new RangeError("guidance is not allowed");
    if (!inList(LABEL_ENUMS.event_confirm, input.eventConfirm)) {
      throw new RangeError("event confirmation is not allowed");
    }
    if (!inList(LABEL_ENUMS.tone, input.tone)) throw new RangeError("tone is not allowed");
  } else if (input.guidance != null || input.eventConfirm != null || input.tone != null) {
    throw new RangeError("a skip or an unclear answer carries no label");
  }
  const found = await db.execute({
    // rows-ok: one keyed read on the unique (source, ann_id)
    sql: "SELECT title FROM announcement WHERE market = ? AND source = ? AND ann_id = ?",
    args: [input.market, input.source, input.annId],
  });
  if (found.rows.length === 0) throw new Error("announcement not found");
  const span = input.span ?? null;
  if (span !== null) {
    const title = String(found.rows[0]!.title);
    if (span.length < 1 || span.length > MAX_SPAN || !title.includes(span)) {
      throw new RangeError("span must be a piece of the headline");
    }
  }
  const labelledAt = new Date(input.at ?? Date.now()).toISOString();
  await db.execute({
    // rows-ok: one keyed insert (market, source, ann_id, labelled_at); the table refuses an update or a delete
    sql: `INSERT INTO golden_label (market, source, ann_id, labelled_at, actor, answer, guidance, event_confirm, tone, span)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      input.market,
      input.source,
      input.annId,
      labelledAt,
      input.actor,
      input.answer,
      labelled ? (input.guidance ?? null) : null,
      labelled ? (input.eventConfirm ?? null) : null,
      labelled ? (input.tone ?? null) : null,
      span,
    ],
  });
  return { labelledAt };
}

/** The newest announcement of the market with no `golden_label` row (any answer), or null when the queue is empty. */
export async function nextUnlabelled(
  db: Pick<Client, "execute">,
  market: string,
): Promise<NextItem | null> {
  const r = await db.execute({
    // rows-ok: LIMIT 1; the newest unanswered announcement, ordered by published_at then id (no OFFSET)
    sql: `SELECT a.source, a.ann_id, a.title, a.url, a.published_at FROM announcement a
          WHERE a.market = ?
            AND NOT EXISTS (SELECT 1 FROM golden_label g
                            WHERE g.market = a.market AND g.source = a.source AND g.ann_id = a.ann_id)
          ORDER BY a.published_at DESC, a.id DESC LIMIT 1`,
    args: [market],
  });
  const x = r.rows[0];
  if (!x) return null;
  return {
    market,
    source: String(x.source),
    annId: String(x.ann_id),
    title: String(x.title),
    url: x.url === null || x.url === undefined ? null : String(x.url),
    publishedAt: String(x.published_at),
  };
}

/** Distinct items of the market with at least one labelled answer (D-1168: skips, unclear answers and relabels add nothing). */
export async function goldenCount(db: Pick<Client, "execute">, market: string): Promise<number> {
  const r = await db.execute({
    // rows-ok: one aggregate over the market's golden rows (primary-key prefix); returns one row
    sql: `SELECT COUNT(*) AS n FROM (SELECT DISTINCT source, ann_id FROM golden_label
                                     WHERE market = ? AND answer = 'labelled')`,
    args: [market],
  });
  return Number(r.rows[0]?.n ?? 0);
}
