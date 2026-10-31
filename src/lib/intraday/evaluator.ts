// M17 WP9 (VAL-118, D-391, D-462..D-467): the evaluator of the intraday stream, the ONLY writer of
// the `intraday_stream_state` setting (through `writeStreamState`). The stream is a lineage in the
// market-level ledger (`cortex_ledger_cell`, kind 'intraday_stream', family 'all') with a
// pre-registered hypothesis: mean 5-session excess return (from the next open, against the market
// total-return index) net of a fixed round-trip cost is greater than 0, with at least 60 candidates
// on at least 60 sessions, and the one-sided 90 % block-bootstrap lower bound above 0 (as CTX-021).
// A pass only lets the Owner approve a family at the next release; it never trades intraday. The
// Owner can only set shadow (`ownerSetShadow`). A null set stays shadow.
import type { Client } from "@libsql/client";
import { getConfig } from "@/lib/config/store";
import { writeStreamState, type StreamState } from "@/lib/config/streamState";
import { getCell, logCell, setCellResult } from "@/lib/cortex/store/ledger";
import { streamCostPpm } from "@/lib/picks/streamCost";
import { bootstrapMean, isUndefined } from "@/lib/stats/stationaryBootstrap";
import { scopedPrng } from "@/lib/stats/rng";

export const MIN_CANDIDATES = 60; // threshold-ok: VAL-118 pre-registered sample
export const MIN_SESSIONS = 60; // threshold-ok: VAL-118 pre-registered sample
const BLOCK = 5; // threshold-ok: the 5-session hold is the block floor

export const HYPOTHESIS_TEXT =
  "Mean 5-session excess return of intraday candidates, from the next open against the market " +
  "total-return index and net of the Cortex round-trip cost per order (fee plus slippage or half-spread, A$1,000 parcel), is greater than 0, on at least 60 " +
  "candidates over at least 60 sessions, with the one-sided 90 % block-bootstrap lower bound above 0.";

export const cellIdOf = (market: string): string => `intraday_stream:${market}:v1`;

export type StreamEvaluation = {
  readonly state: StreamState;
  readonly changed: boolean;
  readonly candidates: number;
  readonly sessions: number;
  readonly meanNetPpm: number | null;
  readonly lowerPpm: number | null;
  readonly sampleMet: boolean;
};

/** Logs the pre-registered hypothesis once (a repeat is a no-op). */
export async function ensureStreamLineage(db: Client, market: string, now: string): Promise<void> {
  if ((await getCell(db, cellIdOf(market))) !== null) return;
  await logCell(db, {
    cellId: cellIdOf(market),
    market,
    family: "all",
    angleId: null,
    kind: "intraday_stream",
    spec: {
      hypothesis: HYPOTHESIS_TEXT,
      minCandidates: MIN_CANDIDATES,
      minSessions: MIN_SESSIONS,
      costRule: "costPerOrder (D-311) at the A$1,000 parcel, per candidate",
      horizon: "excess_open_5_ppm",
    },
    loggedAt: now,
    split: "validation",
    lineageId: `intraday_stream:${market}`,
  });
}

export async function evaluateIntradayStream(
  db: Client,
  market: string,
  now: string,
): Promise<StreamEvaluation> {
  await ensureStreamLineage(db, market, now);
  const rows = (
    await db.execute({
      sql: `SELECT session_d, code, excess_open_5_ppm AS x FROM intraday_candidate
            WHERE market = ? AND excess_open_5_ppm IS NOT NULL ORDER BY session_d, code`,
      args: [market],
    })
  ).rows;
  const dates = [...new Set(rows.map((r) => String(r.session_d)))];
  const net: number[] = [];
  for (const r of rows) {
    const px = (
      await db.execute({
        sql: "SELECT c FROM price_bar WHERE market = ? AND code = ? AND d < ? ORDER BY d DESC LIMIT 1",
        args: [market, String(r.code), String(r.session_d)],
      })
    ).rows[0];
    const cost = await streamCostPpm(
      db,
      market,
      String(r.code),
      String(r.session_d),
      Number(px?.c ?? 1),
    );
    net.push(Number(r.x) - cost);
  }
  const sampleMet = rows.length >= MIN_CANDIDATES && dates.length >= MIN_SESSIONS;
  let meanNetPpm: number | null = null;
  let lowerPpm: number | null = null;
  if (rows.length > 0) {
    meanNetPpm = net.reduce((a, b) => a + b, 0) / net.length;
    if (sampleMet) {
      const ix = new Map(dates.map((x, i) => [x, i]));
      const b = bootstrapMean(
        {
          sessions: rows.map((r) => ix.get(String(r.session_d))!),
          sessionCount: dates.length,
          codes: rows.map((r) => String(r.code)),
        },
        net,
        scopedPrng(`boot:${cellIdOf(market)}`),
        { expectedBlock: BLOCK, maxHold: BLOCK },
      );
      lowerPpm = isUndefined(b) ? null : b.oneSidedLo;
    }
  }
  const pass = sampleMet && lowerPpm !== null && lowerPpm > 0;
  const current = (await getConfig(db, "intraday_stream_state")) as StreamState;
  // live-tested is an Owner step after a release; the evaluator moves only shadow <-> allowed.
  const target: StreamState = current === "live-tested" ? current : pass ? "allowed" : "shadow";
  const changed = await writeStreamState(db, {
    state: target,
    userId: null,
    reason: `VAL-118: ${rows.length} candidates, ${dates.length} sessions, lower bound ${
      lowerPpm === null ? "n/a" : Math.round(lowerPpm)
    } ppm`,
    now,
  });
  if (sampleMet) {
    const cell = await getCell(db, cellIdOf(market));
    if (cell !== null && cell.resultAt === null && now > cell.loggedAt) {
      await setCellResult(db, cellIdOf(market), now, {
        passed: pass,
        candidates: rows.length,
        sessions: dates.length,
        meanNetPpm,
        lowerPpm,
      });
    }
  }
  return {
    state: target,
    changed,
    candidates: rows.length,
    sessions: dates.length,
    meanNetPpm,
    lowerPpm,
    sampleMet,
  };
}

/** The Owner may only set shadow (D-391); there is no way through here to `allowed`. */
export async function ownerSetShadow(db: Client, userId: number, now: string): Promise<boolean> {
  return writeStreamState(db, { state: "shadow", userId, reason: "Owner set shadow", now });
}
