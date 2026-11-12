// US company facts as filed (M20 A5; DAT-226, AT-38, D-1111). The SEC "company facts" JSON lists, per concept and
// unit, every value a company ever reported with the accession of the filing that reported it and the filing date.
// A restatement is a SECOND entry with a later accession: the first is never overwritten. This module parses that JSON
// into `fundamental_fact` rows (one per concept, period end and accession), appends them, and reads one back AS KNOWN
// at a decision instant: `factAsOf` returns the row with the greatest `filed_at` at or before the instant, so a
// decision made between two filings sees the first-filed value and one made after the restatement sees the restated
// value, never a later one (the replay's TST-109 check, replay/snapshotWorld.ts, fails a read ahead of its filing).
//
// No network here: the fetch of the JSON is the US1 task's (polite client, `PRAXIS_EDGAR_CONTACT`, D-1094); this file
// takes the parsed JSON. Writes go through the `fundamental_fact` guard triggers (0036), so a market that is off is
// refused by the database itself.
import type { Client } from "@libsql/client";

/** One row of `fundamental_fact`. `value` is the filed number as text (never re-rounded); `filedAt` is ISO UTC. */
export type FundamentalFact = {
  readonly market: string;
  readonly code: string;
  readonly cik: string;
  readonly concept: string;
  readonly unit: string;
  readonly fy: number | null;
  readonly fp: string | null;
  readonly periodEnd: string;
  readonly value: string;
  readonly form: string | null;
  readonly accession: string;
  readonly filedAt: string;
};

/** The SEC's JSON, only the parts read here. */
export type CompanyFactsJson = {
  readonly cik?: number | string;
  readonly facts?: Readonly<
    Record<
      string,
      Readonly<
        Record<
          string,
          {
            readonly units?: Readonly<
              Record<
                string,
                readonly {
                  readonly start?: string;
                  readonly end?: string;
                  readonly val?: number | string;
                  readonly accn?: string;
                  readonly fy?: number | null;
                  readonly fp?: string | null;
                  readonly form?: string | null;
                  readonly filed?: string;
                }[]
              >
            >;
          }
        >
      >
    >
  >;
};

export type ParseFactsOptions = {
  readonly market: string;
  readonly code: string;
  /**
   * The filing's acceptance instant by accession (EDGAR `submissions` `acceptanceDateTime`, ISO). The company-facts
   * JSON carries only the filing DATE; with no acceptance instant a date counts as filed at the END of that UTC day
   * (D-1160), so a value is never visible to a decision that precedes the filing.
   */
  readonly acceptance?: Readonly<Record<string, string>>;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The instant a filing became known: its acceptance instant, else the end of its filing date (UTC). */
export function filedInstant(filed: string, acceptance?: string): string {
  if (acceptance !== undefined && !Number.isNaN(Date.parse(acceptance))) {
    return new Date(acceptance).toISOString();
  }
  if (DATE.test(filed)) return `${filed}T23:59:59.999Z`;
  const ms = Date.parse(filed);
  if (Number.isNaN(ms)) throw new RangeError(`unreadable filing date: ${filed}`);
  return new Date(ms).toISOString();
}

const text = (v: number | string): string => (typeof v === "number" ? String(v) : v.trim());

/**
 * The facts of a company-facts JSON as `fundamental_fact` rows, oldest filing first, in a stable order. One row per
 * (concept, period end, accession): where a filing lists the same period end for several durations (a fiscal-year and
 * a fourth-quarter value share an end date) the LONGEST duration is kept, an instant keeps its one value (D-1161);
 * where a concept has several units the alphabetically first is kept; the taxonomy prefix is dropped (`Revenues`, not `us-gaap:Revenues`). Entries without an end, a value, an accession or
 * a filing date are skipped.
 */
export function parseCompanyFacts(
  json: CompanyFactsJson,
  opts: ParseFactsOptions,
): FundamentalFact[] {
  const cik = String(json.cik ?? "").replace(/^0+(?=\d)/, "");
  if (cik === "") throw new RangeError("company facts carry no cik");
  const best = new Map<string, { fact: FundamentalFact; start: string | null }>();
  const taxonomies = Object.keys(json.facts ?? {}).sort();
  for (const tax of taxonomies) {
    const concepts = json.facts![tax]!;
    for (const name of Object.keys(concepts).sort()) {
      const units = concepts[name]!.units ?? {};
      const unit = Object.keys(units).sort()[0];
      if (unit === undefined) continue;
      const concept = name; // the taxonomy is dropped: a concept name is unique across the us-gaap and dei taxonomies
      for (const e of units[unit]!) {
        if (e.end === undefined || !DATE.test(e.end) || e.val === undefined || e.val === null)
          continue;
        if (e.accn === undefined || e.accn === "" || e.filed === undefined) continue;
        const key = `${concept}|${e.end}|${e.accn}`;
        const start = e.start ?? null;
        const prior = best.get(key);
        // longer duration = earlier start; an instant (no start) is its own and never meets a duration
        if (prior !== undefined && !(start !== null && prior.start !== null && start < prior.start))
          continue;
        best.set(key, {
          start,
          fact: {
            market: opts.market,
            code: opts.code,
            cik,
            concept,
            unit,
            fy: e.fy ?? null,
            fp: e.fp ?? null,
            periodEnd: e.end,
            value: text(e.val),
            form: e.form ?? null,
            accession: e.accn,
            filedAt: filedInstant(e.filed, opts.acceptance?.[e.accn]),
          },
        });
      }
    }
  }
  return [...best.values()]
    .map((b) => b.fact)
    .sort(
      (a, b) =>
        (a.filedAt < b.filedAt ? -1 : a.filedAt > b.filedAt ? 1 : 0) ||
        (a.concept < b.concept ? -1 : a.concept > b.concept ? 1 : 0) ||
        (a.periodEnd < b.periodEnd ? -1 : a.periodEnd > b.periodEnd ? 1 : 0) ||
        (a.accession < b.accession ? -1 : a.accession > b.accession ? 1 : 0),
    );
}

const CHUNK = 200; // threshold-ok: statements per batch, a transport size and not a rule

/**
 * Appends the facts; a row that exists (same concept, period end and accession) is left as it is, never updated, so
 * re-running a fetch is idempotent and a restatement (a new accession) is a new row. Returns the rows offered.
 */
export async function appendFacts(
  db: Pick<Client, "batch">,
  facts: readonly FundamentalFact[],
): Promise<number> {
  for (let i = 0; i < facts.length; i += CHUNK) {
    await db.batch(
      facts.slice(i, i + CHUNK).map((f) => ({
        // rows-ok: one keyed insert per fact, chunked; the primary key (market, code, concept, period_end, accession) decides a duplicate
        sql: `INSERT INTO fundamental_fact (market, code, cik, concept, unit, fy, fp, period_end, value, form, accession, filed_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (market, code, concept, period_end, accession) DO NOTHING`,
        args: [
          f.market,
          f.code,
          f.cik,
          f.concept,
          f.unit,
          f.fy,
          f.fp,
          f.periodEnd,
          f.value,
          f.form,
          f.accession,
          f.filedAt,
        ],
      })),
      "write",
    );
  }
  return facts.length;
}

const toInstant = (at: string | Date): string => {
  const ms = at instanceof Date ? at.getTime() : Date.parse(at);
  if (Number.isNaN(ms)) throw new RangeError(`unreadable decision instant: ${String(at)}`);
  return new Date(ms).toISOString();
};

/**
 * DAT-226: the value of (concept, period end) AS KNOWN at `decisionAt`: the row with the greatest `filed_at` at or
 * before it (ties: the greater accession), or null when nothing was filed yet. Never a restated value that was filed
 * later. One keyed read of the few filings of that period.
 */
export async function factAsOf(
  db: Pick<Client, "execute">,
  market: string,
  code: string,
  concept: string,
  periodEnd: string,
  decisionAt: string | Date,
): Promise<FundamentalFact | null> {
  const r = await db.execute({
    // rows-ok: at most one row; the key prefix (market, code, concept, period_end) holds the few filings of one period
    sql: `SELECT market, code, cik, concept, unit, fy, fp, period_end, value, form, accession, filed_at
          FROM fundamental_fact
          WHERE market = ? AND code = ? AND concept = ? AND period_end = ? AND filed_at <= ?
          ORDER BY filed_at DESC, accession DESC LIMIT 1`,
    args: [market, code, concept, periodEnd, toInstant(decisionAt)],
  });
  const x = r.rows[0];
  if (x === undefined) return null;
  return {
    market: String(x.market),
    code: String(x.code),
    cik: String(x.cik),
    concept: String(x.concept),
    unit: String(x.unit),
    fy: x.fy === null ? null : Number(x.fy),
    fp: x.fp === null ? null : String(x.fp),
    periodEnd: String(x.period_end),
    value: String(x.value),
    form: x.form === null ? null : String(x.form),
    accession: String(x.accession),
    filedAt: String(x.filed_at),
  };
}
