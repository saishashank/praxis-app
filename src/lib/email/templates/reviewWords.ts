// Plain-word helpers of the Evening Review (D-922): money as A$ with a sign, percentages from ppm,
// exit reasons in plain words, and the plain-text lists of sections 4-6 that the masked in-app view
// reads (facts.narrative). Pure: no clock, no database. Shared by the renderer and the readers.
import type { DailyLearning } from "@/lib/learning/daily";
import { amount } from "./format";

const PPM_PER_PERCENT = 10_000; // threshold-ok: parts per million -> percent

/** Whole cents -> "A$12.34"; signed -> "+A$12.34" / "-A$12.34". Never colour-only. */
export function aud(cents: number, signed = false): string {
  const sign = cents < 0 ? "-" : signed && cents > 0 ? "+" : "";
  return `${sign}A$${amount(cents)}`;
}

/** ppm -> "+1.2%" (signed) or "1.2%". */
export function pctPpm(ppm: number, signed = true): string {
  const v = ppm / PPM_PER_PERCENT; // threshold-ok: ppm -> percent
  const sign = signed && v > 0 ? "+" : "";
  return `${sign}${v.toFixed(1)}%`;
}

/** Cents and ppm in one cell: "+A$24.70 (+1.2%)". */
export function audWithPct(cents: number, ppm: number | null | undefined): string {
  return ppm === null || ppm === undefined
    ? aud(cents, true)
    : `${aud(cents, true)} (${pctPpm(ppm)})`;
}

/** The facts of one position closed today (readClosedToday). */
export interface ClosedTradeFact {
  strategy: string;
  code: string;
  /** Company name (display form), null when unknown. */
  company: string | null;
  resultCents: number;
  /** How it ended, in plain words. */
  exit: string;
}

/** "Company Name (CODE)", or the code alone when the name is unknown. */
export function companyLabel(name: string | null | undefined, code: string): string {
  return name === null || name === undefined || name === "" || name === "n/a"
    ? code
    : `${name} (${code})`;
}

const CS_WORDS: Readonly<Record<string, string>> = {
  close_above_sma: "the price crossed its average (the trend turned)",
  close_below_sma: "the price crossed its average (the trend turned)",
  time_stop: "the time limit ran out",
  negative_event: "bad news came out",
  close_below_level: "the price closed below its safety level",
};

/**
 * The plain words of how a position ended. `reason` is the learning attribution tag ("IS", "CS",
 * "CS:close_above_sma", "terminal:..."), `exitType` the trade row ("IS" / "CS" / "terminal") and
 * `rule` the fill rule ("level" / "gap_open" / "close_signal" / "open").
 */
export function exitWords(
  reason: string | null,
  exitType: string | null,
  rule: string | null,
): string {
  const r = reason ?? exitType ?? "";
  if (r === "IS") {
    return rule === "gap_open" ? "price gapped past the stop-loss" : "stop-loss hit";
  }
  if (r.startsWith("CS:")) {
    const why = CS_WORDS[r.slice(3)];
    return why === undefined ? "closing signal" : `closing signal: ${why}`;
  }
  if (r === "CS") return "closing signal";
  if (r.startsWith("terminal") || exitType === "terminal") {
    return "closed because of a company event (such as a takeover)";
  }
  if (rule === "gap_open") return "price gapped past the stop-loss";
  return "closed";
}

/** Sorted copy: strategy name, then the biggest loss first. */
export function sortClosed(rows: readonly ClosedTradeFact[]): ClosedTradeFact[] {
  return [...rows].sort(
    (a, b) =>
      (a.strategy < b.strategy ? -1 : a.strategy > b.strategy ? 1 : 0) ||
      a.resultCents - b.resultCents ||
      (a.code < b.code ? -1 : 1),
  );
}

/** The honest headline of section 5, or null when at least one trade made money. */
export function workedHeadline(rows: readonly ClosedTradeFact[]): {
  worked: boolean;
  text: string;
} {
  if (rows.length === 0) {
    return { worked: false, text: "Nothing worked today: no strategy finished a trade." };
  }
  const wins = rows.filter((r) => r.resultCents > 0);
  const total = rows.reduce((a, r) => a + r.resultCents, 0);
  if (wins.length === 0) {
    return {
      worked: false,
      text: `Nothing worked today: ${rows.length === 1 ? "the one trade that finished lost" : `all ${rows.length} trades that finished lost`} money (${aud(total, true)} in all).`,
    };
  }
  return {
    worked: true,
    text: `${wins.length} of ${rows.length} finished ${rows.length === 1 ? "trade" : "trades"} made money; ${aud(total, true)} in all.`,
  };
}

/** Plain-text line of one closed trade (the masked view and the plain-text part). */
export function closedLine(r: ClosedTradeFact): string {
  return `${r.strategy}: ${companyLabel(r.company, r.code)} ${aud(r.resultCents, true)}, ${r.exit}.`;
}

export type SectionLists = { s4: string[]; s5: string[]; s6: string[] };

/** The heading of the learning Cortex's lines inside "What we learned today" (D-923). */
export const BRAIN_HEADING = "What the brain learned";

/** The plain lists behind sections 4-6, built from structured facts only (no model). */
export function reviewLists(p: {
  learning: DailyLearning | null;
  closed: readonly ClosedTradeFact[];
  queuedOrders: number | null;
}): SectionLists {
  const s4: string[] = [];
  if (p.learning === null) s4.push("The learning step did not run tonight.");
  else {
    s4.push(...p.learning.summary);
    for (const l of p.learning.lessons) {
      s4.push(
        `${l.feature}: next day ${pctPpm(l.nextDayAvgPpm)} against ${pctPpm(l.baseAvgPpm)} for the market (${l.n} cases), ${l.verdict}; ${l.change}.`,
      );
    }
    for (const h of p.learning.hypothesesOpened) s4.push(`New idea being tested: ${h}`);
    // D-923: the learning Cortex's night; left out when that step did not run
    const brain = p.learning.cortex?.lines ?? [];
    if (brain.length > 0) s4.push(`${BRAIN_HEADING}:`, ...brain);
  }
  const s5: string[] = [workedHeadline(p.closed).text, ...sortClosed(p.closed).map(closedLine)];
  const s6: string[] = [];
  if (p.learning !== null) {
    for (const i of p.learning.improvements) {
      s6.push(`${i.title}: ${i.evidence} Next step: ${i.action}`);
    }
  }
  if (p.queuedOrders !== null) {
    s6.push(
      p.queuedOrders === 0
        ? "No orders are queued for the next session."
        : `${p.queuedOrders} ${p.queuedOrders === 1 ? "order" : "orders"} queued for the next session.`,
    );
  }
  return { s4, s5, s6 };
}
