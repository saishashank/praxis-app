// Reference-data readers and CSV import for the manual files (M14, D-218, D-238; docs/M14_design.md 2.3).
// Two append-only tables (migration 0018) hold what the Owner uploads on Configuration, Data files:
// `index_change` (DAT-234, the F3 index-change exclusion) and `instrument_class` (FAM-006, a finer
// industry class than the ASX industry group). With nothing uploaded both readers return nothing, so
// no code has an index change and FAM-006 falls back to the ASX industry group (v1 behaviour).
//
// `loadIndexChanges` returns each code's changes oldest first, as known on the decision date `d`
// (announced on or before `d`; an effective date after `d` is still returned, because the F3 rule
// tests the window around day 0). `loadIndustryMap` returns the newest `instrument_class` row with
// as_of <= d per code. Both are pure reads, so the live night and the snapshot builder
// (snapshotCore.mjs) see the same rows, and a replay at `d` never sees a later upload's dates.
import type { Client, InStatement } from "@libsql/client";
import type { IndexChangeFact } from "@/lib/agents/families/types";
import { splitCsv } from "@/lib/data/universe/parse.mjs";

/** One row of `index_change` (the CSV: code, index, add/delete, announced date, effective date, source). */
export type IndexChangeRow = IndexChangeFact & {
  readonly market: string;
  readonly code: string;
  readonly source: string;
};

/** One row of `instrument_class`. */
export type InstrumentClassRow = {
  readonly market: string;
  readonly code: string;
  readonly industry: string;
  readonly source: string;
  readonly asOf: string;
};

/** Placeholder industry values of the ASX file that count as unknown (D-217). */
export const UNKNOWN_INDUSTRY_VALUES: readonly string[] = ["Class Pend", "Not Applic"];

/** True when an industry is missing or a placeholder. */
export function industryUnknown(industry: string | null | undefined): boolean {
  return industry === null || industry === undefined || UNKNOWN_INDUSTRY_VALUES.includes(industry);
}

const MARKET = "AU";
const CODE_RE = /^[A-Z0-9]{2,6}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
export const MAX_REFERENCE_CSV_CHARS = 500_000;
export const MAX_REFERENCE_ROWS = 20_000;
export const MAX_TEXT_CHARS = 100;

/** A real calendar date in YYYY-MM-DD form (2025-02-30 is refused). */
export function isIsoDate(v: string): boolean {
  if (!DATE_RE.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
}

export type ReferenceCsvError =
  "unrecognised_format" | "too_large" | "bad_row" | "empty" | "unavailable";

/** A refusal: a fixed word and, for a bad row, the 1-based line number (never the row text). */
export type ReferenceCsvFailure = {
  readonly ok: false;
  readonly error: ReferenceCsvError;
  readonly line?: number;
};

const norm = (h: string): string => h.trim().toLowerCase().replace(/\s+/g, "_");
const cleanText = (v: string, max: number): string | null => {
  const t = v.trim();
  return t.length > 0 && t.length <= max && !CONTROL_RE.test(t) ? t : null;
};

function records(text: unknown): string[][] | ReferenceCsvFailure {
  if (typeof text !== "string") return { ok: false, error: "unrecognised_format" };
  if (text.length === 0) return { ok: false, error: "empty" };
  if (text.length > MAX_REFERENCE_CSV_CHARS) return { ok: false, error: "too_large" };
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const recs = splitCsv(src).filter((r) => !r.every((f) => f.trim() === ""));
  if (recs.length === 0) return { ok: false, error: "empty" };
  if (recs.length - 1 > MAX_REFERENCE_ROWS) return { ok: false, error: "too_large" };
  return recs;
}

/** Header columns by name; null when a required column is missing or one repeats. */
function columns(head: string[], required: readonly string[]): Map<string, number> | null {
  const idx = new Map<string, number>();
  for (let i = 0; i < head.length; i += 1) {
    const h = norm(head[i]);
    if (idx.has(h)) return null;
    idx.set(h, i);
  }
  return required.every((r) => idx.has(r)) ? idx : null;
}

export type ParsedIndexChanges = {
  readonly ok: true;
  readonly rows: readonly Omit<IndexChangeRow, "market">[];
};

/**
 * Index-change CSV (DAT-234): header `code,index,change,announced,effective,source`; `change` is
 * add or delete; `announced` may be empty; dates are YYYY-MM-DD and `announced` is not after
 * `effective`. The whole file is refused at the first bad row, so a half-read file never loads.
 */
export function parseIndexChangesCsv(text: unknown): ParsedIndexChanges | ReferenceCsvFailure {
  const recs = records(text);
  if (!Array.isArray(recs)) return recs;
  const cols = columns(recs[0], ["code", "index", "change", "announced", "effective", "source"]);
  if (!cols) return { ok: false, error: "unrecognised_format" };
  const rows: Omit<IndexChangeRow, "market">[] = [];
  const seen = new Set<string>();
  for (let n = 1; n < recs.length; n += 1) {
    const r = recs[n];
    const get = (k: string): string => (r[cols.get(k) as number] ?? "").trim();
    const bad = (): ReferenceCsvFailure => ({ ok: false, error: "bad_row", line: n + 1 });
    if (r.length !== recs[0].length) return bad();
    const code = get("code");
    const indexName = cleanText(get("index"), MAX_TEXT_CHARS);
    const kind = get("change").toLowerCase();
    const announced = get("announced");
    const effective = get("effective");
    const source = cleanText(get("source"), MAX_TEXT_CHARS);
    if (!CODE_RE.test(code) || indexName === null || source === null) return bad();
    if (kind !== "add" && kind !== "delete") return bad();
    if (!isIsoDate(effective) || (announced !== "" && !isIsoDate(announced))) return bad();
    if (announced !== "" && announced > effective) return bad();
    const key = [code, indexName, kind, effective].join("|");
    if (seen.has(key)) return bad();
    seen.add(key);
    rows.push({
      code,
      indexName,
      kind,
      announced: announced === "" ? null : announced,
      effective,
      source,
    });
  }
  rows.sort(
    (a, b) =>
      a.code.localeCompare(b.code) ||
      a.effective.localeCompare(b.effective) ||
      a.indexName.localeCompare(b.indexName) ||
      a.kind.localeCompare(b.kind),
  );
  return { ok: true, rows };
}

export type ParsedIndustryMap = {
  readonly ok: true;
  readonly rows: readonly Omit<InstrumentClassRow, "market" | "source">[];
};

/**
 * Industry-map CSV (FAM-006): header `code,industry,as_of`. `as_of` is the first date the class
 * applies; a reader never uses a row dated after the decision date.
 */
export function parseIndustryMapCsv(text: unknown): ParsedIndustryMap | ReferenceCsvFailure {
  const recs = records(text);
  if (!Array.isArray(recs)) return recs;
  const cols = columns(recs[0], ["code", "industry", "as_of"]);
  if (!cols) return { ok: false, error: "unrecognised_format" };
  const rows: Omit<InstrumentClassRow, "market" | "source">[] = [];
  const seen = new Set<string>();
  for (let n = 1; n < recs.length; n += 1) {
    const r = recs[n];
    const get = (k: string): string => (r[cols.get(k) as number] ?? "").trim();
    const bad = (): ReferenceCsvFailure => ({ ok: false, error: "bad_row", line: n + 1 });
    if (r.length !== recs[0].length) return bad();
    const code = get("code");
    const industry = cleanText(get("industry"), MAX_TEXT_CHARS);
    const asOf = get("as_of");
    if (!CODE_RE.test(code) || industry === null || !isIsoDate(asOf)) return bad();
    if (UNKNOWN_INDUSTRY_VALUES.includes(industry)) return bad();
    const key = `${code}|${asOf}`;
    if (seen.has(key)) return bad();
    seen.add(key);
    rows.push({ code, industry, asOf });
  }
  rows.sort((a, b) => a.code.localeCompare(b.code) || a.asOf.localeCompare(b.asOf));
  return { ok: true, rows };
}

export type ReferenceImportResult =
  { readonly ok: true; readonly inserted: number; readonly ignored: number } | ReferenceCsvFailure;

async function batchInsert(
  db: Client,
  stmts: InStatement[],
): Promise<{ inserted: number; ignored: number } | null> {
  try {
    const res = await db.batch(stmts, "write");
    const inserted = res.reduce((a, r) => a + r.rowsAffected, 0);
    return { inserted, ignored: stmts.length - inserted };
  } catch {
    return null;
  }
}

/**
 * Loads an index-change CSV. The table is append-only: a row already present (same key) is left as
 * it is and counted as ignored. One transaction, so a fault changes nothing.
 */
export async function importIndexChanges(
  db: Client,
  csv: unknown,
  now: string,
  market: string = MARKET,
): Promise<ReferenceImportResult> {
  const parsed = parseIndexChangesCsv(csv);
  if (!parsed.ok) return parsed;
  const out = await batchInsert(
    db,
    parsed.rows.map((r) => ({
      sql:
        "INSERT OR IGNORE INTO index_change (market, code, index_name, kind, announced_d, effective_d, source, loaded_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      args: [market, r.code, r.indexName, r.kind, r.announced, r.effective, r.source, now],
    })),
  );
  return out ? { ok: true, ...out } : { ok: false, error: "unavailable" };
}

/** Loads an industry-map CSV the same way (source `manual`). */
export async function importIndustryMap(
  db: Client,
  csv: unknown,
  now: string,
  market: string = MARKET,
): Promise<ReferenceImportResult> {
  const parsed = parseIndustryMapCsv(csv);
  if (!parsed.ok) return parsed;
  const out = await batchInsert(
    db,
    parsed.rows.map((r) => ({
      sql:
        "INSERT OR IGNORE INTO instrument_class (market, code, industry, source, as_of, loaded_at) " +
        "VALUES (?, ?, ?, 'manual', ?, ?)",
      args: [market, r.code, r.industry, r.asOf, now],
    })),
  );
  return out ? { ok: true, ...out } : { ok: false, error: "unavailable" };
}

/**
 * Index changes by code, oldest effective date first, as known on `d`: a change counts once its
 * announcement date (or, when none was keyed, its effective date) is on or before `d`. A change
 * announced after `d` is invisible, so replay at `d` sees what the live night saw (no look-ahead).
 * D-285: `loaded_at` is the time the row became known, so a row loaded after the decision cut-off of
 * `d` (`cutoffUtc`) is invisible too: a CSV uploaded later never changes a past night.
 */
export async function loadIndexChanges(
  db: Client,
  market: string,
  d: string,
  cutoffUtc: string,
): Promise<ReadonlyMap<string, readonly IndexChangeFact[]>> {
  const res = await db.execute({
    sql:
      "SELECT code, index_name, kind, announced_d, effective_d FROM index_change " +
      "WHERE market = ? AND COALESCE(announced_d, effective_d) <= ? " +
      "AND strftime('%Y-%m-%dT%H:%M:%fZ', loaded_at) <= ? " +
      "ORDER BY code, effective_d, index_name, kind",
    args: [market, d, cutoffUtc],
  });
  const out = new Map<string, IndexChangeFact[]>();
  for (const r of res.rows) {
    const code = String(r.code);
    const list = out.get(code) ?? [];
    list.push({
      indexName: String(r.index_name),
      kind: String(r.kind) === "add" ? "add" : "delete",
      announced: r.announced_d === null ? null : String(r.announced_d),
      effective: String(r.effective_d),
    });
    out.set(code, list);
  }
  return out;
}

/**
 * Finer industry class by code: the newest row with as_of on or before `d` that was loaded by the
 * decision cut-off of `d` (D-285).
 */
export async function loadIndustryMap(
  db: Client,
  market: string,
  d: string,
  cutoffUtc: string,
): Promise<ReadonlyMap<string, string>> {
  const res = await db.execute({
    sql:
      "SELECT code, industry FROM instrument_class WHERE market = ? AND as_of <= ? " +
      "AND strftime('%Y-%m-%dT%H:%M:%fZ', loaded_at) <= ? ORDER BY code, as_of",
    args: [market, d, cutoffUtc],
  });
  const out = new Map<string, string>();
  for (const r of res.rows) out.set(String(r.code), String(r.industry)); // a later as_of overwrites
  return out;
}
