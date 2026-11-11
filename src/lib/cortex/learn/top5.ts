// D-985…D-987: the Owner's top-5 gainer target (2026-11-11) in the learning Cortex's evidence words.
// Per measure and night: did the measure's top tenth the evening before hold one of the day's five
// biggest liquid gainers, and one of the five biggest losers (learning/dailyTop5.ts top5Movers)? The
// flags are stored with the night's Cortex section (daily_learning.body_json.cortex.numbers.top5) and
// summed over the last four weeks for one line of words. Evidence and words only: the re-weighting
// objective and the base promotion test never read them. Pure except `top5History` (one range read
// of at most 19 rows, no OFFSET).
import type { Top5Sets } from "@/lib/learning/dailyTop5";
import type { BatchExec } from "../store/common";
import type { FeatureNight } from "./scorecard";
import { angleName } from "./words";

/** angle id -> [top tenth held a top-5 gainer, held a top-5 loser] (1 = yes). */
export type Top5Flags = Readonly<Record<string, readonly [number, number]>>;

/** Finished candidate picks of one probe measure (handed in by the picks entry, D-983). */
export type CandidateTally = { readonly finished: number; readonly madeMoney: number };

const TENTH = 10; // threshold-ok: the top tenth (same cut as the scorecard's mover coverage)

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Tonight's flags of every angle with values in `night` (pure). */
export function top5Flags(night: FeatureNight | null, sets: Top5Sets | undefined): Top5Flags {
  const out: Record<string, readonly [number, number]> = {};
  if (night === null || sets === undefined || sets.gainers.length + sets.losers.length === 0) {
    return out;
  }
  const values = new Map<string, [string, number][]>();
  for (const r of night.rows) {
    for (const [id, v] of Object.entries(r.features ?? {})) {
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      const list = values.get(id) ?? [];
      list.push([r.code, v]);
      values.set(id, list);
    }
  }
  const gainers = new Set(sets.gainers.map((m) => m.code));
  const losers = new Set(sets.losers.map((m) => m.code));
  for (const id of [...values.keys()].sort(byText)) {
    const ranked = values.get(id)!.sort((a, b) => b[1] - a[1] || byText(a[0], b[0]));
    const top = ranked.slice(0, Math.max(1, Math.floor(ranked.length / TENTH))).map(([c]) => c);
    out[id] = [top.some((c) => gainers.has(c)) ? 1 : 0, top.some((c) => losers.has(c)) ? 1 : 0];
  }
  return out;
}

/** The stored flags of the nights in [from, before) (oldest first; a malformed night is skipped). */
export async function top5History(
  db: BatchExec,
  market: string,
  from: string,
  before: string,
): Promise<Top5Flags[]> {
  if (from >= before) return [];
  const r = await db.execute({
    sql: `SELECT d, json_extract(body_json, '$.cortex.numbers.top5') AS t FROM daily_learning
          WHERE market = ? AND d >= ? AND d < ? ORDER BY d`,
    args: [market, from, before],
  });
  const out: Top5Flags[] = [];
  for (const row of r.rows) {
    if (row.t === null || row.t === undefined) continue;
    try {
      const v: unknown = JSON.parse(String(row.t));
      if (v !== null && typeof v === "object" && !Array.isArray(v)) out.push(v as Top5Flags);
    } catch {
      // not a stored night of flags
    }
  }
  return out;
}

export type Top5Count = {
  readonly nights: number;
  readonly gainer: number;
  readonly loser: number;
};

/** Sums of one angle's flags over the history and tonight (nights = nights the angle had values). */
export function top5Count(
  id: string,
  tonight: Top5Flags,
  history: readonly Top5Flags[],
): Top5Count {
  let nights = 0;
  let gainer = 0;
  let loser = 0;
  for (const f of [...history, tonight]) {
    const x = f[id];
    if (!Array.isArray(x)) continue;
    nights += 1;
    gainer += x[0] === 1 ? 1 : 0;
    loser += x[1] === 1 ? 1 : 0;
  }
  return { nights, gainer, loser };
}

const times = (n: number): string => (n === 1 ? "one night" : `${n} nights`);

/** The scorecard's top-5 line: the scored measure whose top tenth held a top-5 gainer most often. */
export function top5ScorecardWords(
  tonight: Top5Flags,
  history: readonly Top5Flags[],
): string | null {
  const ids = Object.keys(tonight).sort(byText);
  if (ids.length === 0) return null;
  const counts = ids.map((id) => ({ id, c: top5Count(id, tonight, history) }));
  counts.sort((a, b) => b.c.gainer - a.c.gainer || a.c.loser - b.c.loser || byText(a.id, b.id));
  const best = counts[0]!;
  const any = counts.filter((x) => x.c.gainer > 0).length;
  if (best.c.gainer === 0) {
    return `Top 5 gainers over the last ${times(best.c.nights)}: none of the ${ids.length} measures had one of the day's five biggest gainers among its favourite shares the evening before.`;
  }
  return `Top 5 gainers over the last ${times(best.c.nights)}: the shares ${angleName(best.id)} liked most held one of the day's five biggest gainers on ${times(best.c.gainer)} and one of the five biggest losers on ${times(best.c.loser)} (${any} of the ${ids.length} measures caught at least one).`;
}

/** One probe's evidence line: its candidate picks and its top-5 coverage (D-983, D-986). */
export function probeEvidenceWords(x: {
  readonly name: string;
  readonly picks: CandidateTally | undefined;
  readonly top5: Top5Count | null;
}): string {
  const p = x.picks ?? { finished: 0, madeMoney: 0 };
  let s =
    p.finished === 0
      ? `Candidate picks of ${x.name}: none finished yet.`
      : `Candidate picks of ${x.name}: ${p.finished} finished, ${p.madeMoney} made money.`;
  if (x.top5 !== null && x.top5.nights > 0) {
    s += ` Its favourite shares held one of the day's five biggest gainers on ${times(x.top5.gainer)} of the last ${times(x.top5.nights)} (a top 5 loser on ${times(x.top5.loser)}).`;
  }
  return s;
}
