// Recorded-day re-dating mapper (M8 T9, decision 31, NFR-040). PURE and deterministic: no clock, no
// randomness, no I/O. On staging the pipeline never calls Yahoo or ASX; it reads one recorded AU
// trading day from the private fixtures repo and moves its dates onto the run's trading dates, so
// the Worker's real clock drives real PLT-073 deadlines. Prices, volumes, codes and texts are never
// touched: only the fields listed in DATE_FIELDS change, and the order of the rows is kept.
//
// Alignment: the distinct recorded dates (ascending) are matched LAST-ALIGNED, in order, to the run's
// target dates (ascending): the newest recorded session becomes the newest run date, the one before
// it the one before, and so on. If the recorded day has more sessions than the run asks for, the
// OLDEST recorded sessions are dropped (their rows are removed and counted). Order is preserved and
// the map is injective, so two recorded sessions never collapse onto one run date.
// A timestamp field (`fetched_at`, `published_at`, ...) keeps its time of day; its date part follows
// the same map, or, when that date is not a session date, shifts by the same whole-day offset as the
// newest session.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STAMP_RE = /^(\d{4}-\d{2}-\d{2})(T.*)$/;
const DAY_MS = 86_400_000;

/**
 * Which fields of each dataset carry a date. `dates` are plain `YYYY-MM-DD` session or event dates
 * (they decide which rows survive); `stamps` are ISO timestamps (only the date part is moved).
 * Anything else, and every text, is copied unchanged.
 */
export const DATE_FIELDS = Object.freeze({
  bars: { dates: ["date"], stamps: ["fetched_at", "published_at"] },
  index: { dates: ["date"], stamps: ["fetched_at", "published_at"] },
  short: { dates: ["as_of"], stamps: [] },
  announcements: { dates: ["date"], stamps: ["published_at", "fetched_at"] },
  corporateActions: {
    dates: ["ex_date", "record_date", "pay_date"],
    stamps: ["published_at", "fetched_at"],
  },
});

/** @param {unknown} s */
export const isIsoDate = (s) => {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/** @param {string} a @param {string} b whole days from a to b */
export const dayDiff = (a, b) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

/** @param {string} s @param {number} n */
export const shiftDate = (s, n) =>
  new Date(Date.parse(`${s}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** Weekdays from `start` to `end`, both inclusive (the run's trading dates, holidays aside). */
export function weekdaysBetween(start, end, maxDays = 62) {
  if (!isIsoDate(start) || !isIsoDate(end) || start > end) throw new Error("bad date range");
  if (dayDiff(start, end) > maxDays) throw new Error("date range too long");
  const out = [];
  for (let d = start; d <= end; d = shiftDate(d, 1)) {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d);
  }
  return out;
}

/**
 * Last-aligned, order-preserving match of recorded dates onto target dates.
 * @param {string[]} recorded @param {string[]} targets
 * @returns {{ map: Map<string, string>, dropped: string[] }}
 */
export function alignDates(recorded, targets) {
  const r = [...new Set(recorded)].sort();
  const t = [...new Set(targets)].sort();
  if (!r.every(isIsoDate) || !t.every(isIsoDate)) throw new Error("bad date in alignment");
  const map = new Map();
  if (r.length === 0) return { map, dropped: [] };
  if (t.length === 0) throw new Error("no target dates");
  const k = Math.min(r.length, t.length);
  for (let i = 1; i <= k; i++) map.set(r[r.length - i], t[t.length - i]);
  return { map, dropped: r.slice(0, r.length - k) };
}

const collect = (rows, fields) => {
  const out = [];
  for (const row of rows) for (const f of fields) if (isIsoDate(row?.[f])) out.push(row[f]);
  return out;
};

/**
 * @param {Record<string, unknown>[]} rows
 * @param {{ dates: string[], stamps: string[] }} spec
 * @param {Map<string, string>} map @param {number} offset whole days for dates outside the map
 * @returns {{ rows: Record<string, unknown>[], dropped: number }}
 */
function mapRows(rows, spec, map, offset) {
  const out = [];
  let dropped = 0;
  for (const src of rows) {
    const row = structuredClone(src);
    let keep = true;
    for (const f of spec.dates) {
      const v = row[f];
      if (!isIsoDate(v)) continue;
      const to = map.get(v);
      if (to === undefined) keep = false;
      else row[f] = to;
    }
    if (!keep) {
      dropped++;
      continue;
    }
    for (const f of spec.stamps) {
      const v = row[f];
      const m = typeof v === "string" ? STAMP_RE.exec(v) : null;
      if (m === null || !isIsoDate(m[1])) continue;
      row[f] = `${map.get(m[1]) ?? shiftDate(m[1], offset)}${m[2]}`;
    }
    out.push(row);
  }
  return { rows: out, dropped };
}

/**
 * Re-date one recorded day onto the run.
 * @param {{ bars: object[], index: object[], short: (object & { rows: object[] }) | null,
 *   announcements: object[], corporateActions: object[] }} day
 * @param {{ sessionDates: string[], shortDates: string[] }} target
 *   `sessionDates`: the run's trading dates (request.start..request.end); `shortDates`: the dates
 *   the run asked the ASIC source for (request.short_dates, may be empty)
 */
export function redateDay(day, target) {
  const sessions = alignDates(
    [
      ...collect(day.bars, DATE_FIELDS.bars.dates),
      ...collect(day.index, DATE_FIELDS.index.dates),
      ...collect(day.announcements, DATE_FIELDS.announcements.dates),
      ...collect(day.corporateActions, DATE_FIELDS.corporateActions.dates),
    ],
    target.sessionDates,
  );
  const lastRec = [...sessions.map.keys()].sort().pop();
  const offset =
    lastRec === undefined ? 0 : dayDiff(lastRec, /** @type {string} */ (sessions.map.get(lastRec)));
  const bars = mapRows(day.bars, DATE_FIELDS.bars, sessions.map, offset);
  const index = mapRows(day.index, DATE_FIELDS.index, sessions.map, offset);
  const announcements = mapRows(day.announcements, DATE_FIELDS.announcements, sessions.map, offset);
  const corporateActions = mapRows(
    day.corporateActions,
    DATE_FIELDS.corporateActions,
    sessions.map,
    offset,
  );

  let short = null;
  let shortDropped = 0;
  if (day.short !== null) {
    const srows = Array.isArray(day.short.rows) ? day.short.rows : [];
    const sh = alignDates(collect(srows, DATE_FIELDS.short.dates), target.shortDates);
    const m = mapRows(srows, DATE_FIELDS.short, sh.map, 0);
    shortDropped = m.dropped;
    short = { ...structuredClone(day.short), rows: m.rows };
  }
  return {
    bars: bars.rows,
    index: index.rows,
    short,
    announcements: announcements.rows,
    corporateActions: corporateActions.rows,
    report: {
      sessionsRecorded: sessions.map.size + sessions.dropped.length,
      sessionsKept: sessions.map.size,
      sessionsDropped: sessions.dropped.length,
      rowsDropped:
        bars.dropped +
        index.dropped +
        announcements.dropped +
        corporateActions.dropped +
        shortDropped,
    },
  };
}
