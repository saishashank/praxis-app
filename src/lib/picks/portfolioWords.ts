// D-955 plain words of "My portfolio" (Owner 2026-11-11: every trade and ratio change has a reason in
// market words, no codes, no dates). Pure. The words never name the stock, an amount or a date: the
// page and the review add those for the viewer (a masked viewer sees letters and percentages only).
import { formatPpm, plural } from "@/lib/view/format";
import { STRATEGIES, type StrategyKey } from "./allocation";

export type StrategyNames = Readonly<Record<StrategyKey, string>>;

/** The shortlist's display name (the families' names come from the strategy-name table). */
export const SHORTLIST_NAME = "Nightly shortlist";

/** Strategy names: the families' from `familyNames` (or the defaults), the shortlist's own. */
export function strategyNames(families: Readonly<Record<string, string>>): StrategyNames {
  const out = {} as Record<StrategyKey, string>;
  for (const s of STRATEGIES) out[s] = s === "SL" ? SHORTLIST_NAME : (families[s] ?? "A strategy");
  return out;
}

type WordsParams = {
  readonly names: StrategyNames;
  readonly weakAverageSessions: number;
  readonly shortlistAverageSessions: number;
};

const pct = (ppm: number): string => formatPpm(ppm, { digits: 0 });
const signed = (ppm: number): string => formatPpm(ppm, { digits: 1, sign: "always" });

/** "Follow the trend 35%, Nightly shortlist 25%, cash 40%" (whole percents, cash takes the rest). */
export function splitLine(
  shares: readonly { strategy: StrategyKey; targetPpm: number }[],
  cashPpm: number,
  names: StrategyNames,
): string {
  const percent = 10_000; // threshold-ok: ppm in one percent
  const rows = shares.filter((s) => Math.round(s.targetPpm / percent) > 0);
  const used = rows.reduce((a, s) => a + Math.round(s.targetPpm / percent), 0);
  const parts = rows.map((s) => `${names[s.strategy]} ${Math.round(s.targetPpm / percent)}%`);
  // the whole money is cash plus every share; what the shown shares leave is cash (with any share
  // under half a percent)
  const whole = Math.round((cashPpm + shares.reduce((a, s) => a + s.targetPpm, 0)) / percent);
  const cash = Math.max(0, whole - used);
  if (cash > 0 || parts.length === 0) parts.push(`cash ${cash}%`);
  return parts.join(", ");
}

export function buyWords(
  strategy: StrategyKey,
  sizePpm: number,
  targetPpm: number,
  p: WordsParams,
): string {
  const name = p.names[strategy];
  return `Bought as a ${name} pick: ${pct(sizePpm)} of the money (${name}'s share is ${pct(targetPpm)}).`;
}

export type ExitKind =
  "stop" | "gap" | "aim" | "time_frame" | "weak" | "strategy_exit" | "rebalance" | "none_left";

export function exitWords(kind: ExitKind, strategy: StrategyKey, p: WordsParams): string {
  switch (kind) {
    case "stop":
      return "Sold at the stop-loss.";
    case "gap":
      return "Sold at the open, which was already below the stop-loss.";
    case "aim":
      return "Sold at the aim.";
    case "time_frame":
      return "Sold: the time frame ended with nothing new on the stock.";
    case "weak":
      return `Sold: below its buy price and its ${p.weakAverageSessions}-day average, with no signal.`;
    case "strategy_exit":
      return strategy === "SL"
        ? `Sold: the ${SHORTLIST_NAME} trend broke (it closed under its ${p.shortlistAverageSessions}-day average).`
        : `Sold: ${p.names[strategy]} gave its sell signal.`;
    case "rebalance":
      return `Trimmed to bring ${p.names[strategy]} back to its share.`;
    case "none_left":
      return "Sold: a share consolidation left no whole share.";
  }
}

export function trimWords(
  strategy: StrategyKey,
  havePpm: number,
  targetPpm: number,
  bandPpm: number,
  p: WordsParams,
): string {
  const name = p.names[strategy];
  return `Trimmed: ${name} had ${pct(havePpm)} of the money, more than ${pct(bandPpm)} over its ${pct(targetPpm)} share.`;
}

export type SplitShareWords = {
  readonly strategy: StrategyKey;
  readonly targetPpm: number;
  readonly n: number;
  /** Mean result of its finished picks (fraction). */
  readonly mean: number;
  readonly capped: boolean;
  readonly weak: boolean;
};

function recordWords(x: SplitShareWords, capPpm: number | null): string {
  const ppm = 1_000_000; // threshold-ok: parts per million
  const base =
    x.n === 0
      ? "no finished picks yet, so close to an equal share, set by its stop-losses"
      : `${x.n} finished ${plural(x.n, "pick")} averaging ${signed(Math.round(x.mean * ppm))} after costs`;
  const extra = [
    x.capped && capPpm !== null ? `capped at ${pct(capPpm)}` : null,
    x.weak ? "part kept as cash while its record is a loss" : null,
  ].filter((s): s is string => s !== null);
  return extra.length > 0 ? `${base}; ${extra.join(", ")}` : base;
}

/** The split and why it changed from the last one, in one or two sentences. */
export function splitWords(
  now: readonly SplitShareWords[],
  cashPpm: number,
  prev: readonly { strategy: StrategyKey; targetPpm: number }[] | null,
  p: WordsParams & { readonly strategyCapPpm: number },
): string {
  const line = `${splitLine(now, cashPpm, p.names)}.`;
  if (prev === null) return `${line} First split, from the strategies' records so far.`;
  const before = new Map(prev.map((x) => [x.strategy, x.targetPpm]));
  const after = new Map(now.map((x) => [x.strategy, x]));
  let best: { s: StrategyKey; delta: number } | null = null;
  for (const s of STRATEGIES) {
    const delta = (after.get(s)?.targetPpm ?? 0) - (before.get(s) ?? 0);
    if (delta !== 0 && (best === null || Math.abs(delta) > Math.abs(best.delta)))
      best = { s, delta };
  }
  if (best === null) return line;
  const name = p.names[best.s];
  const x = after.get(best.s);
  if (x === undefined)
    return `${line} ${name} has no holding or pick now; its money waits as cash.`;
  if (!before.has(best.s)) return `${line} ${name} comes in with a new pick.`;
  return `${line} ${best.delta > 0 ? "More" : "Less"} for ${name}: ${recordWords(x, p.strategyCapPpm)}.`;
}
