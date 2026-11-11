// The one place a market parameter is accepted (M19 A1; MKT-110 c, D-997). A candidate from a query
// (`?market=`), a route segment or a form field is a market only if it is in `enabledMarkets(db)`; anything
// else is `notFound()` on a page and `{ error: "invalid" }` in an action. No candidate means the single enabled
// market, or the user's `default_market` preference when several are enabled. Nothing about a market that is
// not enabled is ever echoed back.
import { notFound } from "next/navigation";
import type { Client } from "@libsql/client";
import { enabledMarkets } from "./profile";

export type MarketUser = { defaultMarket?: string | null } | null | undefined;
export type ResolvedMarket = { ok: true; market: string } | { ok: false; error: "invalid" };

const CODE_RE = /^[A-Z]{2,5}$/;

/** Resolves a candidate market code against the enabled markets. A candidate array (repeated query) is invalid. */
export async function resolveMarket(
  db: Pick<Client, "execute">,
  candidate: string | string[] | null | undefined,
  user?: MarketUser,
): Promise<ResolvedMarket> {
  const enabled = await enabledMarkets(db);
  if (candidate === undefined || candidate === null || candidate === "") {
    if (enabled.length === 0) return { ok: false, error: "invalid" };
    const pref = user?.defaultMarket ?? null;
    return {
      ok: true,
      market: enabled.length > 1 && pref !== null && enabled.includes(pref) ? pref : enabled[0]!,
    };
  }
  if (typeof candidate !== "string" || !CODE_RE.test(candidate) || !enabled.includes(candidate)) {
    return { ok: false, error: "invalid" };
  }
  return { ok: true, market: candidate };
}

/** For pages: the resolved market code, or `notFound()` (a 404) for a candidate that is not enabled. */
export async function resolveMarketOrNotFound(
  db: Pick<Client, "execute">,
  candidate: string | string[] | null | undefined,
  user?: MarketUser,
): Promise<string> {
  const r = await resolveMarket(db, candidate, user);
  if (!r.ok) notFound();
  return r.market;
}
