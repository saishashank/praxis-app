// The first-match category classifier, plain ESM (M20 US1; D-1108, D-1166). The batch-1 CLI runs without a TypeScript
// build and `cortex/profileReaders.ts` (A5) is TypeScript, so the day module cannot import it. This is the same pure
// rule, copied line for line; `tests/markets/us/classifyParity.test.ts` runs both over the 50 labelled fixture items
// and fails on any difference, so the two cannot drift. The map itself is the seed's (`seed/us/categoryMap.mjs`).
const norm = (s) => (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const reCache = new Map();
function re(source) {
  let r = reCache.get(source);
  if (r === undefined) {
    r = new RegExp(source, "i");
    reCache.set(source, r);
  }
  return r;
}

function matches(m, it) {
  if (m.type !== undefined && !norm(it.type).includes(norm(m.type))) return false;
  if (m.item !== undefined) {
    const items = it.item === undefined || it.item === null ? [] : [it.item].flat();
    if (!items.some((i) => norm(i) === norm(m.item))) return false;
  }
  if (m.form !== undefined && norm(it.form) !== norm(m.form)) return false;
  if (m.title_re !== undefined && !re(m.title_re).test(it.title ?? "")) return false;
  return true;
}

/**
 * @param {{ version: string, rows: readonly any[] }} map
 * @param {{ type?: string | null, item?: string | readonly string[] | null, form?: string | null, title?: string | null,
 *           facts?: { statementsParsed?: boolean, valueDisclosed?: boolean, counterpartyDisclosed?: boolean } }} item
 */
export function classifyItem(map, item) {
  const rule = map.rows.findIndex((r) => matches(r.match, item));
  if (rule < 0) throw new RangeError(`category map ${map.version} has no catch-all row`);
  const row = map.rows[rule];
  const f = item.facts ?? {};
  const disclosed = f.valueDisclosed === true && f.counterpartyDisclosed === true;
  let verifiable = false;
  if (row.verifiable)
    verifiable = row.category === "contract" ? disclosed : f.statementsParsed === true;
  const materiality =
    row.category === "contract" && disclosed && row.materiality_disclosed !== undefined
      ? row.materiality_disclosed
      : row.materiality;
  return { category: row.category, materiality, verifiable, mapVersion: map.version, rule };
}
