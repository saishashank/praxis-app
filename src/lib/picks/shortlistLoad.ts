// D-920 database step of the nightly shortlist: the night's liquid universe (U1/U2, active, not halted)
// and their bars over the evidence window, read in batches of codes (no OFFSET, D-903), then the pure
// rule of ./shortlist.ts. About 450 codes x 330 sessions a night (~150k rows), inside the read budget
// (D-904). The bars stop at D, so nothing after the decision is read.
import { getCostProfile } from "@/lib/arena/costs";
import { priceMicro } from "@/lib/arena/marketData";
import { addDays } from "@/lib/data/calendar";
import { divFloor } from "@/lib/money/rational";
import { shortlistInputs, type DayBar, type ShortlistCode } from "./shortlist";
import type { PickInput, Tier } from "./types";

type Db = {
  execute: (q: {
    sql: string;
    args: (string | number)[];
  }) => Promise<{ rows: Record<string, unknown>[] }>;
};

const WINDOW_DAYS = 480; // threshold-ok: calendar days of bars: 200-session average + about a year of evidence
const CHUNK = 200; // threshold-ok: codes per batched read
const ADV_N = 20; // threshold-ok: sessions of the traded-value average (slippage)
const TIERS: readonly Tier[] = ["U1", "U2"];

export async function loadShortlistInputs(
  db: Db,
  o: { market: string; d: string; exclude: ReadonlySet<string>; costProfile?: string },
): Promise<PickInput[]> {
  const uni = await db.execute({
    sql: `SELECT code, tier FROM universe_snapshot
          WHERE market = ? AND halted = 0 AND status = 'active' AND tier IN ('U1', 'U2')
            AND d = (SELECT MAX(d) FROM universe_snapshot WHERE market = ? AND d <= ?)
          ORDER BY code`,
    args: [o.market, o.market, o.d],
  });
  const tierOf = new Map(uni.rows.map((r) => [String(r.code), String(r.tier) as Tier]));
  const codes = [...tierOf.keys()].filter((c) => TIERS.includes(tierOf.get(c)!));
  if (codes.length === 0) return [];
  const from = addDays(o.d, -WINDOW_DAYS);
  const bars = new Map<string, DayBar[]>();
  for (let i = 0; i < codes.length; i += CHUNK) {
    const part = codes.slice(i, i + CHUNK);
    const r = await db.execute({
      sql: `SELECT code, d, o, h, l, c, volume FROM price_bar
            WHERE market = ? AND code IN (${part.map(() => "?").join(", ")}) AND d >= ? AND d <= ?
            ORDER BY code, d`,
      args: [o.market, ...part, from, o.d],
    });
    for (const x of r.rows) {
      const b: DayBar = {
        d: String(x.d),
        openMicro: priceMicro(x.o),
        highMicro: priceMicro(x.h),
        lowMicro: priceMicro(x.l),
        closeMicro: priceMicro(x.c),
        volume: Number(x.volume), // money-float-ok: share count
      };
      const ok =
        b.openMicro > 0n &&
        b.lowMicro > 0n &&
        b.lowMicro <= b.openMicro &&
        b.lowMicro <= b.closeMicro &&
        b.highMicro >= b.openMicro &&
        b.highMicro >= b.closeMicro;
      if (!ok) continue; // a malformed bar is unusable evidence (as the pick tracking)
      const k = String(x.code);
      if (!bars.has(k)) bars.set(k, []);
      bars.get(k)!.push(b);
    }
  }
  const advMicro = new Map<string, bigint>();
  const input: ShortlistCode[] = [];
  for (const code of codes) {
    const list = bars.get(code) ?? [];
    if (list.length === 0) continue;
    const last = list.slice(-ADV_N);
    let v = 0n;
    for (const b of last) v += b.closeMicro * BigInt(Math.round(b.volume)); // money-float-ok: whole shares
    advMicro.set(code, divFloor(v, BigInt(last.length)));
    input.push({ code, tier: tierOf.get(code)!, bars: list });
  }
  return shortlistInputs(input, {
    d: o.d,
    market: o.market,
    costProfile: getCostProfile(o.costProfile ?? "P5"),
    advMicro,
    exclude: o.exclude,
  });
}
