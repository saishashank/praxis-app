// The paper tax report (M21 B3; ARN-122, D-1222, D-1223). `buildReport` is pure: loaded fills in, figures out.
// `taxReport` reads the paper books (src/lib/tax/book.ts) or, for the Owner's own trade log, the lazily imported
// src/lib/tax/fromLog.ts (D-1214: nothing of the Owner tools is loaded unless the log variant is asked for).
// Year by SALE date. Per execution of the market plus a market total, in the market's own currency; markets are
// never pooled. Both columns carry the holding flag. The words "Paper results, not tax advice" lead every output.
import type { Client } from "@libsql/client";
import { financialYearLabel, financialYearRange } from "@/lib/market/seed/taxYear.mjs";
import { fifoMatch } from "./fifo";
import { specificLots } from "./lots";
import {
  LOG_HEADING,
  PAPER_WORDS,
  type BookTrade,
  type ClosedWithoutPrice,
  type DividendRow,
  type Disposal,
  type ExecutionReport,
  type Section,
  type Split,
  type TaxFill,
  type TaxReport,
  type Totals,
  type Unmatched,
  type WrittenOff,
} from "./types";

const ZERO: Totals = {
  costMicro: 0n,
  proceedsMicro: 0n,
  gainMicro: 0n,
  gainsMicro: 0n,
  lossesMicro: 0n,
  gainOver12Micro: 0n,
  gain12OrLessMicro: 0n,
};

export function totalsOf(disposals: readonly Disposal[]): Totals {
  let t = ZERO;
  for (const x of disposals) {
    t = {
      costMicro: t.costMicro + x.costMicro,
      proceedsMicro: t.proceedsMicro + x.proceedsMicro,
      gainMicro: t.gainMicro + x.gainMicro,
      gainsMicro: x.gainMicro > 0n ? t.gainsMicro + x.gainMicro : t.gainsMicro,
      lossesMicro: x.gainMicro < 0n ? t.lossesMicro + x.gainMicro : t.lossesMicro,
      gainOver12Micro: x.over12Months ? t.gainOver12Micro + x.gainMicro : t.gainOver12Micro,
      gain12OrLessMicro: x.over12Months ? t.gain12OrLessMicro : t.gain12OrLessMicro + x.gainMicro,
    };
  }
  return t;
}

const section = (disposals: Disposal[]): Section => ({ disposals, totals: totalsOf(disposals) });

/** One FIFO stream: the fills of one code in one book (or the log), and that code's splits. */
export type Stream = {
  readonly executionId: string;
  readonly fills: readonly TaxFill[];
  readonly splits: readonly Split[];
};

export type ReportInput = {
  readonly market: string;
  readonly fy: number;
  readonly source: "book" | "log";
  /** The paper trades (book source); empty for the log. */
  readonly trades: readonly BookTrade[];
  /** Split events of each cohort (book source). */
  readonly splitsByCohort: ReadonlyMap<string, readonly Split[]>;
  /** The log's streams (log source). */
  readonly logStreams: readonly Stream[];
  readonly dividends: readonly DividendRow[];
  readonly truncated: boolean;
};

const inYear = (d: string, start: string, end: string): boolean => d >= start && d <= end;
const byDisposal = (a: Disposal, b: Disposal): number =>
  a.sellD !== b.sellD
    ? a.sellD < b.sellD
      ? -1
      : 1
    : a.sellId !== b.sellId
      ? a.sellId < b.sellId
        ? -1
        : 1
      : a.lotId < b.lotId
        ? -1
        : a.lotId > b.lotId
          ? 1
          : 0;

export function buildReport(input: ReportInput): TaxReport {
  const { start, end } = financialYearRange(input.market, input.fy);
  const executions = new Map<string, { specific: Disposal[]; fifo: Disposal[] }>();
  const slot = (id: string) => {
    let s = executions.get(id);
    if (s === undefined) executions.set(id, (s = { specific: [], fifo: [] }));
    return s;
  };
  const closedWithoutPrice: ClosedWithoutPrice[] = [];
  const unmatched: (Unmatched & { executionId: string })[] = [];
  const writtenOff: (WrittenOff & { executionId: string })[] = [];
  const sameDay: string[] = [];

  const runStream = (
    executionId: string,
    fills: readonly TaxFill[],
    splits: readonly Split[],
    buysFirst = false,
  ) => {
    const r = fifoMatch(
      fills.filter((f) => f.d <= end),
      splits.filter((s) => s.exD <= end),
      { buysFirst },
    );
    const s = slot(executionId);
    for (const d of r.disposals) if (inYear(d.sellD, start, end)) s.fifo.push(d);
    for (const u of r.unmatched)
      if (inYear(u.sellD, start, end)) unmatched.push({ ...u, executionId });
    for (const w of r.writtenOff)
      if (inYear(w.exD, start, end)) writtenOff.push({ ...w, executionId });
  };

  if (input.source === "book") {
    // Specific lot: one lot per closed trade, the year of the sale.
    for (const exec of new Set(input.trades.map((t) => t.executionId))) {
      const mine = input.trades.filter((t) => t.executionId === exec);
      const r = specificLots(
        mine.filter((t) => t.exit === null || t.exit.d <= end),
        (cohortId, code) =>
          (input.splitsByCohort.get(cohortId) ?? []).filter((x) => x.code === code),
      );
      const s = slot(exec);
      for (const d of r.disposals) if (inYear(d.sellD, start, end)) s.specific.push(d);
      for (const c of r.closedWithoutPrice)
        if (inYear(c.closedD, start, end)) closedWithoutPrice.push(c);
    }
    // FIFO: per cohort and code, over the whole history up to the year end. A `legacy` entry never closes through
    // a sale, so its shares are left out (they would otherwise be sold first by a later sale).
    const streams = new Map<string, { executionId: string; cohortId: string; fills: TaxFill[] }>();
    for (const t of input.trades) {
      if (t.legacy) continue;
      const key = `${t.cohortId}\u0000${t.code}`;
      let s = streams.get(key);
      if (s === undefined)
        streams.set(key, (s = { executionId: t.executionId, cohortId: t.cohortId, fills: [] }));
      s.fills.push(t.entry);
      if (t.exit !== null) s.fills.push(t.exit);
    }
    for (const [key, s] of [...streams].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const code = key.slice(key.indexOf("\u0000") + 1);
      runStream(
        s.executionId,
        s.fills,
        (input.splitsByCohort.get(s.cohortId) ?? []).filter((x) => x.code === code),
      );
    }
  } else {
    for (const st of input.logStreams) runStream(st.executionId, st.fills, st.splits, true);
    for (const st of input.logStreams) {
      const seen = new Map<string, Set<string>>();
      for (const f of st.fills) {
        const k = `${f.code} ${f.d}`;
        seen.set(k, (seen.get(k) ?? new Set()).add(f.side));
      }
      for (const [k, sides] of seen) {
        if (sides.size === 2 && inYear(k.slice(k.indexOf(" ") + 1), start, end)) sameDay.push(k);
      }
    }
    // The log records no lot choice: the specific-lot column is the FIFO one.
    for (const s of executions.values()) s.specific = [...s.fifo];
  }

  const reports: ExecutionReport[] = [...executions.entries()]
    .filter(([, s]) => s.specific.length > 0 || s.fifo.length > 0) // a strategy with no sale in the year is not listed
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([id, s]) => ({
      id,
      specific: section(s.specific.sort(byDisposal)),
      fifo: section(s.fifo.sort(byDisposal)),
    }));
  const all = (pick: (e: ExecutionReport) => Section) =>
    totalsOf(reports.flatMap((e) => [...pick(e).disposals]));
  const dividends = input.dividends
    .filter((x) => inYear(x.d, start, end))
    .sort((a, b) =>
      a.d !== b.d ? (a.d < b.d ? -1 : 1) : a.code < b.code ? -1 : a.code > b.code ? 1 : 0,
    );

  const notes: string[] = [
    "Each year is the one the sale falls in. Figures are in the market's own currency and are never added across markets.",
    "Amounts are rounded to the cent; totals use the exact figures.",
    "Cost is the buy value plus its brokerage; proceeds are the sale value less its brokerage. Splits and bonus issues change the number of shares, not the cost.",
    '"Over 12 months" means the sale date is after the 12-month anniversary of the buy date.',
  ];
  if (input.source === "log") {
    notes.push(
      "The log records no choice of lot, so the specific-lot column is the FIFO column.",
      "Splits, consolidations and bonus issues recorded for the market are applied to the log's share counts; enter quantities as they were at the time of each trade. A sale with no earlier buy in the log is listed below and has no gain.",
    );
    if (sameDay.length > 0) {
      notes.push(
        `The log has no time of day: on a date with both a buy and a sale, the buys are taken first (${sameDay.sort().join("; ")}).`,
      );
    }
  }
  return {
    market: input.market,
    fy: input.fy,
    fyLabel: financialYearLabel(input.market, input.fy),
    fyStart: start,
    fyEnd: end,
    source: input.source,
    words: PAPER_WORDS,
    heading: input.source === "log" ? LOG_HEADING : "Paper books",
    notes,
    executions: reports,
    total: { specific: all((e) => e.specific), fifo: all((e) => e.fifo) },
    specificEqualsFifo: input.source === "log",
    closedWithoutPrice: closedWithoutPrice.sort((a, b) =>
      a.buyD !== b.buyD
        ? a.buyD < b.buyD
          ? -1
          : 1
        : a.code < b.code
          ? -1
          : a.code > b.code
            ? 1
            : 0,
    ),
    unmatched,
    writtenOff,
    dividends,
    dividendTotalMicro: dividends.reduce((a, x) => a + x.amountMicro, 0n),
    truncated: input.truncated,
  };
}

export type TaxReportRequest = { market: string; fy: number; source: "book" | "log" };

/** Reads what the report needs and builds it. The log variant is loaded lazily and only on request. */
export async function taxReport(db: Client, req: TaxReportRequest): Promise<TaxReport> {
  const range = financialYearRange(req.market, req.fy);
  if (req.source === "log") {
    const { loadLogStreams } = await import("./fromLog");
    const log = await loadLogStreams(db, req.market, range.end);
    return buildReport({
      market: req.market,
      fy: req.fy,
      source: "log",
      trades: [],
      splitsByCohort: new Map(),
      logStreams: log.streams,
      dividends: [],
      truncated: log.truncated,
    });
  }
  const { loadBook } = await import("./book");
  const book = await loadBook(db, req.market, range);
  return buildReport({
    market: req.market,
    fy: req.fy,
    source: "book",
    trades: book.trades,
    splitsByCohort: book.splitsByCohort,
    logStreams: [],
    dividends: book.dividends,
    truncated: book.truncated,
  });
}
