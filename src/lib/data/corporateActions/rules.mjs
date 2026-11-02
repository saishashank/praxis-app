// Corporate action rules (M2 T8): pure functions for DAT-220 (types), DAT-221 (detection,
// auto-confirm, the Owner queue, the 5-session rule), DAT-222 (adjustment factors) and DAT-223
// (entitlement offers). Plain ESM + JSDoc so the Actions CLI runs it without a TS build, like
// ../quality/rules.mjs. No database, no clock, no network. Synthetic data only in tests (SEC-110).
//
// Verbatim quotes (grep -n; spec/ and docs/M2_design.md):
//
// spec/06_data_layer.md:92 DAT-220:
//   "Types: cash dividend (amount, ex-date, pay date, franking % for AU), special dividend, split,
//   consolidation, bonus issue, renounceable and non-renounceable rights/entitlements,
//   spin-off/demerger, merger/takeover (cash and scrip), code/name change, delisting (with reason:
//   takeover, administration/liquidation, voluntary, other)."
// spec/06_data_layer.md:93 DAT-221 (the 5-session rule is its last two sentences):
//   "Detection = announcements + source fields + unexplained-jump check. An action is
//   **auto-confirmed** when a structured announcement (e.g. Appendix 3A.1, reorganisation notice)
//   and the price/vendor data agree. Only **conflicts on held or candidate codes** go to the Owner
//   review queue (Settings → Data, UX-114) as plain-language cards; conflicts on other codes are
//   simply blocked for entry. A queued item unresolved after 5 sessions is applied using the
//   best-evidence interpretation and flagged. **(s13)** If a code with an unresolved queued
//   conflict becomes held or a candidate, the item moves to the Owner review queue immediately and
//   the 5-session auto-apply timer restarts."
// spec/06_data_layer.md:94 DAT-222:
//   "Until resolved: affected codes blocked for entries, cohorts flagged; resolution recomputes
//   factors and positions from the event date (reproducible)."
// spec/06_data_layer.md:95 DAT-223:
//   "Entitlement offers are not taken up: **non-renounceable** — no compensation (holding simply
//   dilutes via price); **renounceable** — rights valued at their last traded price if traded,
//   else zero. Scrip mergers convert to the acquirer if listed in the same market, else cash at
//   the last price. Administrations/liquidations per ARN-026."
// spec/06_data_layer.md:73 DAT-126 (reversal; "a reversal is a new event row, never an edit" is
//   the T8 brief's reading of it; the spec text is):
//   "Vendor history is split-adjusted; for replays, as-of-D raw prices are reconstructed by
//   reversing vendor split events **cross-checked against announcement titles** (consolidations,
//   splits); mismatches flag the code. Indicators use only adjustment factors with ex-date ≤ D;
//   tier, tick, parcel and stop computations use raw prices; historical dividends come from vendor
//   dividend events (labelled). A golden test includes a consolidation (TST-102)."
// spec/06_data_layer.md:10 DAT-002 (factors come only from recorded actions):
//   "Prices are stored raw; adjustment factors are derived **only from recorded corporate actions**
//   (DAT-220), never from a vendor's adjusted series."
// spec/06_data_layer.md:120 (status table):
//   "| corporate_action | detected → confirmed \| edited \| rejected (Owner) |"
// spec/14_system_acceptance.md:21 AT-08 (the only golden-case text; it gives no numbers):
//   "| AT-08 | Corporate actions | Golden split, consolidation, dividend, rights issue and delisting
//   produce no artificial P/L; unconfirmed action appears in review queue and blocks entries |
//   DAT-220…223 |"
// spec/06_data_layer.md:132 (acceptance, chapter 06):
//   "**Given** a 1-for-2 split, **then** no artificial P/L and a recorded adjustment factor
//   (DAT-222)."
// spec/05_paper_trading_arena.md:69 ARN-036 (dividends are cash, not a price adjustment):
//   "A position held **at the close of the session before the ex-date** is entitled; from the
//   ex-date NAV includes the dividend receivable; cash on the pay date; franking recorded
//   separately, excluded from NAV. Other corporate actions per DAT-220…223."
// spec/11_ops_runbook.md:18 (what lands in the queue):
//   "Review corporate actions in the queue — only **conflicts** between sources land there;
//   single-source actions consistent with the price series are auto-confirmed (DAT-221)"
// spec/09_ui_ux.md:113 UX-114:
//   "Data review queue (Owner): unconfirmed corporate actions (DAT-221) with evidence and
//   confirm/edit/reject."
// docs/M2_design.md:165 (the T8 row):
//   "| T8 | Corporate actions: capture, auto-confirm, review queue, factors, 5-session rule |
//   `src/lib/data/corporateActions/*`, review-queue page | AT-08 goldens; DAT-126 reversal |
//   Resolve queued items |"
// docs/M2_design.md:43 (tables): "append-only; recompute adds rows (DAT-222)" for adjustment_factor
//   and "append-only (status history, no UPDATE)" for corporate_action_event.
//
// Ch.15 (spec/15_configuration_reference.md) has no corporate-action key. The two keys this task
// adds (corporate_action_auto_apply_sessions, corporate_action_price_tolerance) are spec gaps
// recorded in keys.ts; the defaults are mirrored below.
//
// Choices made where the spec is silent (proposed D-064, for the architect to record):
// - Numeric approach: a factor is an exact rational (BigInt numerator / denominator) built from
//   the integer ratio in the payload. Goldens compare the exact fraction and a fixed 12-decimal
//   string. The `adjustment_factor.factor` column is REAL, so the stored value is the nearest
//   IEEE double to the exact fraction (numerator / denominator of two integers below 2^53 is
//   correctly rounded by IEEE division).
// - Direction: a factor f multiplies RAW prices dated BEFORE the ex-date to make them comparable
//   with prices on and after it (adjusted = raw x product of f for actions with ex-date > the
//   bar's date; volume is divided by the same product). f = old / new for a split or a
//   consolidation (1 new for 10 old: f = 10; 2 new for 1 old: f = 1/2); f = old / (old + new) for
//   a bonus issue.
// - Cash dividends, special dividends, rights (DAT-223: "holding simply dilutes via price"), code
//   or name changes, mergers and delistings do not adjust prices: f = 1. Their cash effects are
//   the simulator's (ARN-036, DAT-223, ARN-026). A spin-off adjusts only when its announcement
//   states the retained value fraction (payload.retained = {num, den}); otherwise its factor is
//   unknown and it always goes to the Owner.
// - "Agree": the available sources (announcement, vendor field) carry the same type and ratio and
//   the observed ex-date price move matches the factor within corporate_action_price_tolerance.
//   One source is enough when the price agrees (ch.11: "single-source actions consistent with the
//   price series are auto-confirmed"). Different ratios, a price that contradicts the ratio, or a
//   price jump with no announcement and no vendor field are conflicts. Types that do not adjust
//   prices need no price check.
// - Best evidence (the 5-session rule): the interpretation with the highest score: price
//   consistent +100, announcement +10, vendor +5, price-inferred +1. Ties go to the lower id.
// - "5 sessions": the number of trading sessions strictly after the session the item was queued
//   on, up to and including today. The item is applied when that number is >= 5, so queued on
//   Monday it is applied by the batch of the following Monday.
// - Statuses: the table only allows auto_confirmed / queued / applied_best_evidence / resolved.
//   The queue kind (pending price evidence / Owner queue / blocked only) and the Owner's decision
//   are JSON in the event `note`: {d, queue} for `queued`, {d, resolution} for `resolved`.

import { addDays, isRealDate, isValidCode, tradingDaysBetween } from "../pipeline/rules.mjs";

/** ch.15 gaps (keys.ts): corporate_action_auto_apply_sessions and corporate_action_price_tolerance. */
export const DEFAULT_AUTO_APPLY_SESSIONS = 5;
export const DEFAULT_PRICE_TOLERANCE_PCT = 10;

/** DAT-220 types. */
export const TYPES = [
  "cash_dividend",
  "special_dividend",
  "split",
  "consolidation",
  "bonus_issue",
  "rights_renounceable",
  "rights_non_renounceable",
  "spin_off",
  "merger_cash",
  "merger_scrip",
  "code_change",
  "delisting",
];

/** Types whose announcement is checked against the ex-date price move. */
export const PRICE_TYPES = ["split", "consolidation", "bonus_issue"];
/** Candidate sources; `price` is the unexplained-jump check. */
export const SOURCES = ["announcement", "vendor", "price"];
const SOURCE_WEIGHT = { announcement: 10, vendor: 5, price: 1 };
const PRICE_CONSISTENT_BONUS = 100;
/** The price-inferred ratio is only offered for clean whole-number ratios up to this. */
export const MAX_INFERRED_RATIO = 100;
const MAX_RATIO_PART = 1_000_000;
const MAX_PAYLOAD_CHARS = 2000;

export const isQuantityType = (type) => PRICE_TYPES.includes(type);

/**
 * DAT-233 (D-237) kind of an adjustment factor: `split` changes the share count (split,
 * consolidation, bonus issue); every other factor is a `price` factor (dividends, spin-off, ...).
 * A legacy row with no stored kind takes its kind from the action type.
 * @param {string} type @returns {"price" | "split"}
 */
export const factorKindOf = (type) => (isQuantityType(type) ? "split" : "price");

/**
 * DAT-233: a price factor is used only when the reference close it was computed from still equals the
 * raw close of the session before the ex-date. A missing stored reference (legacy row) matches.
 * @param {number | null | undefined} stored @param {number | null | undefined} current
 */
export const refCloseMatches = (stored, current) =>
  stored === null || stored === undefined || current === null || current === undefined
    ? true
    : stored === current;
/** Group class: split, consolidation and bonus issue share one class (they cannot co-occur). */
export const classOf = (type) => (isQuantityType(type) ? "price" : type);

// ---------------------------------------------------------------------------------------------
// Exact rationals (BigInt). Positive, normalised.

/** @typedef {{ n: bigint, d: bigint }} Ratio */

const gcd = (a, b) => (b === 0n ? a : gcd(b, a % b));

/** @param {bigint | number} n @param {bigint | number} d @returns {Ratio} */
export function ratio(n, d) {
  const a = BigInt(n);
  const b = BigInt(d);
  if (b <= 0n || a <= 0n) throw new RangeError("ratio needs positive parts");
  const g = gcd(a, b);
  return { n: a / g, d: b / g };
}

/** Exact product. @param {Ratio} a @param {Ratio} b */
export const ratioMul = (a, b) => ratio(a.n * b.n, a.d * b.d);

/** The nearest double: both parts below 2^53 divide with a single correct rounding. @param {Ratio} r */
export function ratioToNumber(r) {
  const limit = BigInt(Number.MAX_SAFE_INTEGER);
  if (r.n <= limit && r.d <= limit) return Number(r.n) / Number(r.d);
  return Number(ratioToDecimal(r, 15)); // never reached for payload ratios (parts <= 10^6)
}

/** Fixed-precision decimal text, rounded half up on the exact value. @param {Ratio} r */
export function ratioToDecimal(r, places = 12) {
  const scale = 10n ** BigInt(places);
  const scaled = (r.n * scale * 2n + r.d) / (r.d * 2n); // round half up
  const s = scaled.toString().padStart(places + 1, "0");
  const whole = s.slice(0, s.length - places);
  return places === 0 ? whole : `${whole}.${s.slice(s.length - places)}`;
}

// ---------------------------------------------------------------------------------------------
// Payloads, validation, canonical JSON.

const isPosInt = (v) => Number.isSafeInteger(v) && v >= 1 && v <= MAX_RATIO_PART;

/** Deterministic JSON (sorted keys) so equal payloads compare equal as text. */
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Why a payload is unusable for the type, or null. @param {string} type @param {any} p */
export function payloadProblem(type, p) {
  if (p === null || typeof p !== "object" || Array.isArray(p)) return "payload_not_object";
  if (canonicalJson(p).length > MAX_PAYLOAD_CHARS) return "payload_too_large";
  if (isQuantityType(type)) {
    if (!isPosInt(p.new) || !isPosInt(p.old)) return "ratio_invalid";
    if (type === "split" && !(p.new > p.old)) return "split_needs_more_shares";
    if (type === "consolidation" && !(p.new < p.old)) return "consolidation_needs_fewer_shares";
  }
  if (type === "spin_off" && p.retained !== undefined) {
    const r = p.retained;
    if (!r || !isPosInt(r.num) || !isPosInt(r.den) || r.num > r.den) return "retained_invalid";
  }
  return null;
}

/**
 * DAT-222 factor as an exact rational, or null when it cannot be known (spin-off without a stated
 * retained fraction).
 * @param {string} type @param {any} p @returns {Ratio | null}
 */
export function factorFor(type, p) {
  switch (type) {
    case "split":
    case "consolidation":
      return ratio(p.old, p.new);
    case "bonus_issue":
      return ratio(p.old, p.old + p.new);
    case "spin_off":
      return p.retained ? ratio(p.retained.num, p.retained.den) : null;
    default:
      return ratio(1, 1);
  }
}

/**
 * DAT-223 cash compensation per share held when an entitlement offer is not taken up, as an exact
 * rational of dollars (0/1 is represented by n = 0n, so this returns a plain object).
 * Non-renounceable: none. Renounceable: rights per share x last traded rights price, else zero.
 * payload: { rights: {new, old}, last_price_cents?: integer }.
 * @param {string} type @param {any} p @returns {{ n: bigint, d: bigint }}
 */
export function entitlementCompensation(type, p) {
  const zero = { n: 0n, d: 1n };
  if (type !== "rights_renounceable") return zero;
  const traded = p && Number.isSafeInteger(p.last_price_cents) && p.last_price_cents > 0;
  if (!traded || !p.rights || !isPosInt(p.rights.new) || !isPosInt(p.rights.old)) return zero;
  const r = ratio(BigInt(p.rights.new) * BigInt(p.last_price_cents), BigInt(p.rights.old) * 100n);
  return r;
}

/**
 * Validate and normalise one capture candidate.
 * @param {any} c { code, type, ex_date, record_date?, payload, source, ref? }
 * @returns {{ ok: true, value: { code: string, type: string, ex_date: string, record_date: string | null,
 *   payload: any, source: string, ref: string | null } } | { ok: false, reason: string }}
 */
export function validateCandidate(c) {
  if (!c || typeof c !== "object") return { ok: false, reason: "not_object" };
  if (!isValidCode(c.code)) return { ok: false, reason: "bad_code" };
  if (!TYPES.includes(c.type)) return { ok: false, reason: "bad_type" };
  if (!isRealDate(c.ex_date)) return { ok: false, reason: "bad_ex_date" };
  if (c.record_date != null && !isRealDate(c.record_date)) return { ok: false, reason: "bad_date" };
  if (!SOURCES.includes(c.source)) return { ok: false, reason: "bad_source" };
  const payload = c.payload ?? {};
  const problem = payloadProblem(c.type, payload);
  if (problem) return { ok: false, reason: problem };
  return {
    ok: true,
    value: {
      code: c.code,
      type: c.type,
      ex_date: c.ex_date,
      record_date: c.record_date ?? null,
      payload: JSON.parse(canonicalJson(payload)),
      source: c.source,
      ref: typeof c.ref === "string" ? c.ref.slice(0, 80) : null,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Price evidence.

/** @param {{ prevClose: number, exClose: number }} price */
export const observedRatio = (price) => price.exClose / price.prevClose;

/**
 * Does the observed ex-date close-to-close ratio match the factor within the tolerance?
 * A split 2-for-1 has factor 1/2 and a price that halves (observed about 0.5).
 * @param {number} observed @param {Ratio} factor @param {number} tolerancePct
 */
export function priceConsistent(observed, factor, tolerancePct) {
  if (!(observed > 0) || !Number.isFinite(observed)) return false;
  const expected = ratioToNumber(factor);
  return Math.abs(observed / expected - 1) <= tolerancePct / 100;
}

/**
 * The unexplained-jump check's interpretation: the clean whole-number split or consolidation that
 * the observed ratio matches within the tolerance, else null.
 * @param {number} observed @param {number} tolerancePct
 * @returns {{ type: "split" | "consolidation", payload: { new: number, old: number } } | null}
 */
export function inferRatio(observed, tolerancePct) {
  if (!(observed > 0) || !Number.isFinite(observed)) return null;
  if (observed < 1) {
    const n = Math.round(1 / observed);
    if (n < 2 || n > MAX_INFERRED_RATIO) return null;
    return priceConsistent(observed, ratio(1, n), tolerancePct)
      ? { type: "split", payload: { new: n, old: 1 } }
      : null;
  }
  const n = Math.round(observed);
  if (n < 2 || n > MAX_INFERRED_RATIO) return null;
  return priceConsistent(observed, ratio(n, 1), tolerancePct)
    ? { type: "consolidation", payload: { new: 1, old: n } }
    : null;
}

// ---------------------------------------------------------------------------------------------
// DAT-221 evaluation of one (code, ex-date, class) group.

/**
 * GL-01: a candidate seen only in prices (no announcement, no vendor record) is an inference. It
 * is never auto-applied, also not by the 5-session rule; the Owner resolves it.
 * @param {readonly string[]} sources
 */
export const isPriceOnly = (sources) => sources.length > 0 && sources.every((s) => s === "price");

/**
 * GL-01 Yahoo adjusted-close veto: a genuine split or consolidation is back-adjusted by the vendor,
 * so the adjusted close does not jump across the ex-date (ratio near 1). A ratio that is not near
 * 1 means the vendor sees a real price move and disagrees with the inferred factor. No data
 * (null/absent/unusable) never vetoes.
 * @param {{ prevAdj: number, exAdj: number } | null | undefined} adj @param {number} tolerancePct
 */
export function adjCloseDisagrees(adj, tolerancePct) {
  if (!adj || !(adj.prevAdj > 0) || !(adj.exAdj > 0)) return false;
  if (!Number.isFinite(adj.prevAdj) || !Number.isFinite(adj.exAdj)) return false;
  return Math.abs(adj.exAdj / adj.prevAdj - 1) > tolerancePct / 100;
}

/** @param {string[]} sources @param {boolean} consistent */
export function evidenceScore(sources, consistent) {
  let s = consistent ? PRICE_CONSISTENT_BONUS : 0;
  for (const src of new Set(sources)) s += SOURCE_WEIGHT[src] ?? 0;
  return s;
}

/**
 * @typedef {{ id: number, type: string, payload: any, sources: string[] }} GroupAction
 * @typedef {{ id: number, outcome: "auto_confirm" | "conflict", reasons: string[], score: number }} Decision
 */

/**
 * Decide a group of actions that describe the same code and ex-date.
 * - `price` is null when the ex-date bar (or the bar before it) is not stored yet: a price-type
 *   group is then "pending" (nothing is decided and nothing blocks; the ex-date itself is when the
 *   price first matters).
 * - `hasEffective`: another action of the group is already confirmed, so this one can only be a
 *   conflict.
 * @param {{ actions: GroupAction[], price: { prevClose: number, exClose: number } | null,
 *   tolerancePct?: number, hasEffective?: boolean,
 *   adj?: { prevAdj: number, exAdj: number } | null }} i
 * @returns {{ pending: true } | { pending: false, observed: number | null, decisions: Decision[] }}
 */
export function evaluateGroup(i) {
  const tol = i.tolerancePct ?? DEFAULT_PRICE_TOLERANCE_PCT;
  const priceClass = i.actions.some((a) => isQuantityType(a.type));
  if (priceClass && !i.price) return { pending: true };
  const observed = priceClass && i.price ? observedRatio(i.price) : null;
  const several = i.actions.length > 1 || i.hasEffective === true;
  const decisions = i.actions.map((a) => {
    const reasons = [];
    const factor = factorFor(a.type, a.payload);
    const consistent =
      observed !== null && factor !== null && priceConsistent(observed, factor, tol);
    if (several) reasons.push(i.hasEffective ? "conflicts_with_confirmed" : "sources_disagree");
    if (isPriceOnly(a.sources)) {
      reasons.push("unexplained_jump");
      // GL-01 vetoes: a vendor record for the same date with other terms, or a Yahoo adjusted
      // close that does not show a back-adjusted jump. Both are no-ops when the evidence is absent.
      const vendorOther = i.actions.some(
        (o) => o.id !== a.id && o.sources.includes("vendor") && isQuantityType(o.type),
      );
      if (vendorOther) reasons.push("vendor_disagrees");
      if (adjCloseDisagrees(i.adj, tol)) reasons.push("adj_close_disagrees");
    }
    if (factor === null) reasons.push("factor_unknown");
    if (priceClass && factor !== null && !consistent) reasons.push("price_mismatch");
    return {
      id: a.id,
      outcome: reasons.length === 0 ? "auto_confirm" : "conflict",
      reasons,
      score: evidenceScore(a.sources, consistent),
    };
  });
  return { pending: false, observed, decisions };
}

// ---------------------------------------------------------------------------------------------
// Status from the event history.

/**
 * @typedef {"none" | "pending" | "owner" | "blocked" | "confirmed" | "rejected" | "reversed"} State
 */

/** Parse an event note; anything unreadable is an empty note. @param {string | null | undefined} note */
export function parseNote(note) {
  if (!note) return {};
  try {
    const v = JSON.parse(note);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/**
 * Current state from the NEWEST event row (the table has no UPDATE; the newest row wins).
 * A `queued` row without a readable queue kind is treated as an Owner-queue item: showing the
 * Owner something is the safe reading.
 * @param {{ status: string, note?: string | null } | null | undefined} event
 * @returns {{ state: State, d: string | null }}
 */
export function stateOf(event) {
  if (!event) return { state: "none", d: null };
  const note = parseNote(event.note);
  const d = typeof note.d === "string" ? note.d : null;
  switch (event.status) {
    case "auto_confirmed":
    case "applied_best_evidence":
      return { state: "confirmed", d };
    case "resolved":
      if (note.resolution === "confirmed") return { state: "confirmed", d };
      if (note.resolution === "reversed") return { state: "reversed", d };
      return { state: "rejected", d }; // rejected, superseded, or unreadable
    case "queued":
      if (note.queue === "pending") return { state: "pending", d };
      if (note.queue === "blocked") return { state: "blocked", d };
      return { state: "owner", d };
    default:
      return { state: "rejected", d };
  }
}

/** States that adjust prices. */
export const isEffective = (state) => state === "confirmed";
/** States that block entries (DAT-222): detected and not yet resolved. */
export const isUnresolved = (state) => state === "owner" || state === "blocked";

// ---------------------------------------------------------------------------------------------
// The 5-session rule.

/**
 * Trading sessions strictly after `from`, up to and including `to`.
 * @param {string} from @param {string} to @param {readonly { d: string, kind: string }[]} rows
 */
export function sessionsElapsed(from, to, rows) {
  if (to <= from) return 0;
  return tradingDaysBetween(addDays(from, 1), to, rows).length;
}

/**
 * DAT-221: due when at least `sessions` sessions have passed since the item was queued (or since
 * its timer last restarted).
 * @param {string} queuedOn @param {string} today @param {readonly { d: string, kind: string }[]} rows
 */
export function autoApplyDue(queuedOn, today, rows, sessions = DEFAULT_AUTO_APPLY_SESSIONS) {
  return sessionsElapsed(queuedOn, today, rows) >= sessions;
}

/** The session on which an item queued on `queuedOn` becomes due, or null without calendar rows. */
export function autoApplyDate(queuedOn, rows, sessions = DEFAULT_AUTO_APPLY_SESSIONS) {
  const horizon = addDays(queuedOn, 14 + sessions * 3);
  const days = tradingDaysBetween(addDays(queuedOn, 1), horizon, rows);
  return days.length >= sessions ? days[sessions - 1] : null;
}

/**
 * Pick the action to apply from a group that is due: highest evidence score, then lowest id.
 * @param {{ id: number, score: number }[]} due
 */
export function pickBestEvidence(due) {
  return [...due].sort((a, b) => b.score - a.score || a.id - b.id)[0] ?? null;
}

// ---------------------------------------------------------------------------------------------
// Plain-language text for the Owner card (UX-114).

const TYPE_LABEL = {
  cash_dividend: "cash dividend",
  special_dividend: "special dividend",
  split: "share split",
  consolidation: "share consolidation",
  bonus_issue: "bonus issue",
  rights_renounceable: "renounceable rights offer",
  rights_non_renounceable: "non-renounceable rights offer",
  spin_off: "spin-off or demerger",
  merger_cash: "cash takeover",
  merger_scrip: "scrip merger",
  code_change: "code or name change",
  delisting: "delisting",
};
export const typeLabel = (type) => TYPE_LABEL[type] ?? type;

/** @param {string} type @param {any} p */
export function describeTerms(type, p) {
  if (isQuantityType(type) && p && p.new && p.old) {
    if (type === "bonus_issue") return `${p.new} new share(s) free for every ${p.old} held`;
    return `${p.old} old share(s) become ${p.new} new share(s)`;
  }
  return "no price adjustment";
}

const REASON_TEXT = {
  sources_disagree: "the sources disagree about the terms",
  conflicts_with_confirmed: "it conflicts with an action already confirmed for this date",
  unexplained_jump:
    "only a price jump was seen; no announcement or vendor record, so it is never applied automatically",
  vendor_disagrees: "a vendor split record for this date has different terms",
  adj_close_disagrees: "the vendor adjusted close does not show a split on this date",
  factor_unknown: "the terms needed to compute the adjustment are missing",
  price_mismatch: "the price move does not match the terms",
  ref_close_mismatch:
    "the reference close of the price factor no longer equals the close before the ex-date",
};
export const reasonText = (r) => REASON_TEXT[r] ?? r;
