// Alert tiers, keys and wording (M5 T6; AGT-115, EML-020, EML-022, UXN-251; docs/M5_design.md 2.2,
// 4.3; D-096 decisions 9, 24, 27, 40; D-101). PURE: no clock, no I/O, no LLM. The tier is a function
// of the rule inputs only (AGT-011a: an LLM figure never moves a tier or an email byte).
//
// Tier (design 2.2):
//   P0  held code with weight >= `alert_p0_weight` of that execution's NAV and materiality 3, or a
//       halt / suspension of a held code (ASX type or title). The DAT-127 proxy is never P0.
//   P1  held below the weight with materiality >= 2; watch-list code with materiality 3; a regime
//       transition (UXN-251); a pre-open re-check failure; a halt proxy. A red thesis-breaker on an open
//       position is P0 and on a pending entry P2 (D-102, decision 44; set where the alert is written).
//   P2  everything else with materiality >= 1 (materiality 0 raises no alert).
// The weight is compared EXACTLY: value x 1,000,000 >= nav x threshold-ppm (BigInt), never as a float.
import { classifyAnnouncement } from "@/lib/agents/events";
import type { EventCategory } from "@/lib/agents/schema";
import type { AlertKind, AlertTier } from "@/lib/sentinel/schema";

const PPM = 1_000_000n;

export const alertKeys = {
  announcement: (market: string, source: string, annId: string) =>
    `ann:${market}:${source}:${annId}`,
  thesisBreaker: (tradeId: string, breaker: string, d: string) => `tb:${tradeId}:${breaker}:${d}`,
  regime: (market: string, d: string) => `regime:${market}:${d}`,
  preopen: (market: string, d: string) => `preopen:${market}:${d}`,
  proxy: (market: string, code: string, d: string) => `proxy:${market}:${code}:${d}`,
} as const;

/** The alert kind a well-formed key stands for, else null. */
export function alertKeyKind(key: string): AlertKind | null {
  if (/^ann:[^:\s]+:[^:\s]+:\S+$/.test(key)) return "announcement";
  if (/^tb:[^:\s]+:[^:\s]+:\d{4}-\d{2}-\d{2}$/.test(key)) return "thesis_breaker";
  if (/^regime:[^:\s]+:\d{4}-\d{2}-\d{2}$/.test(key)) return "regime_shift";
  if (/^preopen:[^:\s]+:\d{4}-\d{2}-\d{2}$/.test(key)) return "preopen_failure";
  if (/^proxy:[^:\s]+:[^:\s]+:\d{4}-\d{2}-\d{2}$/.test(key)) return "halt_proxy";
  return null;
}

/** Kinds that no quiet hours, snooze or preference may hide (UXN-160, UXN-251): P0 and regime P1. */
export function neverSuppressed(tier: AlertTier, kind: AlertKind): boolean {
  return tier === "P0" || kind === "regime_shift";
}

export type Holder = {
  executionId: string;
  /** Short display label, e.g. "F1 U". */
  label: string;
  /** Market value of the held position at the latest close, micro units (raw close x qty). */
  valueMicro: bigint;
  /** The execution's latest NAV, micro units. */
  navMicro: bigint;
};

/** `alert_p0_weight` (a fraction, e.g. 0.10) as integer parts per million. */
export function thresholdPpm(weight: number): number {
  return Math.round(weight * 1_000_000);
}

/** floor(value / nav) in parts per million; 0 when the NAV is not positive. For display only. */
export function weightPpm(h: Pick<Holder, "valueMicro" | "navMicro">): number {
  if (h.navMicro <= 0n || h.valueMicro <= 0n) return 0;
  return Number((h.valueMicro * PPM) / h.navMicro);
}

/** Exact test: value / nav >= threshold. */
export function meetsWeight(h: Pick<Holder, "valueMicro" | "navMicro">, thrPpm: number): boolean {
  if (h.navMicro <= 0n) return false;
  return h.valueMicro * PPM >= h.navMicro * BigInt(thrPpm);
}

/** The holder with the largest weight (exact cross-multiplication); ties keep list order. */
export function heaviest(holders: readonly Holder[]): Holder | null {
  let best: Holder | null = null;
  for (const h of holders) {
    if (h.navMicro <= 0n) continue;
    if (best === null || h.valueMicro * best.navMicro > best.valueMicro * h.navMicro) best = h;
  }
  return best ?? holders[0] ?? null;
}

export type TierInput = {
  kind: AlertKind;
  category: EventCategory;
  materiality: 0 | 1 | 2 | 3;
  held: boolean;
  watch: boolean;
  holders: readonly Holder[];
  thresholdPpm: number;
};

export type TierDecision = {
  tier: AlertTier;
  kind: AlertKind;
  /** Which rule fixed the tier (tests and the learning journal). */
  rule: string;
  /** The holder shown on the alert row (the heaviest). */
  holder: Holder | null;
  weightPpm: number | null;
};

const HALT: ReadonlySet<EventCategory> = new Set(["halt_suspension"]);

/** Tier of one assessed announcement, or null when it raises no alert (materiality 0). */
export function tierForAnnouncement(i: TierInput): TierDecision | null {
  if (i.materiality === 0 && !(i.held && HALT.has(i.category))) return null;
  const holder = heaviest(i.holders);
  const ppm = holder ? weightPpm(holder) : null;
  const done = (tier: AlertTier, rule: string, kind: AlertKind = "announcement"): TierDecision => ({
    tier,
    kind,
    rule,
    holder,
    weightPpm: ppm,
  });
  if (i.held && HALT.has(i.category)) return done("P0", "p0:held_halt", "halt");
  const heavy = i.holders.some((h) => meetsWeight(h, i.thresholdPpm));
  if (i.held && heavy && i.materiality === 3) return done("P0", "p0:held_weight_material");
  if (i.held && i.materiality >= 2) return done("P1", "p1:held_below_weight");
  if (i.watch && i.materiality === 3) return done("P1", "p1:watch_material");
  return done("P2", "p2:other");
}

/** Fixed-tier alerts that are not announcements (design 2.2): regime, pre-open, proxy. */
export const FIXED_P1_KINDS: readonly AlertKind[] = [
  "regime_shift",
  "preopen_failure",
  "halt_proxy",
];

// ---- regime transition (UXN-251) ---------------------------------------------------------------

export const REGIME_STATES = ["SHOCK", "RISK-OFF", "RISK-ON", "NEUTRAL", "unknown"] as const;
export type RegimeState = (typeof REGIME_STATES)[number];

/**
 * A regime transition is a change between two KNOWN states on consecutive sessions. `unknown` is the
 * warm-up (design 4.3): leaving it is not a market change and raises nothing.
 */
export function regimeTransition(
  prev: string | null,
  cur: string | null,
): { from: RegimeState; to: RegimeState } | null {
  const known = (s: string | null): s is RegimeState =>
    s !== null && s !== "unknown" && (REGIME_STATES as readonly string[]).includes(s);
  if (!known(prev) || !known(cur) || prev === cur) return null;
  return { from: prev, to: cur };
}

// ---- facts and wording (template text only, EML-022) -------------------------------------------

export type AlertExecutionFact = { id: string; label: string; weightPct: number };

export type AlertFacts = {
  source?: string;
  annId?: string;
  title?: string;
  /** Announcement type label, e.g. "Trading halt". */
  type?: string;
  url?: string | null;
  category?: string;
  rule: string;
  why: string;
  executions: AlertExecutionFact[];
  from?: string;
  to?: string;
  d?: string;
  /** Regime P1: executions whose entries the new state gates (spec 7.4) and how. */
  gated?: { id: string; label: string; effect: string }[];
};

const CATEGORY_LABEL: Readonly<Record<EventCategory, string>> = {
  results: "Results",
  guidance_up: "Guidance upgrade",
  guidance_down: "Guidance downgrade",
  contract_win: "Contract win",
  capital_raising: "Capital raising",
  director_trade: "Director trade",
  substantial_holder: "Substantial holder",
  takeover_target: "Takeover (target)",
  takeover_bidder: "Takeover (bidder)",
  halt_suspension: "Trading halt or suspension",
  exchange_query: "Exchange query",
  dividend_change: "Dividend change",
  management_change: "Management change",
  other: "Announcement",
};

export const categoryLabel = (c: EventCategory): string => CATEGORY_LABEL[c];

/** Display percent with one decimal from parts per million. */
export const ppmToPct = (ppm: number): number => Math.round(ppm / 1000) / 10;

export function whyText(d: TierDecision, category: EventCategory, thrPpm: number): string {
  const thr = `${ppmToPct(thrPpm)}%`;
  const w = d.weightPpm === null ? null : `${ppmToPct(d.weightPpm)}%`;
  const where = d.holder ? ` in ${d.holder.executionId}` : "";
  switch (d.rule) {
    case "p0:held_halt":
      return `A held code is halted or suspended${w ? ` (${w} of NAV${where})` : ""}: P0 rule.`;
    case "p0:held_weight_material":
      return `A held position of ${w ?? "n/a"} of NAV${where} meets the ${thr} P0 weight and the announcement is rated 3 of 3: P0 rule.`;
    case "p1:held_below_weight":
      return `A held position${w ? ` of ${w} of NAV${where}` : ""} is below the ${thr} P0 weight; ${CATEGORY_LABEL[category].toLowerCase()} is rated 2 or more: P1.`;
    case "p1:watch_material":
      return `A watch-list code with a materiality 3 announcement: P1.`;
    default:
      return `${CATEGORY_LABEL[category]} on a tracked code: P2.`;
  }
}

/** Classifies title and type exactly like the Sentinel (same table as A2 events). */
export const categoryOf = (type: string | null, title: string): EventCategory =>
  classifyAnnouncement(type, title).category;

/** Rules text shown in the app when no model text exists (AGT-115 template wording). */
export function rulesText(
  tier: AlertTier,
  kind: AlertKind,
  code: string | null,
  facts: AlertFacts,
): string {
  switch (kind) {
    case "regime_shift":
      return `Market regime changed from ${facts.from ?? "n/a"} to ${facts.to ?? "n/a"} on ${facts.d ?? "n/a"}.`;
    case "preopen_failure":
      return `The pre-open re-check did not complete on ${facts.d ?? "n/a"}; orders fill without it.`;
    case "halt_proxy":
      return `${code ?? "A code"} may be halted: no volume or price in the last session.`;
    case "thesis_breaker":
      return `A thesis breaker turned red${code ? ` on ${code}` : ""}.`;
    default:
      return `${tier}: ${facts.type ?? "Announcement"}${code ? ` on ${code}` : ""}: ${facts.title ?? ""}`.trim();
  }
}
