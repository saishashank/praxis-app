// VAL-121 selection (M21 R1; D-1228, section H of docs/M21_design.md): fixed before any computation (BLD-051). For a market
// and session D, from the stored Cortex decisions that passed every gate (live, queued and shadow arms), the 5 lowest by the
// stored rank order; plus up to 5 codes of tier U1 or U2 whose event polarity at D is -1 (the stored, rule-derived polarity).
// A code outside the market's shortable tiers is still stored, with `shortable` 0. Pure reads: nothing is written here.
import type { Client } from "@libsql/client";
import { shortRulesOf } from "@/lib/market/seed/shortRules.mjs";
import type { ShortOrigin } from "./store";

export const LOWEST_RANK_N = 5; // threshold-ok: VAL-121 pre-registered selection size
export const EVENT_POLARITY_N = 5; // threshold-ok: VAL-121 pre-registered selection size
const EVENT_TIERS: readonly string[] = ["U1", "U2"];
export const SHORT_RULE_ID = "short_shadow.v1";

export type ShortSetup = {
  readonly market: string;
  readonly d: string;
  readonly code: string;
  readonly origin: ShortOrigin;
  readonly bookId: string;
  readonly rankKey: string | null;
  readonly family: string | null;
  readonly shortable: boolean;
};

/** The stored rank key (a JSON array of numbers, higher is better) as numbers; null = no usable key (never "lowest"). */
export function parseRankKey(text: string | null): readonly number[] | null {
  if (text === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(v) || v.length === 0) return null;
  // a non-finite number is stored as null by JSON: its direction is unknown, so the row has no usable rank (D-1296)
  if (!v.every((x) => typeof x === "number" && Number.isFinite(x))) return null;
  return v as number[];
}

function cmpAsc(a: readonly number[], b: readonly number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

async function tiersOf(
  db: Client,
  market: string,
  d: string,
  codes: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const code of codes) {
    // rows-ok: one key probe (market, d, code) of the universe snapshot per selected code (at most 10 a night)
    const rs = await db.execute({
      sql: "SELECT tier FROM universe_snapshot WHERE market = ? AND d = ? AND code = ?",
      args: [market, d, code],
    });
    if (rs.rows.length > 0) out.set(code, String(rs.rows[0]!.tier));
  }
  return out;
}

type Cand = { code: string; bookId: string; family: string; text: string; key: readonly number[] };

export async function selectShort(
  db: Client,
  o: { market: string; d: string },
): Promise<readonly ShortSetup[]> {
  const rules = shortRulesOf(o.market);
  // rows-ok: one night's passing decisions, at most books x codes of one session (bounded by the night's own writes)
  const dec = await db.execute({
    sql: `SELECT book_id, code, family, rank_key FROM cortex_decision
          WHERE market = ? AND d = ? AND first_fail_gate IS NULL ORDER BY code, book_id, arm`,
    args: [o.market, o.d],
  });
  const best = new Map<string, Cand>();
  for (const r of dec.rows) {
    const text = r.rank_key === null ? null : String(r.rank_key);
    const key = parseRankKey(text);
    if (key === null || text === null) continue;
    const c: Cand = {
      code: String(r.code),
      bookId: String(r.book_id),
      family: String(r.family),
      text,
      key,
    };
    const had = best.get(c.code);
    if (had === undefined || cmpAsc(c.key, had.key) < 0) best.set(c.code, c);
  }
  const lowest = [...best.values()]
    .sort((a, b) => cmpAsc(a.key, b.key) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
    .slice(0, LOWEST_RANK_N);

  // rows-ok: the codes with a polarity -1 event whose day 0 is D (one session's events); the first 5 eligible are kept
  const ev = await db.execute({
    sql: `SELECT code, MIN(COALESCE(ar_ppm, 0)) AS ar FROM event
          WHERE market = ? AND day0_d = ? AND polarity = -1
          GROUP BY code ORDER BY ar ASC, code ASC LIMIT 200`,
    args: [o.market, o.d],
  });
  const chosen = new Set(lowest.map((c) => c.code));
  const evCodes = ev.rows.map((r) => String(r.code)).filter((c) => !chosen.has(c));
  const evTiers = await tiersOf(db, o.market, o.d, evCodes);
  const evPicked = evCodes
    .filter((c) => EVENT_TIERS.includes(evTiers.get(c) ?? ""))
    .slice(0, EVENT_POLARITY_N);
  const lowTiers = await tiersOf(
    db,
    o.market,
    o.d,
    lowest.map((c) => c.code),
  );
  const shortable = (code: string, tiers: Map<string, string>): boolean =>
    rules.shortableTiers.includes(tiers.get(code) ?? "");

  const out: ShortSetup[] = lowest.map((c) => ({
    market: o.market,
    d: o.d,
    code: c.code,
    origin: "lowest_rank" as const,
    bookId: c.bookId,
    rankKey: c.text,
    family: c.family,
    shortable: shortable(c.code, lowTiers),
  }));
  for (const code of evPicked) {
    out.push({
      market: o.market,
      d: o.d,
      code,
      origin: "event_polarity",
      bookId: "none",
      rankKey: null,
      family: null,
      shortable: shortable(code, evTiers),
    });
  }
  return out;
}
