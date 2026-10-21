// Rule materiality of one announcement (AGT-011; docs/M5_design.md 2.2, D-100 draft). Pure: no
// clock, no I/O, no LLM (AGT-011a: an LLM figure is stored separately and never feeds this table).
//
// The category comes from the M4 event rule table (`classifyAnnouncement`: ASX type code first,
// then word-bounded title patterns), so the Sentinel and the A2 events agree on what an
// announcement is. The table is versioned: a rule change gets a new `MATERIALITY_RULE_VERSION`
// and old rows keep the version they were assessed with.
//
//   3  price-sensitive, or halt/suspension, or exchange query, on a HELD code;
//      takeover (target or bidder statement) on a TRACKED code
//   2  price-sensitive on a WATCH-LIST or CANDIDATE code; results, guidance change, capital
//      raising, director on-market trade (Appendix 3Y) on a TRACKED code
//   1  any other announcement on a TRACKED code
//   0  otherwise (an untracked code)
// The highest applicable rule wins. A held code is always tracked.
import { classifyAnnouncement, eventPolarity } from "@/lib/agents/events";
import { makeRational } from "@/lib/money/rational";
import type { EventCategory, Polarity } from "@/lib/agents/schema";

export const MATERIALITY_RULE_VERSION = "materiality-v1";

export type Materiality = 0 | 1 | 2 | 3;

export type Membership = {
  held: boolean;
  watch: boolean;
  candidate: boolean;
  tracked: boolean;
};

export type AssessInput = {
  type: string | null;
  title: string;
  priceSensitive: boolean;
};

export type Assessment = {
  materiality: Materiality;
  polarity: Polarity;
  category: EventCategory;
  /** Which rule fixed the figure (for tests and for the learning journal). */
  rule: string;
};

const HELD_ALWAYS: ReadonlySet<EventCategory> = new Set(["halt_suspension", "exchange_query"]);
const TAKEOVER: ReadonlySet<EventCategory> = new Set(["takeover_target", "takeover_bidder"]);
const TRACKED_TWO: ReadonlySet<EventCategory> = new Set([
  "results",
  "guidance_up",
  "guidance_down",
  "capital_raising",
  "director_trade",
]);

// Polarity is by category; without an abnormal return the sign categories are 0 (AGT-020).
const NO_THRESHOLD = makeRational(1n);

export function assess(item: AssessInput, m: Membership): Assessment {
  const { category } = classifyAnnouncement(item.type, item.title);
  const polarity = eventPolarity(category, null, NO_THRESHOLD);
  const done = (materiality: Materiality, rule: string): Assessment => ({
    materiality,
    polarity,
    category,
    rule,
  });
  const tracked = m.tracked || m.held;
  if (m.held && item.priceSensitive) return done(3, "held:price_sensitive");
  if (m.held && HELD_ALWAYS.has(category)) return done(3, `held:${category}`);
  if (tracked && TAKEOVER.has(category)) return done(3, `tracked:${category}`);
  if ((m.watch || m.candidate) && item.priceSensitive) return done(2, "watch:price_sensitive");
  if (tracked && TRACKED_TWO.has(category)) return done(2, `tracked:${category}`);
  if (tracked) return done(1, "tracked:other");
  return done(0, "untracked");
}
