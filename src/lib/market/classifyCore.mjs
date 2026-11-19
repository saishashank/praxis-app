// The announcement classifier and its one writer (M20 A5, moved to plain ESM by IN1 so the market's batch-1 step, which
// runs under plain `node` in Actions with no TypeScript build, can call it; D-1174). Logic is A5's, unchanged: pure and
// first-match (D-1108). `src/lib/cortex/profileReaders.ts` re-exports both, so every TypeScript caller is unchanged.
//
// A row marked `verifiable` is eligible; the item must carry the evidence (CTX-043): results and guidance need parsed
// statements, a contract needs a disclosed value and counterparty (which also lifts it to `materiality_disclosed`).

/** @param {string | null | undefined} s */
const norm = (s) => (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
/** @type {Map<string, RegExp>} */
const reCache = new Map();
/** @param {string} source */
function re(source) {
  let r = reCache.get(source);
  if (r === undefined) {
    r = new RegExp(source, "i");
    reCache.set(source, r);
  }
  return r;
}

/** @param {any} m @param {any} it */
function matches(m, it) {
  if (m.type !== undefined && !norm(it.type).includes(norm(m.type))) return false;
  if (m.item !== undefined) {
    const items = it.item === undefined || it.item === null ? [] : [it.item].flat();
    if (!items.some((/** @type {string} */ i) => norm(i) === norm(m.item))) return false;
  }
  if (m.form !== undefined && norm(it.form) !== norm(m.form)) return false;
  if (m.title_re !== undefined && !re(m.title_re).test(it.title ?? "")) return false;
  return true;
}

/**
 * The category, the AGT-011 materiality and whether the item is verifiable (CTX-043).
 * @param {{ version: string, rows: readonly any[] }} map @param {any} item
 */
export function classify(map, item) {
  const rule = map.rows.findIndex((r) => matches(r.match, item));
  if (rule < 0) throw new RangeError(`category map ${map.version} has no catch-all row`);
  const row = map.rows[rule];
  const f = item.facts ?? {};
  const disclosed = f.valueDisclosed === true && f.counterpartyDisclosed === true;
  let verifiable = false;
  if (row.verifiable) {
    verifiable = row.category === "contract" ? disclosed : f.statementsParsed === true;
  }
  const materiality =
    row.category === "contract" && disclosed && row.materiality_disclosed !== undefined
      ? row.materiality_disclosed
      : row.materiality;
  return { category: row.category, materiality, verifiable, mapVersion: map.version, rule };
}

/**
 * The one writer of `announcement_category` (D-1108): the market's batch 1 calls it for each new announcement, after
 * `assertMarketEnabled`. The first classification of an announcement stays (a later map version is a new run over
 * the day, not an overwrite). Returns the FRESH classification of this call, which on a repeat may differ from the stored
 * row (read the table for the stored one).
 * @param {{ execute: Function }} db
 * @param {{ market: string, source: string, annId: string }} key
 * @param {{ version: string, rows: readonly any[] }} map @param {any} item
 */
export async function writeAnnouncementCategory(db, key, map, item) {
  const c = classify(map, item);
  await db.execute({
    // rows-ok: one insert keyed by the primary key (market, source, ann_id), once per new announcement
    sql: `INSERT INTO announcement_category (market, source, ann_id, category, materiality, verifiable, map_version)
          VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (market, source, ann_id) DO NOTHING`,
    args: [
      key.market,
      key.source,
      key.annId,
      c.category,
      c.materiality,
      c.verifiable ? 1 : 0,
      c.mapVersion,
    ],
  });
  return c;
}
