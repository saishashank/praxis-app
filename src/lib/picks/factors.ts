// AGT-112 nightly read of the factor buckets (descriptive; UXN-121). The buckets themselves are
// computed once per night per family on the development split only and stored in
// `factor_bucket_stat` (the weekly learning run, T12). This module only READS them and assigns
// today's value to a bucket. Nothing here feeds ranking or trading: the lines are shown beside a
// pick and stored with it, nothing more. Deterministic, no LLM, no clock.
import type { Client } from "@libsql/client";
import type { FactorLine } from "./types";

type Db = Pick<Client, "execute">;

export type FactorRow = {
  readonly factor: string;
  readonly bucket: number;
  readonly edges: readonly number[];
  readonly n: number;
  readonly medianNetPpm: number | null;
  readonly familyMedianPpm: number | null;
};

const num = (v: unknown): number => Number(v); // money-float-ok: SQL integer column (n, ppm, bucket)

/** Stored buckets of one (family, rule version, split version). */
export async function readFactorRows(
  db: Db,
  q: { market: string; family: string; ruleVersion: string; splitVersion: number },
): Promise<FactorRow[]> {
  const r = await db.execute({
    sql: `SELECT factor, bucket, edges_json, n, median_net_ppm, family_median_ppm
          FROM factor_bucket_stat
          WHERE market = ? AND family = ? AND rule_version = ? AND split_version = ?
          ORDER BY factor, bucket`,
    args: [q.market, q.family, q.ruleVersion, q.splitVersion],
  });
  return r.rows.map((x) => ({
    factor: String(x.factor),
    bucket: num(x.bucket),
    edges: (JSON.parse(String(x.edges_json)) as unknown[]).map((e) => Number(e)), // money-float-ok: descriptive bucket edges
    n: num(x.n),
    medianNetPpm: x.median_net_ppm === null ? null : num(x.median_net_ppm),
    familyMedianPpm: x.family_median_ppm === null ? null : num(x.family_median_ppm),
  }));
}

/** A stored rule value (`a/b`, a decimal, a flag) as a number; null when it is not numeric. */
export function numericValue(text: string): number | null {
  const m = /^(-?\d+)\/(\d+)$/.exec(text);
  if (m) {
    const den = BigInt(m[2]!);
    if (den === 0n) return null;
    return Number(m[1]) / Number(m[2]); // money-float-ok: descriptive bucket assignment
  }
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  return Number(text); // money-float-ok: descriptive bucket assignment
}

/** Bucket number of a value: 1 + the number of edges below it (edges ascending). */
export function bucketOf(value: number, edges: readonly number[]): number {
  return 1 + edges.filter((e) => value > e).length;
}

/**
 * Today's factor lines of one signal: for every factor with a numeric value today, the bucket the
 * value falls in, that bucket's n and its effect (bucket median minus family median, ppm). A bucket
 * with n below `factor_min_bucket_n` reads "not enough history" (`enough = false`, no effect shown).
 * Sorted by factor name so the result never depends on the order of the input.
 */
export function factorLines(
  today: Readonly<Record<string, string>>,
  rows: readonly FactorRow[],
  minBucketN: number,
): FactorLine[] {
  const byFactor = new Map<string, FactorRow[]>();
  for (const r of rows) byFactor.set(r.factor, [...(byFactor.get(r.factor) ?? []), r]);
  const out: FactorLine[] = [];
  for (const factor of [...byFactor.keys()].sort()) {
    const text = today[factor];
    if (text === undefined) continue;
    const value = numericValue(text);
    if (value === null) continue;
    const list = byFactor.get(factor)!;
    const bucket = bucketOf(value, list[0]!.edges);
    const row = list.find((x) => x.bucket === bucket);
    if (row === undefined) continue;
    const enough = row.n >= minBucketN && row.medianNetPpm !== null && row.familyMedianPpm !== null;
    out.push({
      factor,
      value: text,
      bucket,
      n: row.n,
      effectPpm: enough ? row.medianNetPpm! - row.familyMedianPpm! : null,
      enough,
    });
  }
  return out;
}
