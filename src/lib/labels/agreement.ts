// Agreement of the text labels with the Owner's golden labels (M23 T1; CXA-008, CTX-040, D-1636, D-1661). Per label kind
// (guidance, event confirmation, tone) and per market: of the distinct items the Owner labelled, how many have a text label
// equal to the Owner's latest labelled answer, with a one-sided 90 % Wilson lower bound. An item with no accepted text label
// counts as a disagreement (the conservative reading) and is reported separately. The evaluation refuses below the golden
// floor (`label_golden_min`, 500): a handful of labels is never read as a measured agreement. Read-only; writes nothing.
import type { Client } from "@libsql/client";
import { LabelsBelowMinimum } from "./evaluate";
import { goldenCount } from "./golden";
import { goldenMin } from "./store";

/** One-sided 90 % normal quantile (the 0.90 point of the standard normal). */
export const Z_90 = 1.2815515655446004; // threshold-ok: a statistical constant (the one-sided 90 % level of CXA-008), not a rule value
/** D-1636 [PROPOSED]: the agreement lower bound must reach this for a PASS (the CTX-040 text gives no number). */
export const AGREEMENT_THRESHOLD = 0.7; // threshold-ok: D-1636 pre-registered agreement threshold, listed for the Owner
const PAGE = 500; // threshold-ok: keyset page size, a transport size and not a rule

/** The one-sided 90 % Wilson lower bound of k successes in n trials (0 for n = 0). */
export function wilsonLower(k: number, n: number, z: number = Z_90): number {
  if (n <= 0) return 0;
  const p = k / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - spread) / (1 + z2 / n));
}

const KINDS = ["guidance", "event_confirm", "tone"] as const;
export type AgreementKind = (typeof KINDS)[number];

export type LabelAgreement = {
  readonly kind: AgreementKind;
  /** Distinct golden-labelled items compared. */
  readonly n: number;
  readonly agree: number;
  /** Of n, the items with no accepted text label (counted as disagreements). */
  readonly missing: number;
  readonly rate: number;
  readonly lower: number;
  readonly clears: boolean;
};

export type AgreementResult = {
  readonly market: string;
  readonly items: number;
  readonly required: number;
  readonly threshold: number;
  readonly byLabel: readonly LabelAgreement[];
};

const latestText = (kind: AgreementKind): string =>
  `(SELECT t.value FROM text_label t
      WHERE t.market = g.market AND t.announcement_id = g.source || '|' || g.ann_id AND t.label_kind = '${kind}'
      ORDER BY t.produced_at DESC LIMIT 1)`;

/**
 * Agreement per label for one market. Throws `LabelsBelowMinimum` when the distinct golden-labelled items are fewer than
 * `label_golden_min` (499 refused, 500 runs). The Owner's answer for an item is its newest row with answer `labelled`.
 */
export async function agreement(
  db: Pick<Client, "execute">,
  market: string,
  opts: { readonly threshold?: number } = {},
): Promise<AgreementResult> {
  const required = await goldenMin(db);
  const items = await goldenCount(db, market);
  if (items < required) throw new LabelsBelowMinimum(market, items, required);
  const threshold = opts.threshold ?? AGREEMENT_THRESHOLD;
  const tally = {
    guidance: { n: 0, agree: 0, missing: 0 },
    event_confirm: { n: 0, agree: 0, missing: 0 },
    tone: { n: 0, agree: 0, missing: 0 },
  };
  let source = "";
  let annId = "";
  for (;;) {
    const r = await db.execute({
      // rows-ok: keyset-paged by (source, ann_id), LIMIT 500; one market's golden items (hundreds), each with three keyed text_label reads
      sql: `SELECT g.source, g.ann_id, g.guidance, g.event_confirm, g.tone,
                   ${latestText("guidance")} AS t_guidance,
                   ${latestText("event_confirm")} AS t_event_confirm,
                   ${latestText("tone")} AS t_tone
            FROM golden_label g
            WHERE g.market = ? AND g.answer = 'labelled' AND (g.source, g.ann_id) > (?, ?)
              AND g.labelled_at = (SELECT MAX(m.labelled_at) FROM golden_label m
                                   WHERE m.market = g.market AND m.source = g.source AND m.ann_id = g.ann_id
                                     AND m.answer = 'labelled')
            ORDER BY g.source, g.ann_id LIMIT 500`,
      args: [market, source, annId],
    });
    for (const x of r.rows) {
      for (const k of KINDS) {
        const t = tally[k];
        t.n += 1;
        const model = x[`t_${k}`];
        if (model === null || model === undefined) t.missing += 1;
        else if (String(model) === String(x[k])) t.agree += 1;
      }
    }
    if (r.rows.length < PAGE) break;
    const last = r.rows[r.rows.length - 1]!;
    source = String(last.source);
    annId = String(last.ann_id);
  }
  const byLabel = KINDS.map((kind): LabelAgreement => {
    const t = tally[kind];
    const lower = wilsonLower(t.agree, t.n);
    return {
      kind,
      n: t.n,
      agree: t.agree,
      missing: t.missing,
      rate: t.n === 0 ? 0 : t.agree / t.n,
      lower,
      clears: lower >= threshold,
    };
  });
  return { market, items, required, threshold, byLabel };
}
