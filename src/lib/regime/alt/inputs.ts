// DAT-248 alternative regime inputs, shadow (M22 E5, D-1439): what the alt reading may read for one market and day. Read only.
// The set per market comes from the market profile's macro series list (no market is named here): the macro sources of that
// list that the macro table knows, plus the two public prediction-market sources. Every outside source is pending in the
// register, so a prediction-market probability exists only after the Owner accepted its terms and the fetcher wrote it; a macro
// source counts when its rows are stored. With nothing readable the status is `unavailable` and the reading equals the base.
import type { Client } from "@libsql/client";
import { loadProfile } from "@/lib/market/profile";

type Exec = Pick<Client, "execute">;

/** The register ids of the two prediction-market sources and the word each is stored under in `alt_input_point`. */
export const PREDICTION_SOURCES = {
  polymarket_public: "polymarket",
  kalshi_public: "kalshi",
} as const;
export type PredictionRegisterId = keyof typeof PREDICTION_SOURCES;
export const PREDICTION_REGISTER_IDS = Object.keys(PREDICTION_SOURCES) as PredictionRegisterId[];

/** The `macro_series.source` words (migrations 0033 and 0037); a profile entry is lower-cased and kept when it is one of them. */
export const MACRO_SOURCE_WORDS = ["rba", "abs", "rbi", "mospi", "fred"] as const;

/** A prediction-market probability older than this many days is not an input (the fetcher writes every session). */
export const PREDICTION_STALE_DAYS = 4; // threshold-ok: one long weekend plus a day
/** Macro series are monthly or quarterly: a value up to this many days old is the latest reading. */
export const MACRO_STALE_DAYS = 120; // threshold-ok: one quarterly release plus a month
const MAX_POINTS = 50; // threshold-ok: rows read per source, the reading's inputs_json is capped by the same number
const MS_PER_DAY = 86_400_000; // threshold-ok: unit

export type PredictionPoint = { source: string; eventKey: string; d: string; probPpm: number };
export type MacroPoint = { source: string; seriesId: string; d: string; valueMicro: string };

export type AltInputs = {
  /** The macro source words of this market's profile. */
  macroSources: string[];
  /** Register ids of the prediction-market sources whose row is `enabled` now. */
  enabledPrediction: string[];
  predictions: PredictionPoint[];
  macro: MacroPoint[];
  /** `unavailable`: nothing readable; `partial`: one of the two kinds is missing; `ok`: both kinds have a reading. */
  status: "ok" | "partial" | "unavailable";
};

const isDay = (d: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(d);
export const daysBefore = (d: string, n: number): string =>
  new Date(Date.parse(`${d}T00:00:00Z`) - n * MS_PER_DAY).toISOString().slice(0, 10);

/** The macro source words of a market (from its profile; empty when the profile cannot be read). */
export async function macroSourcesOf(db: Exec, market: string): Promise<string[]> {
  try {
    const p = await loadProfile(db as Client, market);
    const list = p.fields.macro_series?.value;
    if (!Array.isArray(list)) return [];
    return list
      .map((x) => String(x).toLowerCase())
      .filter((x) => (MACRO_SOURCE_WORDS as readonly string[]).includes(x));
  } catch {
    return [];
  }
}

/** The register ids of the prediction-market sources that are accepted (status `enabled`). A failed read is none. */
export async function enabledPredictionSources(db: Exec): Promise<PredictionRegisterId[]> {
  try {
    // rows-ok: source_register primary key probe of two ids
    const r = await db.execute({
      sql: `SELECT source FROM source_register WHERE status = 'enabled' AND source IN (${PREDICTION_REGISTER_IDS.map(() => "?").join(",")}) ORDER BY source`,
      args: [...PREDICTION_REGISTER_IDS],
    });
    return r.rows.map((x) => String(x.source) as PredictionRegisterId);
  } catch {
    return [];
  }
}

/** Everything the alt rule may read for (market, d): newest point per event or series up to the day, bounded. */
export async function readAltInputs(
  db: Exec,
  o: { market: string; d: string },
): Promise<AltInputs> {
  if (!isDay(o.d)) throw new RangeError("d must be YYYY-MM-DD");
  const macroSources = await macroSourcesOf(db, o.market);
  const enabledPrediction = await enabledPredictionSources(db);
  const predictions: PredictionPoint[] = [];
  const stored = enabledPrediction.map((id) => PREDICTION_SOURCES[id]);
  if (stored.length > 0) {
    // rows-ok: alt_input_point primary key (source, event_key, d); newest point per event inside a few days, LIMIT 50
    const r = await db.execute({
      sql: `SELECT source, event_key, MAX(d) AS d, prob_ppm FROM alt_input_point
             WHERE source IN (${stored.map(() => "?").join(",")}) AND d <= ? AND d >= ?
             GROUP BY source, event_key ORDER BY source, event_key LIMIT ${MAX_POINTS}`,
      args: [...stored, o.d, daysBefore(o.d, PREDICTION_STALE_DAYS)],
    });
    for (const x of r.rows) {
      predictions.push({
        source: String(x.source),
        eventKey: String(x.event_key),
        d: String(x.d),
        probPpm: Number(x.prob_ppm),
      });
    }
  }
  const macro: MacroPoint[] = [];
  for (const source of macroSources) {
    // rows-ok: macro_series primary key (source, series_id, d); newest value per series inside the window, LIMIT 50
    const r = await db.execute({
      sql: `SELECT series_id, MAX(d) AS d, value_micro FROM macro_series
             WHERE source = ? AND d <= ? AND d >= ? GROUP BY series_id ORDER BY series_id LIMIT ${MAX_POINTS}`,
      args: [source, o.d, daysBefore(o.d, MACRO_STALE_DAYS)],
    });
    for (const x of r.rows) {
      macro.push({
        source,
        seriesId: String(x.series_id),
        d: String(x.d),
        valueMicro: String(x.value_micro),
      });
    }
  }
  const status =
    predictions.length === 0 && macro.length === 0
      ? "unavailable"
      : predictions.length > 0 && macro.length > 0
        ? "ok"
        : "partial";
  return { macroSources, enabledPrediction, predictions, macro, status };
}
