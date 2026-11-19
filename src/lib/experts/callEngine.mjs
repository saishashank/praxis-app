// Structured-call proposals, the rules answer (M22 E3; KB-084, D-1435, D-543). One plain module, because the
// build-machine script (`scripts/experts/call-proposals.mjs`) and the importer are Node scripts that cannot load
// TypeScript (the same reason as the licence engine, D-1470); `callProposals.ts` is its typed face.
//
// `proposeCallStructure(summary, universe, calendar)` reads one stored claim summary (our own words, at most 600
// characters) and looks for one listed stock code, a direction word, a date and a horizon. It is deterministic, opens
// no database, makes no request and runs no model. The summary is third-party in origin, so it is only ever MATCHED:
// nothing in it is executed, followed or copied into a field (a code must be in the universe, a date must be a real
// date, a number must be a number). A proposal is never a call: it is tracked only after the Owner confirms it.
//
// A model answer (when a role is live) is accepted only through `parseModelAnswer`: it must have the answer shape
// and every value it fills must be one the summary itself contains, so a model can pick between grounded candidates
// (two codes, two dates) but can never add a value the text does not hold.

export const CALL_FIELDS = Object.freeze(["code", "direction", "date", "horizon"]);
/** Plain words for each field, for the Owner-read reason. */
export const FIELD_WORDS = Object.freeze({
  code: "stock",
  direction: "direction",
  date: "date",
  horizon: "horizon",
});

const MAX_TEXT = 1000; // threshold-ok: the text read; claim summaries are at most 600 characters
const MAX_HORIZON = 1000; // threshold-ok: longest horizon kept, in sessions (about four years)
const DAYS_PER_WEEK = 7; // threshold-ok: calendar days in a week
const DAYS_PER_MONTH = 30; // threshold-ok: calendar days counted for "a month" in a horizon phrase
const REASON_MAX = 200; // threshold-ok: expert_call_proposal.reason cap (0042)
const SCALE_DIGITS = 6; // threshold-ok: micro units are millionths

const LONG_WORDS =
  /\b(?:buy|buying|long|bullish|accumulate|overweight|outperform\w*|upside|rally|rallies|rise|rises|higher|increase\w*)\b/i;
const SHORT_WORDS =
  /\b(?:sell|selling|short|shorting|bearish|underweight|underperform\w*|downside|fall|falls|decline\w*|lower|drop\w*|decrease\w*)\b/i;
/** Index and macro targets (D-543): a call about these has no single listed code to track. */
const INDEX_WORDS =
  /\b(?:index|indices|indexes|benchmark|inflation|interest rates?|cash rate|bond yields?|yield curve|currency|exchange rate|gdp|unemployment|central bank|recession|commodit(?:y|ies)|the market|whole market|broad market)\b/i;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE =
  "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

const pad = (n, w) => String(n).padStart(w, "0");

/** A real calendar date as YYYY-MM-DD, or null. */
function isoDate(y, m, d) {
  if (!(y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null; // threshold-ok: year and month-day bounds of a plausible date
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
}
const monthNo = (w) => MONTHS.indexOf(w.slice(0, 3).toLowerCase()) + 1;

/** Every distinct real date the text states: ISO, "10 Jan 2030" and "Jan 10, 2030". */
export function datesIn(text) {
  const found = new Set();
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const v = isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
    if (v) found.add(v);
  }
  for (const m of text.matchAll(
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE}\\.?,?\\s+(\\d{4})\\b`, "gi"),
  )) {
    const v = isoDate(Number(m[3]), monthNo(m[2]), Number(m[1]));
    if (v) found.add(v);
  }
  for (const m of text.matchAll(
    new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "gi"),
  )) {
    const v = isoDate(Number(m[3]), monthNo(m[1]), Number(m[2]));
    if (v) found.add(v);
  }
  return [...found].sort();
}

/** Every distinct horizon phrase: a number and a unit word. */
export function horizonsIn(text) {
  const seen = new Map();
  for (const m of text.matchAll(
    /\b(\d{1,3})[\s-]*(sessions?|trading[\s-]+days?|days?|weeks?|months?)\b/gi,
  )) {
    const w = m[2].toLowerCase();
    const unit =
      w.startsWith("session") || w.startsWith("trading")
        ? "sessions"
        : w.startsWith("day")
          ? "days"
          : w.startsWith("week")
            ? "weeks"
            : "months";
    const n = Number(m[1]);
    if (n >= 1) seen.set(`${n}|${unit}`, { n, unit });
  }
  return [...seen.values()];
}

/** Capitalised tokens that could be a code (two or more characters); the caller checks them against the universe. */
export function candidateCodes(text) {
  const out = new Set();
  for (const m of String(text)
    .slice(0, MAX_TEXT)
    .matchAll(/(?<![A-Za-z0-9.$])\$?([A-Z][A-Z0-9]{1,5}(?:\.[A-Z]{1,2})?)(?![A-Za-z0-9])/g))
    out.add(m[1]);
  return [...out].sort();
}

/** A decimal price as micro units, or null (not a positive number). */
export function priceMicro(text) {
  const m = /^(\d{1,9})(?:\.(\d{1,6}))?$/.exec(text);
  if (!m) return null;
  const v = Number(m[1]) * 10 ** SCALE_DIGITS + Number((m[2] ?? "").padEnd(SCALE_DIGITS, "0"));
  return v > 0 && Number.isSafeInteger(v) ? v : null;
}
const levelAfter = (text, re) => {
  const m = re.exec(text);
  return m ? priceMicro(m[1]) : null;
};

const asSet = (codes) => (codes instanceof Set ? codes : new Set(codes ?? []));

/** The facts the text holds, before any decision. */
export function extractFacts(summary, universe) {
  const text = String(summary ?? "").slice(0, MAX_TEXT);
  const codes = asSet(universe.codes);
  const found = candidateCodes(text).filter((c) => codes.has(c));
  const names = (universe.indexNames ?? [])
    .map((n) => String(n).toLowerCase())
    .filter((n) => n !== "");
  const lower = text.toLowerCase();
  return {
    codes: found,
    long: LONG_WORDS.test(text),
    short: SHORT_WORDS.test(text),
    dates: datesIn(text),
    horizons: horizonsIn(text),
    open: /\b(?:at|on) the open\b|\bopening (?:price|auction)\b/i.test(text),
    close: /\b(?:at|on) the close\b|\bclosing price\b|\bend[- ]of[- ]day\b|\bat close\b/i.test(
      text,
    ),
    target: levelAfter(text, /\btarget(?: price)?\s*(?:of|at|:)?\s*(\d+(?:\.\d{1,6})?)/i),
    stop: levelAfter(text, /\bstop(?:[- ]loss)?\s*(?:of|at|:)?\s*(\d+(?:\.\d{1,6})?)/i),
    indexLike: INDEX_WORDS.test(text) || names.some((n) => lower.includes(n)),
  };
}

const isWeekend = (d) => {
  const w = new Date(`${d}T00:00:00Z`).getUTCDay();
  return w === 0 || w === 6;
};
const addDays = (d, n) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10); // threshold-ok: milliseconds in a day

/** Trading sessions after `from` up to `from + days`: weekdays that are not holiday rows of the calendar. */
export function sessionsAfter(from, days, calendar) {
  const holidays = new Set((calendar ?? []).filter((r) => r.kind === "holiday").map((r) => r.d));
  let n = 0;
  for (let i = 1; i <= days; i += 1) {
    const d = addDays(from, i);
    if (!isWeekend(d) && !holidays.has(d)) n += 1;
  }
  return n;
}

/** Horizon in sessions, or null when it cannot be worked out (a calendar span with no date). */
export function horizonSessions(h, callD, calendar) {
  if (!h) return null;
  let n = null;
  if (h.unit === "sessions") n = h.n;
  else if (callD) {
    const days =
      h.unit === "days" ? h.n : h.unit === "weeks" ? h.n * DAYS_PER_WEEK : h.n * DAYS_PER_MONTH;
    n = sessionsAfter(callD, days, calendar);
  }
  return n !== null && n >= 1 && n <= MAX_HORIZON ? n : null;
}

const list = (words) =>
  words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;

/**
 * The decision step. `pick` holds the chosen values (or null where there is none or it is ambiguous); `amb` names the
 * fields whose candidates were several. Pure.
 */
function finish(market, pick, amb, facts, calendar, source) {
  const base = {
    market,
    code: pick.code ?? null,
    direction: pick.direction ?? null,
    callD: pick.date ?? null,
    horizonSessions: horizonSessions(pick.horizon ?? null, pick.date ?? null, calendar),
    priceBasis:
      facts.open && !facts.close ? "open" : facts.close && !facts.open ? "close" : "unspecified",
    targetMicro: facts.target,
    stopMicro: facts.stop,
    source,
  };
  if (base.code === null && amb.code !== true && facts.indexLike) {
    return {
      ...base,
      state: "not_trackable",
      missing: [],
      reason:
        "The call is about an index or a market-wide measure, so it is not followed as a stock call.",
    };
  }
  const missing = [];
  if (base.code === null) missing.push("code");
  if (base.direction === null) missing.push("direction");
  if (base.callD === null) missing.push("date");
  if (base.horizonSessions === null) missing.push("horizon");
  if (missing.length === 0) {
    return {
      ...base,
      state: "complete",
      missing,
      reason: "Stock, direction, date and horizon are all stated in the summary.",
    };
  }
  const words = missing.map((f) =>
    amb[f] === true ? `${FIELD_WORDS[f]} (the summary gives several)` : FIELD_WORDS[f],
  );
  return {
    ...base,
    state: "incomplete",
    missing,
    reason: `Not clear from the summary: ${list(words)}.`.slice(0, REASON_MAX),
  };
}

/**
 * The rules answer. `universe` is `{ market, codes, indexNames? }` (the active codes among the candidates of the text);
 * `calendar` is the market's calendar rows (holidays); both may be empty. Returns a proposal of state `complete`,
 * `incomplete` (with the missing fields) or `not_trackable` (index or macro target, D-543).
 */
export function proposeCallStructure(summary, universe, calendar = []) {
  const f = extractFacts(summary, universe);
  const amb = {
    code: f.codes.length > 1,
    direction: f.long && f.short,
    date: f.dates.length > 1,
    horizon: f.horizons.length > 1,
  };
  const pick = {
    code: f.codes.length === 1 ? f.codes[0] : null,
    direction: f.long !== f.short ? (f.long ? "long" : "short") : null,
    date: f.dates.length === 1 ? f.dates[0] : null,
    horizon: f.horizons.length === 1 ? f.horizons[0] : null,
  };
  return finish(universe.market, pick, amb, f, calendar, "rules");
}

/** The answer shape asked of a model (schema subset of `src/lib/llm/jsonSchema.ts`). */
export const CALL_ANSWER_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    code: { type: "string", maxLength: 32 },
    direction: { type: "string", enum: ["long", "short", "none"] },
    date: { type: "string", maxLength: 10 },
    horizon_n: { type: "integer" },
    horizon_unit: { type: "string", enum: ["sessions", "days", "weeks", "months", "none"] },
    price_basis: { type: "string", enum: ["close", "open", "unspecified"] },
  },
  required: ["code", "direction", "date", "horizon_n", "horizon_unit", "price_basis"],
  additionalProperties: false,
});

/** The rules answer in the shape of a model answer: the value the router returns when no model is live. */
export function answerOf(p, facts) {
  return {
    code: p.code ?? "",
    direction: p.direction ?? "none",
    date: p.callD ?? "",
    horizon_n: facts?.horizons?.length === 1 ? facts.horizons[0].n : 0,
    horizon_unit: facts?.horizons?.length === 1 ? facts.horizons[0].unit : "none",
    price_basis: p.priceBasis,
  };
}

/** The rules answer for the router's `rules` field, as a model-shaped answer. */
export function rulesAnswer(summary, universe, calendar = []) {
  return answerOf(
    proposeCallStructure(summary, universe, calendar),
    extractFacts(summary, universe),
  );
}

/**
 * A model answer, or null. Null when it is not the answer shape or when any value it fills is not one the summary
 * holds (a code that is not named in the text and listed, a date or a horizon the text does not state, a direction
 * the text has no word for). A grounded answer is finished by the same rules as the deterministic one.
 */
export function parseModelAnswer(summary, json, universe, calendar = []) {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return null;
  const keys = Object.keys(json).sort().join(",");
  if (keys !== "code,date,direction,horizon_n,horizon_unit,price_basis") return null;
  const { code, direction, date, horizon_n: n, horizon_unit: unit, price_basis: basis } = json;
  if (typeof code !== "string" || typeof date !== "string" || !Number.isInteger(n)) return null;
  if (!["long", "short", "none"].includes(direction)) return null;
  if (!["sessions", "days", "weeks", "months", "none"].includes(unit)) return null;
  if (!["close", "open", "unspecified"].includes(basis)) return null;
  const f = extractFacts(summary, universe);
  if (code !== "" && !f.codes.includes(code)) return null;
  if (direction === "long" && !f.long) return null;
  if (direction === "short" && !f.short) return null;
  if (date !== "" && !f.dates.includes(date)) return null;
  let horizon = null;
  if (n !== 0 || unit !== "none") {
    if (n < 1 || unit === "none") return null;
    horizon = f.horizons.find((h) => h.n === n && h.unit === unit) ?? null;
    if (horizon === null) return null;
  }
  if (basis === "open" && !f.open) return null;
  if (basis === "close" && !f.close) return null;
  const pick = {
    code: code || null,
    direction: direction === "none" ? null : direction,
    date: date || null,
    horizon,
  };
  const p = finish(universe.market, pick, {}, f, calendar, "model");
  return p.state === "not_trackable" ? null : { ...p, priceBasis: basis };
}
