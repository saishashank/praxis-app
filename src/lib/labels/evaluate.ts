// Evaluation of the announcement classifier against a market's hand labels (M20 A5; DAT-247, D-1121, AT-75). It runs
// only with at least 500 labelled items of the market (`evaluationAllowed`); below that it refuses with
// `LabelsBelowMinimum`, so a handful of labels can never be read as a measured accuracy. The classifier under test is
// the stored `announcement_category` of each labelled item (the map's output, written by batch 1); an item with no
// stored category counts as a miss and is listed as unclassified.
import type { Client } from "@libsql/client";
import { evaluationAllowed, MIN_LABELS_FOR_EVALUATION, type EvaluationGate } from "./store";

/** Thrown when an evaluation is asked for with fewer than 500 labelled items (D-1121). */
export class LabelsBelowMinimum extends Error {
  readonly market: string;
  readonly count: number;
  readonly required: number;
  constructor(market: string, count: number, required: number = MIN_LABELS_FOR_EVALUATION) {
    super(`evaluation refused: ${market} has ${count} labelled items, ${required} are needed`);
    this.name = "LabelsBelowMinimum";
    this.market = market;
    this.count = count;
    this.required = required;
  }
}

export type CategoryScore = { readonly labelled: number; readonly correct: number };

export type Evaluation = {
  readonly market: string;
  readonly labelled: number;
  readonly correct: number;
  readonly unclassified: number;
  /** correct / labelled as exact text `num/den`. */
  readonly accuracy: string;
  readonly byCategory: Readonly<Record<string, CategoryScore>>;
};

const PAGE = 500; // threshold-ok: keyset page size, a transport size and not a rule

/** Throws `LabelsBelowMinimum` below 500 labelled items; returns the gate otherwise. */
export async function assertEvaluationAllowed(
  db: Pick<Client, "execute">,
  market: string,
): Promise<EvaluationGate> {
  const gate = await evaluationAllowed(db, market);
  if (!gate.allowed) throw new LabelsBelowMinimum(market, gate.count, gate.required);
  return gate;
}

/** The classifier's accuracy against the market's current hand labels, overall and per labelled category. */
export async function evaluateClassifier(
  db: Pick<Client, "execute">,
  market: string,
): Promise<Evaluation> {
  await assertEvaluationAllowed(db, market);
  const byCategory: Record<string, { labelled: number; correct: number }> = {};
  let labelled = 0;
  let correct = 0;
  let unclassified = 0;
  let source = "";
  let annId = "";
  for (;;) {
    const r = await db.execute({
      // rows-ok: keyset-paged by (source, ann_id), LIMIT 500, one market's labelled items joined by the primary key
      sql: `SELECT l.source, l.ann_id, l.label, c.category AS category FROM label_item l
            LEFT JOIN announcement_category c
              ON c.market = l.market AND c.source = l.source AND c.ann_id = l.ann_id
            WHERE l.market = ? AND (l.source, l.ann_id) > (?, ?)
              AND l.labelled_at = (SELECT MAX(m.labelled_at) FROM label_item m
                                   WHERE m.market = l.market AND m.source = l.source AND m.ann_id = l.ann_id)
            ORDER BY l.source, l.ann_id LIMIT 500`,
      args: [market, source, annId],
    });
    for (const x of r.rows) {
      const label = String(x.label);
      const hit = x.category !== null && String(x.category) === label;
      const slot = (byCategory[label] ??= { labelled: 0, correct: 0 });
      slot.labelled += 1;
      labelled += 1;
      if (hit) {
        slot.correct += 1;
        correct += 1;
      }
      if (x.category === null) unclassified += 1;
    }
    if (r.rows.length < PAGE) break;
    const last = r.rows[r.rows.length - 1]!;
    source = String(last.source);
    annId = String(last.ann_id);
  }
  return {
    market,
    labelled,
    correct,
    unclassified,
    accuracy: `${correct}/${labelled}`,
    byCategory,
  };
}
