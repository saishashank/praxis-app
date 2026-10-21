// Shared pieces of the page loaders (M7 T7; docs/M7_design.md 2.7, 2.9, 2.10; D-128, D-129, D-135 draft).
//
// A loader takes the database handles, the signed-in user and the page parameters, and returns a plain,
// serialisable view model (numbers, strings, booleans, arrays; no bigint, no Date). It is already masked
// for a user who is not the Owner and has no live unmask grant (DAT-124): the codes, company names, trade
// prices, links and exact dates of such a user never leave this module. Masking is decided once per
// request with `maskContextFor`, the same call `GET /api/alerts` uses, and a failed lookup masks.
//
// Every loader returns `{ state, asOf, text, masked, data }`: `state` is "empty" when nothing has been
// written yet (data-only mode; the arrays are empty, never sample rows), "stale" when the newest data is
// older than the allowance (the banner shows `text`), else "ok". Queries are bounded and ordered, so the
// same database gives the same model.
import "server-only";
import type { Client } from "@libsql/client";
import { activeCodesByDate, activeCodesForDate, melbourneDate } from "@/lib/view/active";
import {
  EMPTY_LOOKUP,
  loadMaskLookup,
  maskContextFor,
  maskText,
  StockAliases,
  weekOnly,
  type MaskContext,
  type MaskLookup,
  type MaskUser,
} from "@/lib/view/mask";
import { dateStaleness } from "@/lib/view/staleness";
import { getConfig } from "@/lib/config/store";
import { STRATEGY_NAMES_DEFAULT } from "@/lib/config/keys";

export type Db = Pick<Client, "execute">;

export const DEFAULT_MARKET = "AU";

/** How many calendar days the newest data may lag today before the page says it is stale (weekend + a holiday). */
export const STALE_DAYS = 4; // threshold-ok: calendar days

export type LoaderDeps = {
  mainDb: Client;
  authDb: Db;
  user: MaskUser | null | undefined;
  /** The clock; tests pass a fixed instant. */
  now?: Date;
  market?: string;
};

export type PageState = "empty" | "stale" | "ok";

export type Loaded<T> = {
  state: PageState;
  /** Newest data date (YYYY-MM-DD) behind the page, or null when there is none. */
  asOf: string | null;
  /** Fixed text for the stale banner or the empty state. */
  text: string;
  /** True when the viewer sees letters instead of codes. */
  masked: boolean;
  data: T;
};

/** Every money value leaves a loader like this and is rendered with a visible "Simulated" label (AT-27). */
export type Money = { micro: number; currency: "AUD"; simulated: true };

export const money = (micro: number): Money => ({ micro, currency: "AUD", simulated: true });

export const num = (v: unknown): number => (typeof v === "number" ? v : Number(v));
export const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : num(v);
export const str = (v: unknown): string => String(v);
export const strOrNull = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);

export const PPM = 1_000_000; // threshold-ok: parts per million

/** a / b in ppm, rounded half up; null when b is not positive. */
export function ratioPpm(a: number, b: number): number | null {
  return b > 0 ? Math.round((a * PPM) / b) : null;
}

export const EMPTY_TEXT = "Nothing here yet.";

export function pageState(asOf: string | null, now: Date, emptyText = EMPTY_TEXT) {
  if (asOf === null) return { state: "empty" as const, asOf: null, text: emptyText };
  const today = melbourneDate(now.toISOString()) ?? asOf;
  const s = dateStaleness(asOf, today, STALE_DAYS);
  if (s.state === "stale") return { state: "stale" as const, asOf, text: s.text };
  return { state: "ok" as const, asOf, text: s.text };
}

export function loaded<T>(
  asOf: string | null,
  now: Date,
  masked: boolean,
  data: T,
  emptyText = EMPTY_TEXT,
): Loaded<T> {
  return { ...pageState(asOf, now, emptyText), masked, data };
}

// ---- masking -----------------------------------------------------------------------------------

/** What a loader uses to turn a code, a text or a date into what the viewer may see. */
export type MaskScope = {
  masked: boolean;
  /** The code, or "Stock A"; a code outside the date's active set is "Another stock". */
  label(code: string | null | undefined): string;
  /** Free text: unchanged for an unmasked viewer, else passed through maskText. */
  text(s: string): string;
  /** A trade date: exact for an unmasked viewer, else the ISO week. */
  day(d: string | null | undefined): string | null;
};

const OPEN_SCOPE: MaskScope = {
  masked: false,
  label: (c) => (typeof c === "string" ? c : ""),
  text: (s) => s,
  day: (d) => (typeof d === "string" ? d : null),
};

export class Masker {
  private lookup: MaskLookup | null = null;

  constructor(
    private readonly db: Db,
    private readonly market: string,
    readonly ctx: MaskContext,
  ) {}

  get masked(): boolean {
    return this.ctx.masked;
  }

  /** The letters and name lookup of one date, for code that needs the masking primitives themselves. */
  async parts(
    d: string,
    codes: Iterable<string | null | undefined> = [],
  ): Promise<{ aliases: StockAliases; lookup: MaskLookup }> {
    if (!this.ctx.masked) return { aliases: new StockAliases(codes), lookup: EMPTY_LOOKUP };
    const active = await activeCodesForDate(this.db, this.market, d);
    const aliases = new StockAliases([...active, ...codes]);
    if (this.lookup === null) this.lookup = await loadMaskLookup(this.db, this.market);
    return { aliases, lookup: this.lookup };
  }

  /**
   * The scope of one Melbourne date. `codes` are the codes of the records the loader is about to return
   * for that date: they join the date's stored active set BEFORE any letter is given (collected first,
   * masked afterwards), so a letter is stable across the page and never reused.
   */
  async scope(d: string, codes: Iterable<string | null | undefined> = []): Promise<MaskScope> {
    if (!this.ctx.masked) return OPEN_SCOPE;
    const { aliases, lookup } = await this.parts(d, codes);
    return {
      masked: true,
      label: (c) => aliases.label(c),
      text: (s) => maskText(s, aliases, lookup),
      day: (x) => weekOnly(x),
    };
  }

  /**
   * Scopes for records that span several dates (a trade list): one read of the active sets of
   * [from, to], then a scope per date. A date outside the range gets its own single-date scope.
   * `codes` are the codes of the records, by date.
   */
  async scopes(
    from: string,
    to: string,
    codes: ReadonlyMap<string, readonly string[]>,
  ): Promise<(d: string) => MaskScope> {
    if (!this.ctx.masked) return () => OPEN_SCOPE;
    const active = await activeCodesByDate(this.db, this.market, from, to);
    if (this.lookup === null) this.lookup = await loadMaskLookup(this.db, this.market);
    const lookup = this.lookup;
    const cache = new Map<string, MaskScope>();
    return (d: string): MaskScope => {
      let sc = cache.get(d);
      if (!sc) {
        const aliases = new StockAliases([...(active.get(d) ?? []), ...(codes.get(d) ?? [])]);
        sc = {
          masked: true,
          label: (c) => aliases.label(c),
          text: (x) => maskText(x, aliases, lookup),
          day: (x) => weekOnly(x),
        };
        cache.set(d, sc);
      }
      return sc;
    };
  }
}

export type Viewer = { now: Date; market: string; masker: Masker };

/** Reads the mask context once (a failed lookup masks) and builds the masker. */
export async function openViewer(deps: LoaderDeps): Promise<Viewer> {
  const now = deps.now ?? new Date();
  const market = deps.market ?? DEFAULT_MARKET;
  const ctx = await maskContextFor(deps.user, deps.authDb, now);
  return { now, market, masker: new Masker(deps.mainDb, market, ctx) };
}

// ---- small reads -------------------------------------------------------------------------------

/** Newest trading date with a completion marker of kind "data" (the nightly data run finished). */
export async function latestDataDate(db: Db, market: string): Promise<string | null> {
  const r = await db.execute({
    sql: "SELECT MAX(d) AS d FROM completion_marker WHERE market = ? AND kind = 'data'",
    args: [market],
  });
  return strOrNull(r.rows[0]?.d);
}

/** The latest regime (highest version of the newest date), or null before the first row. */
export async function latestRegime(
  db: Db,
  market: string,
): Promise<{ d: string; state: string } | null> {
  const r = await db.execute({
    sql: "SELECT d, state FROM regime_daily WHERE market = ? ORDER BY d DESC, version DESC LIMIT 1",
    args: [market],
  });
  const row = r.rows[0];
  return row ? { d: str(row.d), state: str(row.state) } : null;
}

export const maxDate = (...ds: ReadonlyArray<string | null | undefined>): string | null => {
  let out: string | null = null;
  for (const d of ds) if (typeof d === "string" && (out === null || d > out)) out = d;
  return out;
};

/** Runs a read that must not break the whole page: a failure gives the fallback (the section stays empty). */
export async function soft<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}

// ---- configuration the pages show -----------------------------------------------------------------

export type StrategyName = {
  name: string;
  one_liner: string;
  buys: string;
  sells: string;
  works_best: string;
  main_risk: string;
};

/** Names and hover texts of the six families (UXN-039): the stored table, else the default table. */
export async function strategyNames(db: Client): Promise<Record<string, StrategyName>> {
  const out: Record<string, StrategyName> = { ...STRATEGY_NAMES_DEFAULT };
  const stored = await soft(() => getConfig(db, "strategy_names"), null);
  if (typeof stored === "object" && stored !== null) {
    for (const [fam, row] of Object.entries(stored as Record<string, unknown>)) {
      const r = row as Partial<StrategyName> | null;
      if (r && typeof r.name === "string" && r.name.length > 0 && fam in out) {
        out[fam] = { ...out[fam]!, ...(r as StrategyName) };
      }
    }
  }
  return out;
}

/** An integer config value, or the fallback when it cannot be read. */
export async function configInt(db: Client, key: "attention_near_limit_pct", fallback: number) {
  const v = await soft(() => getConfig(db, key), fallback);
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
