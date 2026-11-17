// Promotion request (M22 C4; AGT-148, CTX-060; D-1428, D-1519). When an opinion kind meets all three conditions (enough
// settled cases, a lift whose 90 % lower bound is above zero, the same sign in two judge-model versions) ONE row is written
// to `opinion_promotion_request` for the market and kind, ever, and one warning line goes to `app_log` saying so. That is
// all: there is no approve action, route, button or writer of anything else here. Making an opinion count for trading needs
// a new spec version and an Owner decision outside this code (PRD-033, D-930).
// The write is a pure evidence function plus two single statements, so the nightly job (task L4/Z) calls one entry.
import { getConfig } from "@/lib/config/store";
import { insertIgnore, jsonText, type Exec } from "@/lib/cortex/store/common";
import { loadMeters, type Meter, type MeterKind } from "./meter";

/** The one warning line (D-1428). */
export const PROMOTION_LINE =
  "An opinion has earned a review: needs a new spec version and an Owner decision";

/** The log source of the line. */
export const PROMOTION_SOURCE = "opinions";

/** Pure: the evidence stored with a request (at most 4,000 characters, the table's CHECK). */
export function evidenceOf(m: Meter): Record<string, unknown> {
  return {
    settled: m.settled,
    needed: m.needed,
    lift_ppm: m.lift?.ppm ?? null,
    lift_lower90_ppm: m.lift?.lower90Ppm ?? null,
    for_n: m.lift?.forN ?? null,
    against_n: m.lift?.againstN ?? null,
    versions: m.versions
      .slice(0, 20)
      .map((v) => ({ model: v.model.slice(0, 128), n: v.n, lift_ppm: v.liftPpm })), // threshold-ok: at most 20 versions, 128 characters each
  };
}

/**
 * Writes the request of a market and kind once. `true` = written now, `false` = one already exists (never rewritten, the
 * table is append-only). One statement.
 */
export async function requestPromotion(
  db: Exec,
  r: { market: string; kind: MeterKind; d: string; evidence: Record<string, unknown>; now: string },
): Promise<boolean> {
  // rows-ok: opinion_promotion_request primary key (market, kind), one row, insert-or-ignore
  const w = await insertIgnore(db, {
    sql: `INSERT INTO opinion_promotion_request (market, kind, requested_d, evidence_json, created_at)
          VALUES (?, ?, ?, ?, ?)`,
    args: [r.market, r.kind, r.d, jsonText(r.evidence), r.now],
  });
  return w.inserted;
}

/** The Owner's warning line, once per request. */
export async function warnPromotion(db: Exec, now: string): Promise<void> {
  // rows-ok: one warning line in app_log
  await db.execute({
    sql: "INSERT INTO app_log (at, level, source, message, run_id) VALUES (?, 'warn', ?, ?, NULL)",
    args: [now, PROMOTION_SOURCE, PROMOTION_LINE],
  });
}

export type PromotionResult = {
  meters: Meter[];
  /** Kinds whose request was written by this call. */
  requested: MeterKind[];
};

/**
 * The pure-plus-one-write entry (L4/Z schedule it): reads the meters of the market, and for each kind that has earned a
 * review and has no request yet writes the request and the warning line. Never throws: a failed write leaves the request
 * for the next night. `minN` is `opinion_min_n` (read from the config store when not given).
 */
export async function runPromotion(
  db: Exec,
  o: { market: string; d: string; now: string; minN?: number },
): Promise<PromotionResult> {
  const minN = o.minN ?? Number(await getConfig(db, "opinion_min_n"));
  const meters = await loadMeters(db, o.market, minN);
  const requested: MeterKind[] = [];
  for (const m of meters) {
    if (!m.earned) continue;
    try {
      const wrote = await requestPromotion(db, {
        market: o.market,
        kind: m.kind,
        d: o.d,
        evidence: evidenceOf(m),
        now: o.now,
      });
      if (!wrote) continue;
      requested.push(m.kind);
      await warnPromotion(db, o.now);
    } catch {
      // tried again tomorrow
    }
  }
  return { meters, requested };
}
