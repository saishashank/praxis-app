// Shared "leak" helpers of the e2e walks. Pure functions, no Playwright import, so Vitest can read them too
// (tests/acceptance/v3/at68.test.ts runs both against planted HTML).
//
//   modelLeaks   the blueprint walk's check (M16, AT-57 c/d): a prefixed id of the architecture model that no
//                ordinary page prints (D-372). Extracted from e2e/m16-blueprint-walk.spec.ts.
//   marketLeaks  the market-off walk's check (M19, AT-68 c, SEC-112, D-997): a market that is built but not enabled
//                (IN, US) appears nowhere in a rendered page. Looks for the `data-market` attribute of IN or US
//                and for the exchange, city and currency words of those markets as whole words.

/** The model ids found in a page body (at most five, in model order). */
export function modelLeaks(body: string, ids: readonly string[]): string[] {
  return ids.filter((id) => body.includes(id)).slice(0, 5);
}

/** Exchange, city, country and currency words of the markets that are built but off (D-997), searched as whole words. */
export const MARKET_WORDS: readonly string[] = [
  "NSE",
  "BSE",
  "NYSE",
  "Nasdaq",
  "Kolkata",
  "New York",
  "India",
  "United States",
  "IST",
];
/** Currency symbols that are searched as plain text (no word boundary applies to them). */
export const MARKET_SYMBOLS: readonly string[] = ["₹", "US$"];

/** The attribute that names a market: `data-market="IN"`, `data-market='US'` and the flight-data form `"data-market":"IN"`. */
const ATTR = /data-market(?:=|"\s*:\s*)["']?(IN|US)\b/g;

/** Script and style bodies are not page text; the word search skips them (the attribute search does not). */
const withoutCode = (html: string): string =>
  html.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ");

/** The market names found in a rendered page: `data-market="IN"`, then each word or symbol that appears. */
export function marketLeaks(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(ATTR)) out.push(`data-market="${m[1]}"`);
  const text = withoutCode(html);
  for (const w of MARKET_WORDS) {
    if (new RegExp(`(?<![A-Za-z0-9_])${w.replace(/ /g, "\\s+")}(?![A-Za-z0-9_])`).test(text))
      out.push(w);
  }
  for (const s of MARKET_SYMBOLS) if (text.includes(s)) out.push(s);
  return [...new Set(out)];
}

/**
 * The page's HTML with every Owner Markets surface (`data-markets-table`) cut out: the places IN and US may appear —
 * the Markets table of Settings and the Owner's per-market projection card on Usage (D-1099, D-1196).
 */
export function withoutMarketsTable(html: string): string {
  for (let i = 0; i < 16; i++) {
    const next = cutFirstMarketsSurface(html);
    if (next === html) return html;
    html = next;
  }
  return html;
}

function cutFirstMarketsSurface(html: string): string {
  const start = html.indexOf("data-markets-table");
  if (start < 0) return html;
  const open = html.lastIndexOf("<", start);
  const tag = /^<([a-zA-Z0-9]+)/.exec(html.slice(open))?.[1];
  if (!tag) return html;
  // walk the nested tags of the same name to the matching close
  const re = new RegExp(`<(/?)${tag}\\b`, "g");
  re.lastIndex = open;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[1] === "/" ? -1 : 1;
    if (depth === 0) {
      const close = html.indexOf(">", m.index);
      return html.slice(0, open) + html.slice(close + 1);
    }
  }
  return html;
}
