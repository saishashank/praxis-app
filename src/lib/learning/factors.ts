// AGT-112 factor buckets in the weekly learning run (M6 T12; D-110 #37, D-122). For every (family, rule
// version, split version) the DEVELOPMENT rows' numeric rule values (the same `rule: value` pairs a
// signal stores) are cut into terciles or quintiles (`factor_buckets`); each bucket stores its edges, n
// and the median net outcome in ppm, beside the median of the whole family/version. Descriptive only:
// nothing reads these to rank or trade (the nightly reader is src/lib/picks/factors.ts, which shows
// "not enough history" below `factor_min_bucket_n`). Pure computation plus one idempotent writer; a
// stored row that differs from the recomputed one raises (ARN-102). No clock, no randomness.
import type { Client } from "@libsql/client";
import type { AgentParams } from "@/lib/agents/params";
import { numericValue } from "@/lib/picks/factors";

export type FactorObs = {
  readonly family: string;
  readonly ruleVersion: string;
  readonly splitVersion: number;
  /** Net outcome of the closed development row, ppm (an integer). */
  readonly netPpm: number;
  /** Rule id -> stored value text. */
  readonly values: Readonly<Record<string, string>>;
};

export type FactorBucketRow = {
  readonly market: string;
  readonly family: string;
  readonly rule_version: string;
  readonly split_version: number;
  readonly factor: string;
  readonly bucket: number;
  readonly edges_json: string;
  readonly n: number;
  readonly median_net_ppm: number | null;
  readonly family_median_ppm: number | null;
};

const BUCKET_COUNT = { terciles: 3, quintiles: 5 } as const; // threshold-ok: the two factor_buckets choices

/** Integer median (floor of the mean of the two middle values for an even count); null when empty. */
export function medianPpm(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1; // threshold-ok: index of the middle element
  return s.length % 2 === 1 ? s[mid]! : Math.floor((s[mid - 1]! + s[mid]!) / 2); // threshold-ok: parity of the count
}

/** Edge k of m: the k/m quantile (the value at rank ceil(k n / m)), ascending. */
export function bucketEdges(values: readonly number[], m: number): number[] {
  const s = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (let k = 1; k < m; k += 1) out.push(s[Math.max(0, Math.ceil((k * s.length) / m) - 1)]!);
  return out;
}

const bucketOf = (v: number, edges: readonly number[]): number =>
  1 + edges.filter((e) => v > e).length;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The bucket rows of every (family, rule version, split version) in the input, sorted by key. A factor
 * is bucketed only when at least one value per bucket exists; every bucket row is written (n may be 0).
 */
export function computeFactorBuckets(
  market: string,
  obs: readonly FactorObs[],
  params: AgentParams,
): FactorBucketRow[] {
  const m = BUCKET_COUNT[params.picks.factorBuckets];
  const groups = new Map<string, FactorObs[]>();
  for (const o of obs) {
    const k = `${o.family}\u0000${o.ruleVersion}\u0000${String(o.splitVersion).padStart(8, "0")}`;
    groups.set(k, [...(groups.get(k) ?? []), o]);
  }
  const out: FactorBucketRow[] = [];
  for (const k of [...groups.keys()].sort()) {
    const rows = groups.get(k)!;
    const first = rows[0]!;
    const familyMedian = medianPpm(rows.map((r) => r.netPpm));
    const factors = [...new Set(rows.flatMap((r) => Object.keys(r.values)))].sort(cmp);
    for (const factor of factors) {
      const pts = rows.flatMap((r) => {
        const text = r.values[factor];
        const v = text === undefined ? null : numericValue(text);
        return v === null ? [] : [{ v, net: r.netPpm }];
      });
      if (pts.length < m) continue;
      const edges = bucketEdges(
        pts.map((p) => p.v),
        m,
      );
      for (let b = 1; b <= m; b += 1) {
        const inB = pts.filter((p) => bucketOf(p.v, edges) === b);
        out.push({
          market,
          family: first.family,
          rule_version: first.ruleVersion,
          split_version: first.splitVersion,
          factor,
          bucket: b,
          edges_json: JSON.stringify(edges),
          n: inB.length,
          median_net_ppm: medianPpm(inB.map((p) => p.net)),
          family_median_ppm: familyMedian,
        });
      }
    }
  }
  return out;
}

export type FactorWrite = { readonly written: number; readonly unchanged: number };

/** Insert the rows once; an existing row with different content raises (ARN-102). */
export async function writeFactorBuckets(
  db: Client,
  rows: readonly FactorBucketRow[],
): Promise<FactorWrite> {
  let written = 0;
  let unchanged = 0;
  const stmts = [];
  for (const r of rows) {
    const cur = await db.execute({
      sql: `SELECT edges_json, n, median_net_ppm, family_median_ppm FROM factor_bucket_stat
            WHERE market = ? AND family = ? AND rule_version = ? AND split_version = ?
              AND factor = ? AND bucket = ?`,
      args: [r.market, r.family, r.rule_version, r.split_version, r.factor, r.bucket],
    });
    if (cur.rows.length > 0) {
      const c = cur.rows[0]!;
      const same =
        String(c.edges_json) === r.edges_json &&
        Number(c.n) === r.n &&
        (c.median_net_ppm === null ? null : Number(c.median_net_ppm)) === r.median_net_ppm &&
        (c.family_median_ppm === null ? null : Number(c.family_median_ppm)) === r.family_median_ppm;
      if (!same) {
        throw new Error(
          `factor_bucket_stat ${r.family}/${r.rule_version}/v${r.split_version}/${r.factor}/${r.bucket}: stored row differs (ARN-102)`,
        );
      }
      unchanged += 1;
      continue;
    }
    written += 1;
    stmts.push({
      sql: `INSERT INTO factor_bucket_stat (market, family, rule_version, split_version, factor, bucket,
              edges_json, n, median_net_ppm, family_median_ppm) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT DO NOTHING`,
      args: [
        r.market,
        r.family,
        r.rule_version,
        r.split_version,
        r.factor,
        r.bucket,
        r.edges_json,
        r.n,
        r.median_net_ppm,
        r.family_median_ppm,
      ],
    });
  }
  if (stmts.length > 0) await db.batch(stmts, "write");
  return { written, unchanged };
}
