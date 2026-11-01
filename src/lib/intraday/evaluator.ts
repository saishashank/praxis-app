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
import {
  cellsOfKind,
  getCell,
  logCell,
  setCellResult,
  type LedgerCellRow,
} from "@/lib/cortex/store/ledger";
import { streamCostPpm } from "@/lib/picks/streamCost";
import { bootstrapMean, isUndefined } from "@/lib/stats/stationaryBootstrap";
import { scopedPrng } from "@/lib/stats/rng";

export const MIN_CANDIDATES = 60; // threshold-ok: VAL-118 pre-registered sample
export const MIN_SESSIONS = 60; // threshold-ok: VAL-118 pre-registered sample
const BLOCK = 5; // threshold-ok: the 5-session hold is the block floor

// R2-S3 (D-806): the text now states the SELECTION rule, finalised before the first production look
// (no sample existed; D-670's one look per cell is unaffected, so the cell stays `v1`).
export const HYPOTHESIS_TEXT =
  "Candidates are intraday-flagged stocks with a catalyst of materiality 2 or more, relative volume at or above the set minimum and a fresh quote, " +
  "whose move from the previous close is at least the larger of intraday_move_min_pct and 1.5 times the 60-session standard deviation; " +
  "the move is the sector-adjusted move (the move less the previous session's equal-weight composite return of the stock's industry, " +
  "when that industry has at least 5 members and the composite points the same way as the move), else the raw move (D-750). " +
  "Mean 5-session excess return of those candidates, from the next open against the market " +
  "total-return index and net of the Cortex round-trip cost per order (fee plus slippage or half-spread, A$1,000 parcel), is greater than 0, on at least 60 " +
  "candidates over at least 60 sessions, with the one-sided 90 % block-bootstrap lower bound above 0.";

export const cellIdOf = (market: string): string => `intraday_stream:${market}:v1`;

/** Calendar quarter of an ISO instant, e.g. "2031Q1" (UTC date part). */
export const quarterOf = (iso: string): string =>
  `${iso.slice(0, 4)}Q${Math.floor((Number(iso.slice(5, 7)) - 1) / 3) + 1}`;

/** The cell of a later look: one per quarter, after a failed look (D-670, O-43). */
export const quarterCellIdOf = (market: string, iso: string): string =>
  `${cellIdOf(market)}:${quarterOf(iso)}`;

/** The newest cell of the stream lineage: the one whose single look decides the state. */
export async function activeStreamCell(db: Client, market: string): Promise<LedgerCellRow | null> {
  const cells = await cellsOfKind(db, market, "all", "intraday_stream");
  return cells.length === 0 ? null : cells[cells.length - 1]!;
}

export type StreamEvaluation = {
  readonly state: StreamState;
  readonly changed: boolean;
  readonly candidates: number;
  readonly sessions: number;
  readonly meanNetPpm: number | null;
  readonly lowerPpm: number | null;
  readonly sampleMet: boolean;
  /** The cell whose look binds the state, and whether THIS call recorded that look. */
  readonly cellId: string;
  readonly lookRecorded: boolean;
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

/**
 * D-670: the cell that carries the next single look. The first cell is `v1`; a new charged cell
 * (`v1:<quarter>`, its own pre-registered hypothesis row) is logged only when the latest cell's
 * look FAILED and a later calendar quarter has begun. A passed or still-open cell never gets a
 * successor, and at most one cell is logged per quarter (the id carries the quarter).
 */
async function cellForThisLook(db: Client, market: string, now: string): Promise<LedgerCellRow> {
  await ensureStreamLineage(db, market, now);
  const latest = (await activeStreamCell(db, market))!;
  const failed =
    latest.resultAt !== null && (latest.result as { passed?: boolean }).passed !== true;
  if (failed && quarterOf(now) > quarterOf(latest.loggedAt)) {
    const id = quarterCellIdOf(market, now);
    if ((await getCell(db, id)) === null) {
      await logCell(db, {
        cellId: id,
        market,
        family: "all",
        angleId: null,
        kind: "intraday_stream",
        spec: {
          ...(latest.spec as object),
          priorCell: latest.cellId,
          sampleFrom: now.slice(0, 10),
        },
        loggedAt: now,
        split: "validation",
        lineageId: `intraday_stream:${market}:${quarterOf(now)}`,
      });
    }
    return (await getCell(db, id))!;
  }
  return latest;
}

export async function evaluateIntradayStream(
  db: Client,
  market: string,
  now: string,
): Promise<StreamEvaluation> {
  const cell = await cellForThisLook(db, market, now);
  // A later cell is a fresh trial: only sessions from its log date on count (no re-test of the data
  // that already failed). The first cell (v1) sees all candidates, as before.
  const sampleFrom = (cell.spec as { sampleFrom?: string }).sampleFrom ?? "";
  const rows = (
    await db.execute({
      sql: `SELECT session_d, code, excess_open_5_ppm AS x FROM intraday_candidate
            WHERE market = ? AND excess_open_5_ppm IS NOT NULL AND session_d >= ?
            ORDER BY session_d, code`,
      args: [market, sampleFrom],
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
        scopedPrng(`boot:${cell.cellId}`),
        { expectedBlock: BLOCK, maxHold: BLOCK },
      );
      lowerPpm = isUndefined(b) ? null : b.oneSidedLo;
    }
  }
  const pass = sampleMet && lowerPpm !== null && lowerPpm > 0;
  const result = {
    passed: pass,
    candidates: rows.length,
    sessions: dates.length,
    meanNetPpm,
    lowerPpm,
  };
  // D-671: ONE look per cell. The state changes only where the look is recorded; on every other
  // night the figures above are descriptive and the state is left exactly as it is (so an Owner
  // demotion to shadow holds too). `setCellResult` is the gate: it succeeds once.
  let lookRecorded = false;
  if (sampleMet && cell.resultAt === null && now > cell.loggedAt) {
    lookRecorded = await setCellResult(db, cell.cellId, now, result);
  }
  // D-672: idempotent apply. A look recorded here, or one whose state write was lost between the
  // two statements (no config_version row carries its marker), sets the state from the RECORDED
  // result, never from tonight's figures.
  const recorded = lookRecorded
    ? result
    : cell.resultAt !== null
      ? (cell.result as typeof result)
      : null;
  let changed = false;
  if (recorded !== null) {
    const marker = `VAL-118 look ${cell.cellId}:`;
    const applied = await db.execute({
      sql: "SELECT 1 FROM config_version WHERE key = 'intraday_stream_state' AND reason LIKE ? LIMIT 1",
      args: [`${marker}%`],
    });
    const current = (await getConfig(db, "intraday_stream_state")) as StreamState;
    // live-tested is an Owner step after a release; the evaluator moves only shadow <-> allowed.
    if (applied.rows.length === 0 && current !== "live-tested") {
      changed = await writeStreamState(db, {
        state: recorded.passed ? "allowed" : "shadow",
        userId: null,
        reason: `${marker} ${recorded.candidates} candidates, ${recorded.sessions} sessions, lower bound ${
          recorded.lowerPpm === null ? "n/a" : Math.round(recorded.lowerPpm)
        } ppm`,
        now,
      });
    }
  }
  return {
    state: (await getConfig(db, "intraday_stream_state")) as StreamState,
    changed,
    candidates: rows.length,
    sessions: dates.length,
    meanNetPpm,
    lowerPpm,
    sampleMet,
    cellId: cell.cellId,
    lookRecorded,
  };
}

/** The Owner may only set shadow (D-391); there is no way through here to `allowed`. */
export async function ownerSetShadow(db: Client, userId: number, now: string): Promise<boolean> {
  return writeStreamState(db, { state: "shadow", userId, reason: "Owner set shadow", now });
}
