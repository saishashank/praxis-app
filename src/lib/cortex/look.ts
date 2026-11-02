// The quarterly live look at each family's status (V2-S1, D-700…D-702; CTX-053, CTX-082, D-380).
// Before this file `recordFamilyStatus` had no caller: live shadow sessions piled up in
// cortex_decision / cortex_outcome and fed no decision. The look runs from the nightly review (batch 3,
// after the would-have scoring) and is the in-app half of the re-evaluation:
//
//  - ONE look per family per quarter, logged as a ledger cell (kind `status_look`) BEFORE its result
//    (CTX-031), so it counts in the luck figure (D-277/D-358) and a repeat of the night is a no-op.
//    The look covers the PREVIOUS quarter (data up to its last day) and runs from the first night after.
//  - Evidence = the filled would-have outcomes of the family's decisions (shadow and live arm) up to the
//    quarter end. The private development out-of-fold samples are not in the database (D-267), so the
//    look judges the LIVE sample alone against the same CTX-053 rules (statusRules.mjs: own n_eff >=
//    cortex_min_neff_trade, Brier-skill lower bound > 0, the CTX-021 gate on the pooled top-3 cell with
//    regime stability). That is stricter than the pooled test the spec allows, never looser, so a family
//    can only leave shadow here when live evidence alone carries it; the Owner-run import stays the way to
//    pool development data.
//  - The pooled top-3 cell is cut on the FROZEN development threshold (`top3_min_s` of the family's map,
//    never re-ranked live) and its regimes come from the G09 gate trace of each decision. A family with no
//    map threshold has no cell (the rules then fail it at the economic gate); fewer than `cellMinSetups`
//    filled cases is recorded as inconclusive and writes no status row.
//  - Never a promotion without the gates: `recordFamilyStatus` is the only writer of `allowed`, F7 is
//    refused by the rules, an Owner kill (`suspended`) is left alone, and a family already `allowed` by
//    the import is demoted only on a conclusive live failure (own live n_eff at the trade floor), not for a
//    live sample too thin to test it (that look is recorded, nothing else changes).
//  - n_eff_live (the live effective sample) is recorded with every look in the ledger result, which is
//    the counter the page projections read.
import { cellStatistic, TOP3_BAND_KEY, type CellSetup } from "@/lib/stats/cells";
import { scopedPrng } from "@/lib/stats/rng";
import {
  CORTEX_FAMILIES,
  currentMap,
  familyStatusMap,
  getCell,
  logCell,
  parseJson,
  setCellResult,
  str,
  type BatchExec,
  type CortexFamily,
} from "./store";
import {
  DEFAULT_MIN_NEFF_TRADE,
  evaluateFamily,
  recordFamilyStatus,
  type RecordResult,
} from "./status";
import { GATE_DEFAULTS } from "./statusRules.mjs";

export const LOOK_KIND = "status_look";
const DAY_MS = 86_400_000; // threshold-ok: ms per day

/** `2026Q3` style quarter label of a session date. */
export function quarterOf(d: string): string {
  return `${d.slice(0, 4)}Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}`;
}

/** First and last session date of a quarter label. */
export function quarterBounds(q: string): { from: string; to: string } {
  const y = Number(q.slice(0, 4));
  const m0 = (Number(q.slice(5)) - 1) * 3;
  const from = new Date(Date.UTC(y, m0, 1));
  const to = new Date(Date.UTC(y, m0 + 3, 1) - DAY_MS);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

/** The quarter before the one `d` is in. */
export function previousQuarter(d: string): string {
  const { from } = quarterBounds(quarterOf(d));
  return quarterOf(new Date(Date.parse(`${from}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10));
}

export const lookCellId = (market: string, family: CortexFamily, q: string): string =>
  `look:${market}:${family}:${q}`;

type LiveRow = {
  d: string;
  code: string;
  s: number | null;
  p: number | null;
  qty: number;
  fillMicro: number;
  netMicro: number;
  regime: string;
};

const regimeOfTrace = (traceJson: unknown): string => {
  try {
    const t = parseJson<{ gateId?: string; value?: string }[]>(traceJson);
    const g = t.find((x) => x.gateId === "G09_regime");
    return g?.value === undefined ? "unknown" : (g.value.split(":")[0] ?? "unknown");
  } catch {
    return "unknown";
  }
};

/** Filled would-have outcomes of one family up to `to`, oldest first. */
export async function liveRows(
  db: BatchExec,
  market: string,
  family: CortexFamily,
  to: string,
): Promise<LiveRow[]> {
  const r = await db.execute({
    sql: `SELECT c.d, c.code, c.s, c.p, c.qty, c.gate_trace_json, o.fill_micro, o.net_micro
          FROM cortex_decision c
          JOIN cortex_outcome o ON o.market = c.market AND o.d = c.d AND o.book_id = c.book_id
            AND o.code = c.code AND o.arm = c.arm
          WHERE c.market = ? AND c.family = ? AND c.d <= ? AND o.fill_status = 'filled'
            AND o.net_micro IS NOT NULL AND o.fill_micro > 0 AND c.qty > 0
          ORDER BY c.d, c.book_id, c.code, c.arm`,
    args: [market, family, to],
  });
  return r.rows.map((x) => ({
    d: str(x.d),
    code: str(x.code),
    s: x.s === null ? null : Number(x.s),
    p: x.p === null ? null : Number(x.p),
    qty: Number(x.qty),
    fillMicro: Number(x.fill_micro),
    netMicro: Number(x.net_micro),
    regime: regimeOfTrace(x.gate_trace_json),
  }));
}

export type LookResult = {
  family: CortexFamily;
  quarter: string;
  /** "skipped": already looked at / nothing to look at; "inconclusive": too little live evidence. */
  outcome: "skipped" | "inconclusive" | "evaluated";
  nFilled: number;
  nEffLive: number | null;
  record: RecordResult | null;
  failed: readonly string[];
};

/** One family, one quarter. `now` stamps the ledger cell and the status row only. */
export async function lookAtFamily(
  db: BatchExec,
  a: { market: string; family: CortexFamily; quarter: string; d: string; now: string },
): Promise<LookResult> {
  const base = { family: a.family, quarter: a.quarter };
  const none = (outcome: LookResult["outcome"], nFilled: number, failed: string[]): LookResult => ({
    ...base,
    outcome,
    nFilled,
    nEffLive: null,
    record: null,
    failed,
  });
  const cellId = lookCellId(a.market, a.family, a.quarter);
  if ((await getCell(db, cellId)) !== null) return none("skipped", 0, []);
  const { to } = quarterBounds(a.quarter);
  const rows = await liveRows(db, a.market, a.family, to);
  // nothing to look at yet: no cell is charged, the next night asks again
  if (rows.length === 0) return none("skipped", 0, []);

  const map = await currentMap(db, a.market, a.family);
  const top3 =
    map === null ? undefined : (map.params as unknown as Record<string, unknown>).top3_min_s;
  await logCell(db, {
    cellId,
    market: a.market,
    family: a.family,
    angleId: null,
    kind: LOOK_KIND,
    spec: {
      quarter: a.quarter,
      to,
      rule: "CTX-053",
      evidence: "live",
      top3_min_s: typeof top3 === "number" ? top3 : null,
    },
    loggedAt: a.now,
    split: "validation",
    lineageId: null,
  });
  const resultAt = new Date(Date.parse(a.now) + 1).toISOString(); // CHECK: logged_at < result_at

  const minSetups = GATE_DEFAULTS.cellMinSetups;
  if (rows.length < minSetups) {
    await setCellResult(db, cellId, resultAt, {
      outcome: "inconclusive",
      n_filled: rows.length,
      min_setups: minSetups,
    });
    return none("inconclusive", rows.length, ["live_sample_too_small"]);
  }

  const dates = [...new Set(rows.map((r) => r.d))].sort();
  const sessionOf = new Map(dates.map((d, i) => [d, i] as const));
  const prng = scopedPrng(`status_look:${a.market}:${a.family}:${a.quarter}`);
  const calibrated = rows.filter((r) => r.p !== null);
  const setups: CellSetup[] =
    typeof top3 === "number"
      ? rows
          .filter((r) => r.s !== null && r.s >= top3)
          .map((r) => ({
            family: a.family,
            code: r.code,
            session: sessionOf.get(r.d)!,
            band: 10,
            volBucket: "all",
            liqTier: "all",
            regime: r.regime,
            netMicro: BigInt(r.netMicro),
            notionalMicro: BigInt(r.fillMicro) * BigInt(r.qty),
            filled: true,
            adverseGap: 0,
          }))
      : [];
  const cell =
    setups.length === 0
      ? null
      : cellStatistic(`${a.family}|${TOP3_BAND_KEY}|all|all`, setups, prng, {
          sessionCount: dates.length,
        });
  const decision = evaluateFamily({
    family: a.family,
    p: calibrated.map((r) => r.p as number),
    y: calibrated.map((r) => (r.netMicro > 0 ? 1 : 0) as 0 | 1),
    layout: {
      sessions: calibrated.map((r) => sessionOf.get(r.d)!),
      sessionCount: dates.length,
      codes: calibrated.map((r) => r.code),
    },
    cell,
    prng,
  });
  const nEffLive = typeof decision.evidence.n_eff === "number" ? decision.evidence.n_eff : null;

  const current = (await familyStatusMap(db, a.market, a.d))[a.family];
  // a live look can only be conclusive once its own n_eff reaches the trade floor (CTX-053)
  const conclusive = nEffLive !== null && nEffLive >= DEFAULT_MIN_NEFF_TRADE;
  let record: RecordResult | null = null;
  // an `allowed` family is not demoted by a live sample that is merely too thin to test it
  if (!(current === "allowed" && !decision.allowed && !conclusive)) {
    record = await recordFamilyStatus(db, {
      market: a.market,
      family: a.family,
      sinceD: a.d, // the night of the look, so a replay of an earlier night never sees it
      decision: {
        ...decision,
        evidence: {
          ...decision.evidence,
          source: "live_look",
          quarter: a.quarter,
          n_filled: rows.length,
          n_eff_live: nEffLive,
        },
      },
      createdAt: a.now,
      nEffLivePerSession: nEffLive === null ? null : nEffLive / dates.length,
    });
  }
  await setCellResult(db, cellId, resultAt, {
    outcome: "evaluated",
    status: decision.status,
    failed: decision.failed,
    n_filled: rows.length,
    n_eff_live: nEffLive,
    wrote: record?.written ?? false,
  });
  return {
    ...base,
    outcome: "evaluated",
    nFilled: rows.length,
    nEffLive,
    record,
    failed: decision.failed,
  };
}

/** The nightly entry: families F1..F6 for the quarter just ended (F7 is never allowed, CTX-054). */
export async function runStatusLooks(
  db: BatchExec,
  a: { market: string; d: string; now: string },
): Promise<LookResult[]> {
  const quarter = previousQuarter(a.d);
  const out: LookResult[] = [];
  for (const family of CORTEX_FAMILIES) {
    if (family === "F7") continue;
    out.push(await lookAtFamily(db, { market: a.market, family, quarter, d: a.d, now: a.now }));
  }
  return out;
}
