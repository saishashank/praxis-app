// Page data loaders, shared parts and the app-shell loader (M7 T8; docs/M7_design.md 2.7, 4.2; D-136
// draft). SERVER ONLY: loaders read the databases and the unmasked codes, so no "use client" file may
// import this folder (the ESLint rule of design 2.8 and the client-bundle scan enforce it).
// A loader takes the databases, the signed-in user and the request's mask context, and returns a plain,
// serialisable, ALREADY MASKED view model with `state: "empty" | "stale" | "ok"`. Money leaves a loader
// as { micro: "<integer string>", currency, simulated: true } (a bigint is not serialisable).
import type { Client } from "@libsql/client";
import { countsInBadge, getQuietHours, listInbox } from "@/lib/alerts/api";
import { authDb, mainDb } from "@/lib/db/client";
import { enabledMarkets, loadProfile } from "@/lib/market/profile";
import { resolveMarketOrNotFound } from "@/lib/market/resolve";
import { getPreferences } from "@/lib/preferences/service";
import { activeCodesByDate, melbourneDate } from "@/lib/view/active";
import {
  loadMaskLookup,
  maskContextFor,
  StockAliases,
  type MaskContext,
  type MaskLookup,
} from "@/lib/view/mask";

export type Db = Client;
export type LoaderState = "empty" | "stale" | "ok";
export type LoaderUser = { id: number; role: string | null };
export type LoaderEnv = {
  main: Db;
  auth: Db;
  user: LoaderUser;
  /** From maskContextFor(); a missing or failed lookup is already `masked: true`. */
  mask: MaskContext;
  now: Date;
  /** The resolved market (D-997): an enabled market, from `?market=`, the user's default or the only one enabled. */
  market: string;
  /** ISO 4217 code of the market currency; `currencyFormatOf(env.currency)` is its display format (UXN-313). */
  currency: string;
};
export type MoneyView = { micro: string; currency: string; simulated: true };

/**
 * The loader environment of a signed-in request. A failed grant lookup masks (maskContextFor). The market is
 * resolved here, the one place a market parameter is accepted (D-997): a `candidate` (the page's `?market=`)
 * that is not an enabled market is a 404; none means the single enabled market, or the user's default market
 * when several are enabled.
 */
export async function envFor(
  user: LoaderUser,
  now: Date = new Date(),
  candidate?: string | string[] | null,
): Promise<LoaderEnv> {
  const auth = authDb();
  const main = mainDb();
  const mask = await maskContextFor(user.role ? { id: user.id, role: user.role } : null, auth, now);
  const several = (await enabledMarkets(main)).length > 1;
  const defaultMarket = several ? (await getPreferences(auth, user.id)).default_market : null;
  const market = await resolveMarketOrNotFound(main, candidate, { defaultMarket });
  const currency = (await loadProfile(main, market)).currency ?? "";
  return { main, auth, user, mask, now, market, currency };
}
export const todayD = (env: LoaderEnv): string => melbourneDate(env.now.toISOString()) ?? "";
const MICRO = 1_000_000; // threshold-ok: micro units per unit

export function money(
  micro: bigint | number | string | null | undefined,
  currency: string,
): MoneyView | null {
  if (micro === null || micro === undefined) return null;
  try {
    return { micro: BigInt(micro).toString(), currency, simulated: true };
  } catch {
    return null;
  }
}

/** A stored REAL bar price as micro units (display only; nothing is recomputed from it). */
export const priceMicro = (p: number): string => BigInt(Math.round(p * MICRO)).toString(); // money-float-ok: stored REAL bar price, display only

/** Active-set letters of ONE Melbourne date (signals + orders + alerts) plus the caller's own codes. */
export async function maskKit(
  env: LoaderEnv,
  d: string | null,
  extraCodes: Iterable<string> = [],
): Promise<{ aliases: StockAliases; lookup: MaskLookup }> {
  const market = env.market;
  const lookup = await loadMaskLookup(env.main, market);
  const active =
    d !== null && isDateParam(d)
      ? ((await activeCodesByDate(env.main, market, d, d)).get(d) ?? new Set<string>())
      : new Set<string>();
  return { aliases: new StockAliases([...active, ...extraCodes]), lookup };
}

/** Letters per date for a list that spans dates; each date has its own set (UX-009). */
export async function maskKitByDate(
  env: LoaderEnv,
  rows: ReadonlyArray<{ d: string; code: string }>,
): Promise<{ aliasOf: (d: string) => StockAliases; lookup: MaskLookup }> {
  const market = env.market;
  const lookup = await loadMaskLookup(env.main, market);
  const dates = [...new Set(rows.map((r) => r.d))].sort();
  const active =
    dates.length > 0
      ? await activeCodesByDate(env.main, market, dates[0]!, dates[dates.length - 1]!)
      : new Map<string, Set<string>>();
  const cache = new Map<string, StockAliases>();
  return {
    lookup,
    aliasOf: (d) => {
      let a = cache.get(d);
      if (!a) {
        const own = rows.filter((r) => r.d === d).map((r) => r.code);
        a = new StockAliases([...(active.get(d) ?? []), ...own]);
        cache.set(d, a);
      }
      return a;
    },
  };
}

/** A positive integer from a query value, within [1, max]; absent gives the default, invalid gives null. */
export function intParam(v: string | null | undefined, def: number, max: number): number | null {
  if (v === undefined || v === null || v === "") return def;
  if (!/^\d{1,6}$/.test(v)) return null;
  const n = Number(v);
  return n >= 1 && n <= max ? n : null;
}

/** A search term: 1..max printable characters; absent gives undefined, invalid gives null. */
export function textParam(
  v: string | null | undefined,
  max = 60, // threshold-ok: longest search term
): string | null | undefined {
  if (v === undefined || v === null || v.trim() === "") return undefined;
  const t = v.trim();
  return t.length <= max && !/[\u0000-\u001f\u007f]/.test(t) ? t : null;
}

export const isDateParam = (v: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

// ---- the shell ----------------------------------------------------------------------------------

export type ShellBanner = { id: string; text: string };
export type ShellMarket = { code: string; mode: string; currency: string; exchange: string | null };
export type ShellModel = {
  state: LoaderState;
  user: LoaderUser;
  masked: boolean;
  market: ShellMarket | null;
  /** The enabled markets, for the header switcher (D-997, UXN-312); a built market that is off is never listed. */
  markets: ShellMarket[];
  /** Alerts that count in the bell (UXN-161) and the highest tier among them. */
  bell: { count: number; topTier: "P0" | "P1" | "P2" | null };
  banners: ShellBanner[];
};

const TIER_RANK = { P0: 0, P1: 1, P2: 2 } as const;
const MODE_BANNER: Record<string, string> = {
  off: "The market is switched off: no data is collected.",
  data_only: "Data only: the strategies are not running yet.",
};

/** Data for the header, bell and banners (UX-015). Never throws: a failed read shows a reduced shell. */
export async function loadShell(env: LoaderEnv): Promise<ShellModel> {
  const out: ShellModel = {
    state: "empty",
    user: env.user,
    masked: env.mask.masked,
    market: null,
    markets: [],
    bell: { count: 0, topTier: null },
    banners: [],
  };
  try {
    const m = await env.main.execute({
      sql: "SELECT code, mode, currency FROM market WHERE enabled = 1 ORDER BY code",
      args: [],
    });
    for (const x of m.rows) {
      const profile = await loadProfile(env.main, String(x.code));
      out.markets.push({
        code: String(x.code),
        mode: String(x.mode),
        currency: String(x.currency),
        exchange: profile.exchange,
      });
    }
    const row = out.markets.find((x) => x.code === env.market);
    if (row) {
      out.market = row;
      const text = MODE_BANNER[out.market.mode];
      if (text) out.banners.push({ id: `mode:${out.market.mode}`, text });
      out.state = "ok";
    }
  } catch {
    out.banners.push({ id: "shell:unavailable", text: "Some header information is unavailable." });
  }
  try {
    const deps = { mainDb: env.main, authDb: env.auth };
    const inbox = await listInbox(deps, env.user.id, {}, env.now);
    const prefs = await getPreferences(env.auth, env.user.id);
    const quiet = await getQuietHours(env.auth, env.user.id);
    let top: "P0" | "P1" | "P2" | null = null;
    for (const a of inbox.alerts) {
      if (!countsInBadge(a, prefs, quiet, env.now)) continue;
      if (top === null || TIER_RANK[a.tier] < TIER_RANK[top]) top = a.tier;
    }
    out.bell = { count: inbox.badge, topTier: inbox.badge > 0 ? top : null };
  } catch {
    // the bell shows nothing rather than a wrong number
  }
  return out;
}
