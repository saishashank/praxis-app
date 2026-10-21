// The in-app Evening Review for a masked user (EML-010/015, DAT-124, ROL-107, UX-009; D-128).
// The stored review HTML is the email as sent and holds codes, prices and links, so a masked user is
// never shown it (and never gets it in an iframe attribute). Instead the page renders THIS view model,
// built from the stored structured facts: orders show "Stock A" with side, quantity and the masked
// reason but no price, cost, stop or target; narrative, alert and health text pass through maskText;
// links are dropped; the Owner and unmasked users keep the stored HTML (the page decides).
import type { ReviewFacts } from "@/lib/email/templates/review";
import { formatCents } from "./format";
import { findLeaks, maskText, StockAliases, type MaskLookup, EMPTY_LOOKUP } from "./mask";

export type MaskedReview = {
  notice: string;
  summary: string[];
  orders: string[];
  narrative: Array<{ heading: string; items: string[] }>;
  alerts: string[];
  health: string[];
};

export const MASKED_REVIEW_NOTICE =
  "Stock names, prices and links are hidden for your access level. The Owner can unmask them.";

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Parses stored facts_json; null if it is not an object (the page then says it is unavailable). */
export function parseFacts(json: string): ReviewFacts | null {
  try {
    const v: unknown = JSON.parse(json);
    return isObj(v) ? (v as unknown as ReviewFacts) : null;
  } catch {
    return null;
  }
}

/** Every stock code that appears in the structured facts (the caller adds the date's signals and alerts). */
export function factCodes(facts: ReviewFacts): string[] {
  const out: string[] = [];
  for (const o of arr(facts.orders)) if (isObj(o) && typeof o.code === "string") out.push(o.code);
  for (const a of arr(facts.alerts)) if (isObj(a) && typeof a.code === "string") out.push(a.code);
  return out;
}

export function maskedReview(
  facts: ReviewFacts,
  aliases: StockAliases,
  lookup: MaskLookup = EMPTY_LOOKUP,
): MaskedReview {
  const t = (s: string): string => maskText(s, aliases, lookup);

  const summary: string[] = [];
  for (const e of arr(facts.executions)) {
    if (!isObj(e)) continue;
    summary.push(
      `${t(str(e.id))} ${t(str(e.label))}: day profit/loss ${formatCents(num(e.dayPlCents), { currency: str(e.currency) === "AUD" ? "A$" : `${str(e.currency)} `, sign: "always" })}`,
    );
  }
  if (isObj(facts.scorecard)) {
    const sc = facts.scorecard;
    const total = num(sc.totalComponents);
    const healthy = num(sc.healthyComponents);
    if (total !== null && healthy !== null) {
      summary.push(`System health: ${healthy} of ${total} components healthy.`);
    }
  }
  if (typeof facts.minimalReason === "string") summary.push(t(facts.minimalReason));
  if (typeof facts.regimeNotice === "string") summary.push(t(facts.regimeNotice));

  const orders: string[] = [];
  for (const o of arr(facts.orders)) {
    if (!isObj(o)) continue;
    const state = o.state === "filled" ? "filled" : "created";
    orders.push(
      `${t(str(o.executionId))}: ${str(o.side).toUpperCase()} ${aliases.label(str(o.code))}, quantity ${num(o.qty) ?? "n/a"} (${state}). ${t(str(o.reason))}`,
    );
  }

  const narrative: MaskedReview["narrative"] = [];
  if (isObj(facts.narrative)) {
    const n = facts.narrative;
    const sections: Array<[string, unknown]> = [
      ["What was learned today", n.s4],
      ["What worked better and why", n.s5],
      ["What needs improving for tomorrow", n.s6],
    ];
    for (const [heading, items] of sections) {
      narrative.push({
        heading,
        items: arr(items)
          .filter((x) => typeof x === "string")
          .map((x) => t(x as string)),
      });
    }
  }

  const alerts: string[] = [];
  for (const a of arr(facts.alerts)) {
    if (!isObj(a)) continue;
    alerts.push(
      `${str(a.tier)} ${aliases.label(str(a.code))}: ${t(str(a.title))} (${t(str(a.time))}). ${t(str(a.effect))}`,
    );
  }
  for (const b of arr(facts.breakerHits)) {
    if (!isObj(b)) continue;
    alerts.push(`${t(str(b.execution))}: ${t(str(b.breaker))}. ${t(str(b.effect))}`);
  }

  const health: string[] = [];
  for (const h of arr(facts.health)) {
    if (!isObj(h)) continue;
    health.push(`${t(str(h.label))}: ${str(h.status)}. ${t(str(h.detail))}`);
  }

  return { notice: MASKED_REVIEW_NOTICE, summary, orders, narrative, alerts, health };
}

/**
 * Last line of defence before the page renders: true when any code of `codes` or any company name of
 * `names` is still present in the view model. The page then shows "unavailable" instead.
 */
export function reviewLeaks(
  view: MaskedReview,
  codes: Iterable<string>,
  names: Iterable<string> = [],
): boolean {
  return findLeaks(view, codes, names, { caseSensitive: true }).length > 0;
}
