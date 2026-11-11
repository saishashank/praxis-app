// The pure core of the market profile (M19 A1; DAT-241, DAT-242, D-993). Plain ESM with no I/O and no
// framework import, so the Worker and the Actions scripts can import it like calendarCore.mjs, and the typed
// loader (profile.ts) is a thin reader on top. Holds: the Owner's display zone, the global indices, the
// market-independent ops slot times, the stored-value codec, `profileFromRows` (database rows + overlay ->
// MarketProfile), `slotsProjection` (the Worker's per-market slot anchors), `completeness`/`isComplete`
// (DAT-242), the per-currency display format (UXN-313, D-1002) and the production default of the
// `markets_enabled` set (D-994).
import { MKT_KEY_FIELDS, PROFILE_FIELDS, validateField } from "./fields.mjs";

/**
 * The market whose pre-profile global keys (`decision_cutoff`) predate the profile: that key stays its authority
 * (D-993). The only market code outside the seed files.
 */
export const HOME_MARKET = "AU";

/** The Owner's display zone: every time shown to the Owner is Melbourne time (PLT-023). */
export const OWNER_TZ = "Australia/Melbourne";

/**
 * Indices that are global for every market (CXA-002 h): the US S&P 500 and the VIX ride the same Yahoo source
 * and are known D+1 09:00 Melbourne. They live here and nowhere else.
 */
export const GLOBAL_INDICES = Object.freeze(["GSPC", "VIX"]);

/**
 * The market-independent ops slots of the Worker clock, as local (Melbourne) HH:MM (D-996). Recurring slots
 * name `from`, `until` and `everyMin`. The Worker's schedule.ts reads these; it holds no time literal itself.
 */
export const OPS_SLOT_TIMES = Object.freeze({
  alert_flush: Object.freeze({ from: "07:01", until: "20:59", everyMin: 2 }),
  morning: Object.freeze({ at: "08:00" }),
  evening_review: Object.freeze({ from: "20:00", until: "20:45", everyMin: 5 }),
  evening_review_late: Object.freeze({ from: "21:00", until: "22:00", everyMin: 15 }),
  watchdog_2040: Object.freeze({ at: "20:40" }),
  watchdog_2150: Object.freeze({ at: "21:50" }),
  kb_archive: Object.freeze({ at: "22:15" }),
  maintenance: Object.freeze({ at: "22:30" }),
  backup: Object.freeze({ at: "23:00" }),
  backfill_history: Object.freeze({ at: "23:30" }),
  backfill_prices: Object.freeze({ at: "23:45" }),
  replay: Object.freeze({ at: "00:15" }),
  llm_bakeoff: Object.freeze({ at: "10:00" }),
  calendar_draft: Object.freeze({ at: "09:00" }),
  turso_usage: Object.freeze({ at: "06:40" }),
});

/**
 * The display format of a currency (UXN-313, D-1002): symbol and locale. `en-IN` groups in lakh and crore
 * (₹1,00,000.00). Keyed by ISO 4217 code, which is what `profile.currency` holds.
 */
export const CURRENCY_FORMATS = Object.freeze({
  AUD: Object.freeze({ code: "AUD", symbol: "A$", locale: "en-AU" }),
  INR: Object.freeze({ code: "INR", symbol: "₹", locale: "en-IN" }),
  USD: Object.freeze({ code: "USD", symbol: "US$", locale: "en-US" }),
});

/** The format of a currency code; throws for a currency with no registered format (never guesses). */
export function currencyFormatOf(currency) {
  const f = CURRENCY_FORMATS[currency];
  if (f === undefined) throw new RangeError(`no display format for currency ${String(currency)}`);
  return f;
}

/**
 * The production default of the `markets_enabled` key (D-994): PRAXIS_MARKETS_ENABLED split on commas,
 * unset or empty -> ["AU"]. A plain variable, never a secret. Codes outside the built set are dropped.
 * @param {Record<string, string | undefined>} [env]
 * @param {readonly string[]} [built]
 */
export function marketsEnabledDefault(env = {}, built = ["AU", "IN", "US"]) {
  const raw = env.PRAXIS_MARKETS_ENABLED;
  if (typeof raw !== "string" || raw.trim() === "") return ["AU"];
  const codes = raw
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter((c) => built.includes(c));
  return codes.length > 0 ? [...new Set(codes)].sort() : ["AU"];
}

// ---- stored-value codec ---------------------------------------------------------------------------------------

const BIG_RE = /^-?\d+n$/;

/** JSON text of a profile value; a bigint is written "<n>n" (the repo's canonicalJson convention). */
export function encodeValue(value) {
  return JSON.stringify(value === undefined ? null : value, (_k, x) =>
    typeof x === "bigint" ? `${x.toString()}n` : x,
  );
}

/** The value of a stored JSON text; a "<n>n" string becomes a bigint. */
export function decodeValue(text) {
  return JSON.parse(text, (_k, x) =>
    typeof x === "string" && BIG_RE.test(x) ? BigInt(x.slice(0, -1)) : x,
  );
}

// ---- small helpers --------------------------------------------------------------------------------------------

const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const hhmmOf = (m) => {
  const n = ((m % 1440) + 1440) % 1440;
  return `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
};

/** `hhmm` plus `minutes` (wraps at midnight), as HH:MM. */
export function addMinutes(hhmm, minutes) {
  return hhmmOf(minutesOf(hhmm) + minutes);
}

const val = (fields, name) => (fields[name] === undefined ? null : fields[name].value);

/**
 * A `mkt.<CODE>.<field>` key value -> the profile field value it stands for (parcel_floor in whole currency
 * units becomes micro; universe_max 0 becomes { kind: "none" }); undefined when the key value does not apply.
 * `current` is the field's present value (decision_cutoff keeps its zone).
 */
export function valueFromKey(field, raw, current) {
  if (raw === undefined || raw === null) return undefined;
  switch (field) {
    case "decision_cutoff":
      return typeof raw === "string" && current !== null ? { ...current, time: raw } : undefined;
    case "parcel_floor":
      return typeof raw === "number" && Number.isFinite(raw) && raw >= 0
        ? BigInt(Math.round(raw * 1_000_000))
        : undefined;
    case "universe_max":
      return typeof raw === "number" ? (raw === 0 ? { kind: "none" } : raw) : undefined;
    default:
      return raw;
  }
}

/** The effective config value a field's overlay key would hold, as the key stores it (the inverse of overlayValue). */
export function overlayKeyValue(field, value) {
  switch (field) {
    case "decision_cutoff":
      return value === null ? null : value.time;
    case "parcel_floor":
      return value === null ? null : Number(value) / 1_000_000;
    case "universe_max":
      return value === null || (typeof value === "object" && value.kind === "none") ? 0 : value;
    default:
      return value;
  }
}

/**
 * Builds a MarketProfile from database rows.
 * @param {{
 *   market: { code: string, tz: string, open_time: string, close_time: string, cutoff_time: string,
 *             currency: string, mode: string, enabled: number, slots_json?: string | null },
 *   profile: { code: string, work_status: string, status_changed_at: string | null, built_at: string | null,
 *              evidence_recorded_at: string | null, profile_version: number, updated_at: string | null },
 *   fieldRows: ReadonlyArray<{ field: string, value_json: string, verify: number, verified_at: string | null,
 *                              evidence_ref: string | null }>,
 *   overlay?: Readonly<Record<string, unknown>>,
 *   name?: string,
 * }} rows `overlay` maps a profile field name to the newest value of its `mkt.<CODE>.<field>` key
 *   (the AU `decision_cutoff` field also reads the legacy `decision_cutoff` key, the one authority).
 */
export function profileFromRows(rows) {
  const { market, profile, fieldRows } = rows;
  const overlay = rows.overlay ?? {};
  const fields = {};
  for (const r of fieldRows) {
    fields[r.field] = {
      value: decodeValue(r.value_json),
      verify: Number(r.verify) === 1 ? 1 : 0,
      verifiedAt: r.verified_at ?? null,
      evidenceRef: r.evidence_ref ?? null,
      overlay: false,
    };
  }
  for (const [field, raw] of Object.entries(overlay)) {
    if (!(field in MKT_KEY_FIELDS) && field !== "decision_cutoff") continue;
    const cur = fields[field];
    if (cur === undefined) continue;
    const next = valueFromKey(field, raw, cur.value);
    if (next === undefined || validateField(field, next) !== null) continue;
    if (encodeValue(next) !== encodeValue(cur.value))
      fields[field] = { ...cur, value: next, overlay: true };
  }
  for (const f of Object.keys(fields)) Object.freeze(fields[f]);
  Object.freeze(fields);

  const cutoff = val(fields, "decision_cutoff");
  const open = val(fields, "session_open");
  const recheck = val(fields, "preopen_recheck_min");
  const parcel = val(fields, "parcel_floor");
  const benchmark = val(fields, "benchmark_index");
  const universe = val(fields, "universe_max");
  const base = {
    code: market.code,
    name: rows.name ?? market.code,
    workStatus: profile.work_status,
    statusChangedAt: profile.status_changed_at ?? null,
    builtAt: profile.built_at ?? null,
    evidenceRecordedAt: profile.evidence_recorded_at ?? null,
    version: Number(profile.profile_version),
    updatedAt: profile.updated_at ?? null,
    enabled: Number(market.enabled) === 1,
    mode: market.mode,
    fields,
    exchange: val(fields, "exchange"),
    tz: val(fields, "tz"),
    sessionOpen: open,
    sessionClose: val(fields, "session_close"),
    currency: val(fields, "currency"),
    decisionCutoff: cutoff === null ? null : cutoff.time,
    decisionCutoffZone: cutoff === null ? null : cutoff.zone,
    settlementDays: val(fields, "settlement_days"),
    parcelFloorMicro: parcel,
    /** CTX-022a: the ADV floor per parcel = parcel floor x 100 (1 % participation); AU: A$50,000. */
    advFloorPerParcelMicro: parcel === null ? null : parcel * 100n,
    openingAuctionWindow: val(fields, "opening_auction_window"),
    preopenRecheckMin: recheck,
    /** The pre-open re-check time: session open minus the re-check minutes (AU 09:55). */
    preopenAt: open === null || recheck === null ? null : addMinutes(open, -recheck),
    costFormula: val(fields, "cost_formula"),
    classificationScheme: val(fields, "classification_scheme"),
    haltModel: val(fields, "halt_model"),
    benchmarkIndex: benchmark === null ? null : benchmark.code,
    benchmarkYahooSymbol: benchmark === null ? null : benchmark.yahoo,
    regimeIndex: val(fields, "regime_index") === null ? null : val(fields, "regime_index").code,
    volatilityIndex:
      val(fields, "volatility_index") === null ? null : val(fields, "volatility_index").code,
    /** The index codes the point-in-time view carries: the market's benchmark then the global indices. */
    indexCodes: benchmark === null ? [...GLOBAL_INDICES] : [benchmark.code, ...GLOBAL_INDICES],
    yahooSuffix: val(fields, "yahoo_suffix"),
    dividendImputation: val(fields, "dividend_imputation"),
    /** CXA-002 i: the angle count; the franking angle A-D4-05 is skipped when there is no imputation. */
    angleCount: val(fields, "dividend_imputation") === true ? 100 : 99,
    /** null = no cap (AU); a number of codes otherwise. */
    universeMax:
      universe === null || (typeof universe === "object" && universe.kind === "none")
        ? null
        : universe,
    tickTable: val(fields, "tick_table"),
    tiers: val(fields, "tiers"),
    slippage: val(fields, "slippage_buckets"),
    batchSchedule: val(fields, "batch_schedule"),
    knownTimeRules: val(fields, "known_time_rules"),
    barLatencyP95Min: val(fields, "bar_latency_p95_min"),
    currencyFormat: undefined,
    slots: undefined,
    completeness: undefined,
    complete: false,
  };
  const out = { ...base };
  out.completeness = completeness(out);
  out.complete = out.completeness.complete;
  try {
    out.currencyFormat = out.currency === null ? null : currencyFormatOf(out.currency);
  } catch {
    out.currencyFormat = null;
  }
  out.slots = slotsProjection(out);
  return Object.freeze(out);
}

// ---- completeness (DAT-242) -----------------------------------------------------------------------------------

/**
 * `complete` is computed, never stored (D-999): every field has a value and every `verify = 1` field has a
 * `verifiedAt` date and an `evidenceRef`. Returns the counts the Markets row prints ("n of m fields verified").
 * @param {{ fields: Record<string, { value: unknown, verify: number, verifiedAt: string | null, evidenceRef: string | null }> }} profile
 */
export function completeness(profile) {
  const missing = [];
  const unverified = [];
  let verified = 0;
  for (const name of PROFILE_FIELDS) {
    const f = profile.fields[name];
    if (f === undefined || f.value === null) {
      missing.push(name);
      continue;
    }
    if (f.verify === 1 && (f.verifiedAt === null || f.evidenceRef === null)) unverified.push(name);
    else verified += 1;
  }
  const total = PROFILE_FIELDS.length;
  return Object.freeze({
    total,
    valued: total - missing.length,
    verified,
    missing: Object.freeze(missing),
    unverified: Object.freeze(unverified),
    complete: missing.length === 0 && unverified.length === 0,
  });
}

/** True when the profile is complete (DAT-242): every field valued, every [VERIFY] field dated and referenced. */
export function isComplete(profile) {
  return completeness(profile).complete;
}

// ---- the Worker's slot anchors --------------------------------------------------------------------------------

/**
 * The projection the Worker clock reads from `market.slots_json` (D-996): the market-bound slot anchors as
 * local HH:MM of the market's own zone. Derived from the profile only, so the projection test can compare it
 * with the stored column. AU reproduces today's table: batches 17:30 / 17:50 / 18:10, late 2a 18:40, cut-off
 * poll 18:10, pre-open 09:54 and 09:58, quote poll 10:00 to 16:00, intraday scan 10:32 to 15:32.
 * Returns null while the open, close, cut-off or batch schedule is not set.
 */
export function slotsProjection(profile) {
  const open = profile.sessionOpen;
  const close = profile.sessionClose;
  const cutoff = profile.decisionCutoff;
  const batch = profile.batchSchedule;
  const recheck = profile.preopenRecheckMin;
  if (!open || !close || !cutoff || !batch || recheck === null || recheck === undefined)
    return null;
  let b1;
  let b2a;
  let b2b;
  let late;
  if (batch.kind === "fixed") {
    ({ b1, b2a, b2b, late_2a_after: late } = batch);
  } else if (batch.kind === "after_close") {
    b1 = addMinutes(close, batch.b1);
    b2a = addMinutes(close, batch.b2a);
    b2b = addMinutes(close, batch.b2b);
    late = addMinutes(close, batch.late_2a_after);
  } else {
    return null;
  }
  return Object.freeze({
    b1,
    b2a,
    b2b,
    late_2a_after: late,
    cutoff,
    cutoff_poll: cutoff,
    preopen_recheck: Object.freeze([addMinutes(open, -recheck - 1), addMinutes(open, -2)]),
    quote_from: open,
    quote_until: close,
    intraday_scan_from: addMinutes(open, 32),
    intraday_scan_until: addMinutes(close, -28),
  });
}

/** The text stored in `market.slots_json` for a profile (null when there is no projection). */
export function slotsJson(profile) {
  const p = slotsProjection(profile);
  return p === null ? null : JSON.stringify(p);
}
