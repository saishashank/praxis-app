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
// Numeric: factors are stored as the nearest double to the exact fraction (see
// corporateActions/rules.mjs); the product of a few such doubles is within a few ulps (1e-15
// relative), far below a tick, and the reader does not round.
import type { Client } from "@libsql/client";
import { isRealDate } from "./pipeline/rules.mjs";
import { isEffective, stateOf } from "./corporateActions/rules.mjs";

export type RawBar = { o: number; h: number; l: number; c: number; volume: number };
export type AdjustedBar = RawBar & {
  d: string;
  /** Product of the factors applied to this bar (1 when none). */
  factor: number;
  raw: RawBar;
};

export type EffectiveFactor = { actionId: number; exDate: string; factor: number };

/** The confirmed actions of a code with their newest factor. */
export async function effectiveFactors(
  db: Pick<Client, "execute">,
  code: string,
  market = "AU",
): Promise<EffectiveFactor[]> {
  const acts = await db.execute({
    sql: `SELECT ca.id AS id, ca.ex_date AS ex_date,
            (SELECT e.status FROM corporate_action_event e WHERE e.action_id = ca.id
               ORDER BY e.id DESC LIMIT 1) AS status,
            (SELECT e.note FROM corporate_action_event e WHERE e.action_id = ca.id
               ORDER BY e.id DESC LIMIT 1) AS note,
            (SELECT f.factor FROM adjustment_factor f WHERE f.market = ca.market
               AND f.corporate_action_id = ca.id ORDER BY f.computed_at DESC LIMIT 1) AS factor
          FROM corporate_action ca WHERE ca.market = ? AND ca.code = ? ORDER BY ca.ex_date, ca.id`,
    args: [market, code],
  });
  const out: EffectiveFactor[] = [];
  for (const r of acts.rows) {
    if (r.status === null || r.factor === null) continue;
    const st = stateOf({ status: String(r.status), note: r.note === null ? null : String(r.note) });
    if (!isEffective(st.state)) continue;
    out.push({ actionId: Number(r.id), exDate: String(r.ex_date), factor: Number(r.factor) });
  }
  return out;
}

export async function adjustedBars(
  db: Pick<Client, "execute">,
  code: string,
  from: string,
  to: string,
  opts: { market?: string; asOf?: string } = {},
): Promise<AdjustedBar[]> {
  const market = opts.market ?? "AU";
  if (!/^[A-Z0-9]{2,6}$/.test(code)) throw new RangeError("invalid code");
  if (!isRealDate(from) || !isRealDate(to) || from > to) throw new RangeError("invalid range");
  if (opts.asOf !== undefined && !isRealDate(opts.asOf)) throw new RangeError("invalid asOf");
  const asOf = opts.asOf ?? "9999-12-31";
  const factors = (await effectiveFactors(db, code, market)).filter((x) => x.exDate <= asOf);
  const bars = await db.execute({
    sql: `SELECT d, o, h, l, c, volume FROM price_bar
          WHERE market = ? AND code = ? AND d >= ? AND d <= ? ORDER BY d`,
    args: [market, code, from, to],
  });
  return bars.rows.map((r) => {
    const d = String(r.d);
    let f = 1;
    for (const x of factors) if (x.exDate > d) f *= x.factor;
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
      raw,
    };
  });
}
