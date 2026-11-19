// A synthetic ZZ fixture for the sector series (M23 S1): 3 groups, 5 sessions, hand-computed returns and levels.
// Shared by tests/research/sectorSeries.test.ts and tests/acceptance/v3/at75Series.test.ts. No real company (SEC-110).
import type { Client } from "@libsql/client";
import { writeSectorIndex } from "@/lib/research/steps/sectorIndex";

export const SESSIONS = [
  "2030-01-02",
  "2030-01-03",
  "2030-01-04",
  "2030-01-07",
  "2030-01-08",
] as const;
export const GROUP_OF: Record<string, string> = {
  ZZA1: "GA",
  ZZA2: "GA",
  ZZB1: "GB",
  ZZB2: "GB",
  ZZB3: "GB",
  ZZC1: "GC",
};
export const CLASS_AS_OF = "2029-12-31";
/** Closes per session, in the order of SESSIONS. */
export const CLOSES: Record<string, number[]> = {
  ZZA1: [100, 110, 110, 121, 108.9],
  ZZA2: [200, 190, 190, 209, 209],
  ZZB1: [100, 110, 110, 242, 242],
  ZZB2: [100, 100, 100, 110, 110],
  ZZB3: [100, 100, 100, 100, 110],
  ZZC1: [50, 55, 33, 33, 36.3],
};

/**
 * Hand-computed (equal-weight mean of member returns in ppm, rounded half away from zero; level chained from 1,000,000):
 *  s1 GA (+100000, -50000) -> 25000, level 1,025,000      GB (+100000, 0, 0) -> 33333, level 1,033,333
 *     GC (+100000) -> 100000, level 1,100,000
 *  s2 GA (0, 0) -> 0, 1,025,000                           GB (0, 0, 0) -> 0, 1,033,333
 *     GC (33/55 - 1 = -400000) -> -400000, 660,000
 *  s3 GA (+100000, +100000) -> 100000, 1,127,500
 *     GB: ZZB1 doubled (+1,000,000, above 60 %, left out), ZZB2 +100000, ZZB3 0 -> 50000 over 2, 1,033,333 x 1.05 = 1,084,999.65 -> 1,085,000
 *     GC 0, 660,000
 *  s4 GA (-100000, 0) -> -50000, 1,127,500 x 0.95 = 1,071,125
 *     GB (0, 0, +100000) -> 33333, 1,085,000 x 1.033333 = 1,121,166.305 -> 1,121,166
 *     GC (+100000) -> 100000, 726,000
 */
export const EXPECTED: {
  d: string;
  group: string;
  retPpm: number;
  levelPpm: number;
  n: number;
}[] = [
  { d: SESSIONS[1], group: "GA", retPpm: 25000, levelPpm: 1025000, n: 2 },
  { d: SESSIONS[1], group: "GB", retPpm: 33333, levelPpm: 1033333, n: 3 },
  { d: SESSIONS[1], group: "GC", retPpm: 100000, levelPpm: 1100000, n: 1 },
  { d: SESSIONS[2], group: "GA", retPpm: 0, levelPpm: 1025000, n: 2 },
  { d: SESSIONS[2], group: "GB", retPpm: 0, levelPpm: 1033333, n: 3 },
  { d: SESSIONS[2], group: "GC", retPpm: -400000, levelPpm: 660000, n: 1 },
  { d: SESSIONS[3], group: "GA", retPpm: 100000, levelPpm: 1127500, n: 2 },
  { d: SESSIONS[3], group: "GB", retPpm: 50000, levelPpm: 1085000, n: 2 },
  { d: SESSIONS[3], group: "GC", retPpm: 0, levelPpm: 660000, n: 1 },
  { d: SESSIONS[4], group: "GA", retPpm: -50000, levelPpm: 1071125, n: 2 },
  { d: SESSIONS[4], group: "GB", retPpm: 33333, levelPpm: 1121166, n: 3 },
  { d: SESSIONS[4], group: "GC", retPpm: 100000, levelPpm: 726000, n: 1 },
];

/** Enables the fixture market (the guard triggers refuse rows of a market that is not enabled). */
export async function enableZz(db: Client): Promise<void> {
  await db.execute(
    `INSERT INTO market (code, tz, open_time, close_time, cutoff_time, currency, mode, enabled)
     VALUES ('ZZ', 'UTC', '10:00', '16:00', '16:10', 'XXX', 'off', 1)`,
  );
}

/** Plants the bars, the U1 universe of every session and the classification of the fixture. */
export async function plantZz(db: Client, upTo: number = SESSIONS.length): Promise<void> {
  const ts = "2030-01-01T00:00:00Z";
  for (let i = 0; i < upTo; i++) {
    for (const [code, closes] of Object.entries(CLOSES)) {
      const c = closes[i]!;
      await db.execute({
        sql: `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
              VALUES ('ZZ', ?, ?, ?, ?, ?, ?, 1000, 'test', ?, ?)`,
        args: [code, SESSIONS[i]!, c, c, c, c, ts, ts],
      });
      await db.execute({
        sql: `INSERT INTO universe_snapshot (market, d, code, status, tier, halted)
              VALUES ('ZZ', ?, ?, 'active', 'U1', 0)`,
        args: [SESSIONS[i]!, code],
      });
    }
  }
  for (const [code, industry] of Object.entries(GROUP_OF)) {
    await db.execute({
      sql: `INSERT INTO instrument_class (market, code, industry, source, as_of, loaded_at)
            VALUES ('ZZ', ?, ?, 'test', ?, ?)`,
      args: [code, industry, CLASS_AS_OF, ts],
    });
  }
}

/** One night of the step for the fixture market on session `d`. */
export async function writeSectorIndexFor(db: Client, d: string): Promise<{ written: number }> {
  return writeSectorIndex(db, { market: "ZZ", d, now: `${d}T10:00:00Z` });
}
