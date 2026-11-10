// D-921: what the daily learning loop (src/lib/learning/daily.ts) may not read itself because picks are
// kept apart from the learning folder (tests/picks/isolation.test.ts): which shares were published as
// picks the evening before, which sessions had a published pick, and how close the shortlist rule came.
// Read-only; the picks entry (cli.ts) hands these in.
import type { Client } from "@libsql/client";
import type { PickHooks } from "@/lib/learning/daily";
import { SHORTLIST_RULE, shortlistNotes, type ShortlistCode } from "./shortlist";
import type { Tier } from "./types";

const marks = (xs: readonly unknown[]): string => xs.map(() => "?").join(", ");
const cap = (s: string): string => (s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1));
const PPM = 1_000_000; // threshold-ok: parts per million
const toMicro = (x: number): bigint => BigInt(Math.round(x * PPM)); // money-float-ok: indicator bars for the near-miss note only

export const pickHooks: PickHooks = {
  async pickedBefore(db: Client, market, prev, codes) {
    const out = new Map<string, string>();
    if (codes.length === 0) return out;
    const r = await db.execute({
      sql: `SELECT code, profile, rank, rule_version FROM pick
            WHERE market = ? AND d = ? AND code IN (${marks(codes)}) ORDER BY profile, rank`,
      args: [market, prev, ...codes],
    });
    for (const x of r.rows) {
      const code = String(x.code);
      if (out.has(code)) continue; // the first profile and rank
      const where = `${cap(String(x.profile))} #${String(x.rank)}`;
      out.set(
        code,
        String(x.rule_version) === SHORTLIST_RULE
          ? `Picked from the shortlist (${where})`
          : `Picked (${where})`,
      );
    }
    return out;
  },
  async publishedDays(db: Client, market, days) {
    if (days.length === 0) return new Set<string>();
    const r = await db.execute({
      sql: `SELECT DISTINCT d FROM pick WHERE market = ? AND d IN (${marks(days)})`,
      args: [market, ...days],
    });
    return new Set(r.rows.map((x) => String(x.d)));
  },
  shortlistNotes(shares, prev, codes) {
    const input: ShortlistCode[] = shares.map((s) => ({
      code: s.code,
      tier: s.tier as Tier,
      bars: s.bars
        .filter((b) => b.d <= prev)
        .map((b) => ({
          d: b.d,
          openMicro: toMicro(b.o),
          highMicro: toMicro(b.h),
          lowMicro: toMicro(b.l),
          closeMicro: toMicro(b.c),
          volume: b.v,
        })),
    }));
    return shortlistNotes(input, prev, codes);
  },
};
