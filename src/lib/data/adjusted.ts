// Adjusted-price reader (M2 T8). Read-only: the raw bars are never changed (DAT-002) and no
// adjusted series is stored. Each bar's prices are the raw prices times the product of the
// latest confirmed factor of every corporate action whose ex-date is AFTER the bar's date.
// DAT-126 ("Indicators use only adjustment factors with ex-date <= D") is the caller's rule: a
// reader asked for a decision date D passes `asOf` = D and then only actions with ex-date <= D are
// applied, so no factor from the future leaks into a replay.
//
// "Confirmed" means the newest event of the action is auto_confirmed, applied_best_evidence or
// resolved/confirmed; a rejected, superseded, reversed or still-queued action never adjusts. For
// each confirmed action the newest `adjustment_factor` row wins (a recompute adds rows). Volume is
// divided by the same product so traded value stays continuous.
//
// GL-02: DAT-126 limits by ex-date; GL-02 adds the second bound. A reader that replays decision D
// passes `knownBy` = the decision cut-off of D and an action confirmed after it is ignored, so a
// split confirmed on D+5 changes nothing for D..D+4 (see corporate_action.known_at, migration 0016).
//
// Numeric: factors are stored as the nearest double to the exact fraction (see
// corporateActions/rules.mjs); the product of a few such doubles is within a few ulps (1e-15
// relative), far below a tick, and the reader does not round.
import { listingFloor } from "@/lib/data/listing";
import type { Client } from "@libsql/client";
import { boundedKnownAt } from "@/lib/arena/corpActions";
import { isRealDate } from "./pipeline/rules.mjs";
import { factorKindOf, isEffective, stateOf } from "./corporateActions/rules.mjs";

/**
 * V1-I4 / D-790: `knownBy` is mandatory. A reader that omits the bound would see a split confirmed
 * AFTER the decision (look-ahead). Pass the decision cut-off (`decisionCutoffUtc`) for a replay, or
 * `UNBOUNDED` only for a reconstruction that is not a decision (a chart, an audit). Nothing in
 * `src/` calls this reader today; `adjustment_factor` rows are reconstruction input only, and the
 * live paths use `corpActions.ts` (as-of `known_at`).
 */
export const UNBOUNDED = "unbounded" as const;
export type KnownBy = string | typeof UNBOUNDED;

export type RawBar = { o: number; h: number; l: number; c: number; volume: number };
export type AdjustedBar = RawBar & {
  d: string;
  /** Product of the factors applied to this bar (1 when none) = priceFactor x splitFactor. */
  factor: number;
  /** DAT-233: product of the `price` kind factors (dividends and the like); 1 when none. */
  priceFactor: number;
  /** DAT-233: product of the `split` kind factors (share-count changes); 1 when none. */
  splitFactor: number;
  raw: RawBar;
};

export type EffectiveFactor = {
  actionId: number;
  exDate: string;
  factor: number;
  /** DAT-233 (D-237): stored kind, else (legacy NULL) the kind of the action type. */
  kind: "price" | "split";
  /** GL-02: when the action was first confirmed; null = known since before the column. */
  knownAt: string | null;
};

/** GL-02: true when the action was already known at the cut-off instant (null = always known). */
export function isKnownBy(knownAt: string | null, cutoffIso: KnownBy): boolean {
  if (cutoffIso === UNBOUNDED || knownAt === null) return true;
  const k = Date.parse(knownAt);
  return Number.isFinite(k) && k <= Date.parse(cutoffIso);
}

/** The confirmed actions of a code with their newest factor. */
export async function effectiveFactors(
  db: Pick<Client, "execute">,
  code: string,
  market: string,
  knownBy: KnownBy,
): Promise<EffectiveFactor[]> {
  const acts = await db.execute({
    sql: `SELECT ca.id AS id, ca.ex_date AS ex_date, ca.known_at AS known_at,
            (SELECT e.status FROM corporate_action_event e WHERE e.action_id = ca.id
               ORDER BY e.id DESC LIMIT 1) AS status,
            (SELECT e.note FROM corporate_action_event e WHERE e.action_id = ca.id
               ORDER BY e.id DESC LIMIT 1) AS note,
            (SELECT e.at FROM corporate_action_event e WHERE e.action_id = ca.id
               ORDER BY e.id ASC LIMIT 1) AS first_at,
            (SELECT e.at FROM corporate_action_event e WHERE e.action_id = ca.id
               ORDER BY e.id DESC LIMIT 1) AS last_at,
            ca.type AS type,
            (SELECT f.factor FROM adjustment_factor f WHERE f.market = ca.market
               AND f.corporate_action_id = ca.id ORDER BY f.computed_at DESC LIMIT 1) AS factor,
            (SELECT f.factor_kind FROM adjustment_factor f WHERE f.market = ca.market
               AND f.corporate_action_id = ca.id ORDER BY f.computed_at DESC LIMIT 1) AS kind
          FROM corporate_action ca WHERE ca.market = ? AND ca.code = ? ORDER BY ca.ex_date, ca.id`,
    args: [market, code],
  });
  const out: EffectiveFactor[] = [];
  for (const r of acts.rows) {
    if (r.status === null || r.factor === null) continue;
    const st = stateOf({ status: String(r.status), note: r.note === null ? null : String(r.note) });
    if (!isEffective(st.state)) continue;
    // V2-I7: a NULL known_at is "always known" only for a legacy row (first event before 0016).
    const knownAt = boundedKnownAt(
      r.known_at === null || r.known_at === undefined ? null : String(r.known_at),
      r.first_at === null || r.first_at === undefined ? null : String(r.first_at),
      r.last_at === null || r.last_at === undefined ? null : String(r.last_at),
    );
    if (!isKnownBy(knownAt, knownBy)) continue;
    out.push({
      actionId: Number(r.id),
      exDate: String(r.ex_date),
      factor: Number(r.factor),
      kind: r.kind === "price" || r.kind === "split" ? r.kind : factorKindOf(String(r.type)),
      knownAt,
    });
  }
  return out;
}

export async function adjustedBars(
  db: Pick<Client, "execute">,
  code: string,
  from: string,
  to: string,
  opts: { market?: string; asOf?: string; knownBy: KnownBy },
): Promise<AdjustedBar[]> {
  const market = opts.market ?? "AU";
  if (!/^[A-Z0-9]{2,6}$/.test(code)) throw new RangeError("invalid code");
  if (!isRealDate(from) || !isRealDate(to) || from > to) throw new RangeError("invalid range");
  if (opts.asOf !== undefined && !isRealDate(opts.asOf)) throw new RangeError("invalid asOf");
  const asOf = opts.asOf ?? "9999-12-31";
  // GL-02: with `knownBy` (the decision cut-off of D) only actions confirmed by then count.
  const factors = (await effectiveFactors(db, code, market, opts.knownBy)).filter(
    (x) => x.exDate <= asOf,
  );
  const bars = await db.execute({
    sql: `SELECT d, o, h, l, c, volume FROM price_bar
          WHERE market = ? AND code = ? AND d >= ? AND d <= ? AND ${listingFloor("price_bar")}
          ORDER BY d`,
    args: [market, code, from, to],
  });
  return bars.rows.map((r) => {
    const d = String(r.d);
    let pf = 1;
    let sf = 1;
    for (const x of factors) {
      if (x.exDate <= d) continue;
      if (x.kind === "price") pf *= x.factor;
      else sf *= x.factor;
    }
    const f = pf * sf;
    const raw: RawBar = {
      o: Number(r.o),
      h: Number(r.h),
      l: Number(r.l),
      c: Number(r.c),
      volume: Number(r.volume),
    };
    return {
      d,
      o: raw.o * f,
      h: raw.h * f,
      l: raw.l * f,
      c: raw.c * f,
      volume: raw.volume / f,
      factor: f,
      priceFactor: pf,
      splitFactor: sf,
      raw,
    };
  });
}
