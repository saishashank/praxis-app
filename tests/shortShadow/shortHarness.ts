// Fixture helpers of the shadow short tests (M21 R1). Synthetic AU data only (SEC-110).
import type { Client } from "@libsql/client";

export const MKT = "AU";
export const WHEN = "2030-01-07T08:00:00.000Z";

export async function seedDecision(
  db: Client,
  x: {
    d: string;
    code: string;
    key: readonly number[] | null;
    arm?: "live" | "shadow";
    book?: string;
    fail?: string | null;
    family?: string;
  },
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO cortex_decision (market, d, book_id, code, arm, family, rank_key, gate_trace_json, first_fail_gate, manifest_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, 'm1')`,
    args: [
      MKT,
      x.d,
      x.book ?? "b1",
      x.code,
      x.arm ?? "live",
      x.family ?? "F1",
      x.key === null ? null : JSON.stringify(x.key),
      x.fail ?? null,
    ],
  });
}

export async function seedTier(
  db: Client,
  d: string,
  code: string,
  tier: "U1" | "U2" | "U3",
): Promise<void> {
  await db.execute({
    sql: "INSERT INTO universe_snapshot (market, d, code, status, tier) VALUES (?, ?, ?, 'active', ?)",
    args: [MKT, d, code, tier],
  });
}

export async function seedEvent(
  db: Client,
  d: string,
  code: string,
  polarity: -1 | 0 | 1,
  ann = code,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO event (market, source, ann_id, code, published_at, timed, day0_d, group_key, category, price_sensitive,
            ar_ppm, ar_num, ar_den, polarity, rule_version)
          VALUES (?, 'asx', ?, ?, ?, 0, ?, ?, 'results', 1, -50000, '-1', '20', ?, 'r1')`,
    args: [MKT, `ann-${ann}-${d}`, code, `${d}T00:00:00Z`, d, `g-${ann}-${d}`, polarity],
  });
}

export async function seedBars(
  db: Client,
  code: string,
  bars: readonly { d: string; o: number; h: number; l: number; c: number; v?: number }[],
): Promise<void> {
  for (const b of bars) {
    await db.execute({
      sql: `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'zz', ?, ?)`,
      args: [
        MKT,
        code,
        b.d,
        b.o,
        b.h,
        b.l,
        b.c,
        b.v ?? 1_000_000,
        `${b.d}T07:00:00Z`,
        `${b.d}T07:00:00Z`,
      ],
    });
  }
}

export async function count(db: Client, table: string): Promise<number> {
  return Number((await db.execute(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0]!.n);
}
