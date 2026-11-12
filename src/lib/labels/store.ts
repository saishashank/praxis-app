// Hand labels of announcements, per market (M20 A5; DAT-247, D-1121, AT-75). The `label_item` table is append-only and
// keyed by (market, source, ann_id, labelled_at): a relabel is a new row, the newest row per item is the current
// label, nothing is edited or deleted (the table's own triggers refuse both). The page that collects labels is M21
// (UXN-318); this is the store it writes to and the reads the evaluation uses. A write goes through the table's
// market guard, so a market that is off is refused by the database.
import type { Client } from "@libsql/client";
import { ANNOUNCEMENT_CATEGORIES } from "@/lib/cortex/profileReaders";

/** D-1121: an evaluation against the labels refuses to run below this many labelled items of the market. */
export const MIN_LABELS_FOR_EVALUATION = 500;

export type LabelRow = {
  readonly market: string;
  readonly source: string;
  readonly annId: string;
  readonly label: string;
  readonly labelledAt: string;
  readonly actor: string;
};

const PAGE = 500; // threshold-ok: keyset page size, a transport size and not a rule

/** Appends one label (a category of the 11); `at` defaults to now. Throws on a label outside the 11 categories. */
export async function appendLabel(
  db: Pick<Client, "execute">,
  input: {
    readonly market: string;
    readonly source: string;
    readonly annId: string;
    readonly label: string;
    readonly actor: string;
    readonly at?: Date | string;
  },
): Promise<LabelRow> {
  if (!(ANNOUNCEMENT_CATEGORIES as readonly string[]).includes(input.label)) {
    throw new RangeError(`label must be one of the 11 categories, got ${input.label}`);
  }
  const labelledAt = new Date(input.at ?? Date.now()).toISOString();
  await db.execute({
    // rows-ok: one keyed insert (market, source, ann_id, labelled_at); the table refuses an update or a delete
    sql: "INSERT INTO label_item (market, source, ann_id, label, labelled_at, actor) VALUES (?, ?, ?, ?, ?, ?)",
    args: [input.market, input.source, input.annId, input.label, labelledAt, input.actor],
  });
  return {
    market: input.market,
    source: input.source,
    annId: input.annId,
    label: input.label,
    labelledAt,
    actor: input.actor,
  };
}

/**
 * The current label of every labelled item of the market (the newest row per item), ordered by (source, ann_id).
 * Read by keyset pages of 500 (no OFFSET): each page starts after the last (source, ann_id) of the one before.
 */
export async function labelsFor(db: Pick<Client, "execute">, market: string): Promise<LabelRow[]> {
  const out: LabelRow[] = [];
  let source = "";
  let annId = "";
  for (;;) {
    const r = await db.execute({
      // rows-ok: keyset-paged by (source, ann_id), LIMIT 500; one market holds hundreds to a few thousand hand labels
      sql: `SELECT l.source, l.ann_id, l.label, l.labelled_at, l.actor FROM label_item l
            WHERE l.market = ? AND (l.source, l.ann_id) > (?, ?)
              AND l.labelled_at = (SELECT MAX(m.labelled_at) FROM label_item m
                                   WHERE m.market = l.market AND m.source = l.source AND m.ann_id = l.ann_id)
            ORDER BY l.source, l.ann_id LIMIT 500`,
      args: [market, source, annId],
    });
    for (const x of r.rows) {
      out.push({
        market,
        source: String(x.source),
        annId: String(x.ann_id),
        label: String(x.label),
        labelledAt: String(x.labelled_at),
        actor: String(x.actor),
      });
    }
    if (r.rows.length < PAGE) return out;
    const last = r.rows[r.rows.length - 1]!;
    source = String(last.source);
    annId = String(last.ann_id);
  }
}

/** The number of distinct labelled items of the market (a relabel does not count twice). */
export async function labelledCount(db: Pick<Client, "execute">, market: string): Promise<number> {
  const r = await db.execute({
    // rows-ok: one market's label rows (hundreds), grouped by item
    sql: "SELECT COUNT(*) AS n FROM (SELECT 1 FROM label_item WHERE market = ? GROUP BY source, ann_id)",
    args: [market],
  });
  return Number(r.rows[0]!.n);
}

export type EvaluationGate = {
  readonly allowed: boolean;
  readonly count: number;
  readonly required: number;
};

/** D-1121: evaluation is allowed at 500 labelled items or more (the count is per market). */
export async function evaluationAllowed(
  db: Pick<Client, "execute">,
  market: string,
): Promise<EvaluationGate> {
  const count = await labelledCount(db, market);
  return {
    allowed: count >= MIN_LABELS_FOR_EVALUATION,
    count,
    required: MIN_LABELS_FOR_EVALUATION,
  };
}
