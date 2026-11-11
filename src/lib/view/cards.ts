// View model of one Decision Card page (AGT-110; docs/M7_design.md 2.4, 2.7; D-128). The page renders
// ONLY this object, so masking happens here, on the server, before anything is rendered: a masked
// user gets "Stock A" for the code, no company name, no trade price, order value or cost amount, the
// week instead of the exact date and no links; free text goes through maskText.
import type { DecisionCard } from "@/lib/agents/cards";
import type { CurrencyFormat } from "@/lib/market/profileCore.mjs";
import { formatDay, formatMicro, formatPpm, isoWeek, MISSING } from "./format";
import { regimeLabel } from "./terms";
import { maskText, StockAliases, type MaskContext, type MaskLookup, EMPTY_LOOKUP } from "./mask";

/** Thesis-breaker ids in plain words (D-919): no TB-… code on a page. */
export const BREAKER_WORD: Readonly<Record<string, string>> = {
  "TB-NEG": "Bad news that moves the price",
  "TB-HALT": "Trading halted, suspended or queried",
  "TB-RAISE": "Company announces a capital raising",
  "TB-EVLOW": "Price closes below the event day low",
  "TB-SI": "Short selling rises",
  "TB-REGIME": "The market mood turns nervous",
  "TB-SMA": "Price closes below its trend line",
  "TB-KW": "A warning word in a news headline",
};
export const breakerWord = (id: string): string => BREAKER_WORD[id] ?? id;

export type CardNote = { text: string; provider: string | null };

export type CardView = {
  masked: boolean;
  /** The code, or "Stock A" for a masked user. */
  stock: string;
  title: string;
  subtitle: string;
  thesis: string;
  note: { text: string; wording: string } | null;
  rules: string[];
  breakers: string[];
  exits: string[];
  sizing: string;
  scenario: string;
  footnote: string;
};

export function cardViewModel(
  card: DecisionCard,
  note: CardNote | null,
  ctx: MaskContext,
  aliases: StockAliases,
  /** The market currency format of the card (`currencyFormatOf(profile.currency)`). */
  fmt: CurrencyFormat,
  lookup: MaskLookup = EMPTY_LOOKUP,
  /** The strategy in words; without it the title falls back to the execution id (D-919). */
  strategyName?: string,
): CardView {
  const m = ctx.masked;
  const t = (s: string): string => (m ? maskText(s, aliases, lookup) : s);
  const stock = m ? aliases.label(card.code) : card.code;
  const day = m ? (isoWeek(card.d) ?? MISSING) : formatDay(card.d);
  const strategy = strategyName ?? card.execution;
  const reason = card.not_taken_reason ?? "reason not recorded";
  const s = card.scenario;

  let sizing: string;
  if (!card.sizing.available) sizing = "Sizing was not available.";
  else if (m) {
    sizing = `Quantity ${card.sizing.qty ?? MISSING}${card.sizing.half_size ? " (half size)" : ""}. Prices and amounts are hidden for your access level.`;
  } else {
    sizing = `Quantity ${card.sizing.qty ?? MISSING} at ${formatMicro(card.sizing.fill_price_micro, fmt)}, order value ${formatMicro(card.sizing.order_value_micro, fmt)}${card.sizing.half_size ? " (half size)" : ""}.`;
  }
  let cost: string;
  if (!card.cost.available) {
    cost = `Cost not available${card.cost.reason ? ` (${t(card.cost.reason)})` : ""}.`;
  } else if (m) {
    cost = `Break-even ${formatPpm(card.cost.break_even_ppm)}.`;
  } else {
    cost = `Round-trip cost ${formatMicro(card.cost.cost_estimate_micro, fmt)}, break-even ${formatPpm(card.cost.break_even_ppm)}.`;
  }

  return {
    masked: m,
    stock,
    title: `Decision Card: ${stock} (${strategy})`,
    subtitle: `${day}, ${strategy}, market mood: ${regimeLabel(card.regime).shown}. ${
      card.taken ? "Order placed." : `Not taken: ${t(reason)}.`
    }`,
    thesis: t(card.thesis),
    note: note
      ? {
          text: t(note.text),
          wording: note.provider === null ? "(Written without AI.)" : "(AI wording.)",
        }
      : null,
    rules: card.rules_fired.map(
      (x) =>
        `${t(x.rule)}: ${t(x.value)} (threshold ${t(x.threshold)}) ${x.pass ? "passed" : "not met"}`,
    ),
    breakers: card.thesis_breakers.map((b) => breakerWord(t(b.id))),
    exits: card.exit_plan.map((x) => `${t(x.tag)} ${t(x.rule)} (${t(x.kind)})`),
    sizing: `${sizing} ${cost}`,
    scenario: s.insufficient_history
      ? `Insufficient history (${t(s.reason ?? MISSING)}).`
      : `Net return p10 ${formatPpm(s.p10_ppm)}, p50 ${formatPpm(s.p50_ppm)}, p90 ${formatPpm(s.p90_ppm)} (n = ${s.n}).`,
    footnote: t(card.footnote),
  };
}
