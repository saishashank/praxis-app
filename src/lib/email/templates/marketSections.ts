// Per-market sections of the Evening Review and the Morning Brief (UXN-313, D-1124, D-1061; M20 S1). With one market the
// e-mail is exactly what it was (the M19 snapshot tests): these blocks are added only when a SECOND enabled market that
// trades on the date has something to say, one section per market, in its own currency, never pooled with another
// market's figures (O-34). Pure and deterministic: no clock, no locale API (grouping is done here, the lakh style for
// en-IN). Times arrive pre-formatted by `formatMarketTime` (the market's own zone and Melbourne when they differ).
import { currencyFormatOf } from "@/lib/market/profileCore.mjs";
import type { Block } from "./core";
import { displayTitle } from "@/lib/view/displayText";
import { plural, toneOf, truncate } from "./format";

/** One market's part of the Evening Review. All money in minor units (cents, paise) of the market's own currency. */
export interface MarketSectionFact {
  market: string;
  /** "India (NSE)". */
  name: string;
  /** ISO 4217 code of the market's currency ("INR"). */
  currency: string;
  /** The session's close in the market's zone (and Melbourne when it differs), pre-formatted. */
  closeAt: string;
  strategies: number;
  dayPlCents: number;
  navCents: number;
  closed: number;
  queued: number;
}

/** One market's part of the Morning Brief. */
export interface BriefMarketSection {
  market: string;
  name: string;
  overnight: { code: string; title: string; time: string; url?: string }[];
  events: { label: string; detail: string }[];
  plan: string[];
}

const group = (digits: string, indian: boolean): string => {
  if (!indian || digits.length <= 3) return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const head = digits.slice(0, -3);
  return `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${digits.slice(-3)}`;
};

/** Minor units -> "₹1,00,000.00", "US$1,234.50"; signed adds + or -, a minus is always shown. */
export function moneyIn(cents: number, currency: string, signed = false): string {
  const f = currencyFormatOf(currency);
  const abs = Math.abs(Math.round(cents));
  const body = `${group(String(Math.floor(abs / 100)), f.locale === "en-IN")}.${String(abs % 100).padStart(2, "0")}`;
  const sign = cents < 0 ? "-" : signed && cents > 0 ? "+" : "";
  return `${sign}${f.symbol}${body}`;
}

/** The blocks of the extra markets of the Evening Review, one heading and one key-value table each. */
export function reviewMarketBlocks(sections: readonly MarketSectionFact[]): Block[] {
  const out: Block[] = [];
  for (const s of sections) {
    out.push(
      { t: "h", text: `${s.name} (${s.market}), ${s.currency}` },
      {
        t: "kv",
        rows: [
          ["Session closed", s.closeAt],
          [
            "Today, all strategies",
            {
              text: moneyIn(s.dayPlCents, s.currency, true),
              tone: toneOf(s.dayPlCents),
              bold: true,
            },
          ],
          ["Value now", moneyIn(s.navCents, s.currency)],
          ["Strategies", `${s.strategies} ${plural(s.strategies, "strategy", "strategies")}`],
          ["Trades finished today", s.closed === 0 ? "none closed" : String(s.closed)],
          ["Orders for the next session", String(s.queued)],
        ],
      },
    );
  }
  return out;
}

/** The blocks of the extra markets of the Morning Brief; lists are capped like the main lists. */
export function briefMarketBlocks(sections: readonly BriefMarketSection[], cap: number): Block[] {
  const out: Block[] = [];
  for (const s of sections) {
    out.push({ t: "h", text: `${s.name} (${s.market})` });
    out.push(
      s.overnight.length
        ? {
            t: "table",
            head: ["Code", "Announcement", "Time"],
            rows: s.overnight
              .slice(0, cap)
              .map((a) => [
                a.code,
                { text: truncate(displayTitle(a.title), 110), href: a.url },
                a.time,
              ]),
          }
        : { t: "p", text: "Nothing overnight on held or watched codes.", tone: "muted" },
    );
    if (s.events.length) {
      out.push({ t: "ul", items: s.events.slice(0, cap).map((e) => `${e.label}: ${e.detail}`) });
    }
    out.push(
      s.plan.length
        ? { t: "ul", items: s.plan.slice(0, cap) }
        : { t: "p", text: "No orders pending.", tone: "muted" },
    );
  }
  return out;
}
