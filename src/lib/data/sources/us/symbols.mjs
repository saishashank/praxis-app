// The exchange symbol directories -> universe candidates (M20 US1; DAT-252, D-1098, D-1132, D-1187). The two public
// directory files (`nasdaqlisted.txt`, `otherlisted.txt`) list every listed issue; the universe holds common-stock
// companies only (like the AU universe, ETFs and structured lines are out): a test issue, an ETF, a warrant, a
// right, a unit, a preferred or a note line is dropped, and so is a symbol that is not a plain ticker. The cap
// (`universe_max`, D-1098) then ranks the candidates by the 60-session MEDIAN TRADED VALUE and keeps the top N, ties by
// code. A candidate with no traded value cannot be ranked and is never kept: with no robots-permitted price source
// (D-1132) the capped universe is EMPTY, honestly, not a list in alphabetical order. Pure.
const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const STRUCTURED_RE =
  /\b(warrants?|rights?|units?|preferred|notes?\s+due|subordinated|depositary\s+shares?)\b/i;
/** Exchange codes of the `otherlisted` file that list operating companies. The Arca and Cboe codes list funds. */
const OTHER_COMPANY_EXCHANGES = new Set(["N", "A"]);

/**
 * @typedef {{ code: string, name: string, listing: "nasdaq" | "other", exchangeCode: string }} Candidate
 */

/** @param {string} text @param {string} firstColumn */
function rowsOf(text, firstColumn) {
  const lines = text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "" && !l.startsWith("File Creation Time"));
  if (lines.length === 0 || !lines[0].startsWith(firstColumn)) return { head: [], rows: [] };
  const head = lines[0].split("|").map((h) => h.trim());
  return { head, rows: lines.slice(1).map((l) => l.split("|")) };
}

/**
 * @param {string} nasdaqText `nasdaqlisted.txt` @param {string} otherText `otherlisted.txt`
 * @returns {{ candidates: Candidate[], dropped: { test: number, etf: number, structured: number, badSymbol: number, exchange: number } }}
 */
export function parseSymbolDirectories(nasdaqText, otherText) {
  const dropped = { test: 0, etf: 0, structured: 0, badSymbol: 0, exchange: 0 };
  /** @type {Candidate[]} */
  const out = [];
  const seen = new Set();
  /** @param {string[]} f @param {Record<string, number>} ix @param {Candidate["listing"]} listing @param {string} sym @param {string} xc */
  const take = (f, ix, listing, sym, xc) => {
    const code = sym.trim().toUpperCase();
    const name = (f[ix.name] ?? "").trim();
    if ((f[ix.test] ?? "").trim() === "Y") return void (dropped.test += 1);
    if ((f[ix.etf] ?? "").trim() === "Y") return void (dropped.etf += 1);
    if (!TICKER_RE.test(code)) return void (dropped.badSymbol += 1);
    if (STRUCTURED_RE.test(name)) return void (dropped.structured += 1);
    if (seen.has(code)) return;
    seen.add(code);
    out.push({ code, name, listing, exchangeCode: xc });
  };
  const n = rowsOf(nasdaqText, "Symbol");
  const nix = {
    name: n.head.indexOf("Security Name"),
    test: n.head.indexOf("Test Issue"),
    etf: n.head.indexOf("ETF"),
  };
  for (const f of n.rows)
    take(f, nix, "nasdaq", f[0] ?? "", (f[n.head.indexOf("Market Category")] ?? "").trim());
  const o = rowsOf(otherText, "ACT Symbol");
  const oix = {
    name: o.head.indexOf("Security Name"),
    test: o.head.indexOf("Test Issue"),
    etf: o.head.indexOf("ETF"),
  };
  const xcol = o.head.indexOf("Exchange");
  for (const f of o.rows) {
    const xc = (f[xcol] ?? "").trim();
    if (!OTHER_COMPANY_EXCHANGES.has(xc)) {
      dropped.exchange += 1;
      continue;
    }
    take(f, oix, "other", f[0] ?? "", xc);
  }
  out.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  return { candidates: out, dropped };
}

/**
 * Keep the top `max` candidates by median traded value (micro-currency, a bigint), ties by code. A candidate without a
 * value is never kept.
 * @param {readonly { code: string }[]} candidates @param {ReadonlyMap<string, bigint>} medianTraded @param {number} max
 * @returns {{ codes: string[], unranked: number }}
 */
export function capUniverse(candidates, medianTraded, max) {
  if (!Number.isInteger(max) || max < 1)
    throw new RangeError("universe_max must be a positive whole number");
  const ranked = candidates.filter((c) => (medianTraded.get(c.code) ?? 0n) > 0n);
  ranked.sort((a, b) => {
    const va = medianTraded.get(a.code) ?? 0n;
    const vb = medianTraded.get(b.code) ?? 0n;
    return va > vb ? -1 : va < vb ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
  });
  return {
    codes: ranked.slice(0, max).map((c) => c.code),
    unranked: candidates.length - ranked.length,
  };
}
