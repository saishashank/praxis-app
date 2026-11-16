// Who may see the tax report (M21 B3; D-1223, D-1265). The report is Owner only and always available: the page and the CSV
// route call requireUser("admin") (403 for everyone else) and then `isPinnedOwner` (the Blueprint rule: role owner AND the
// pinned e-mail) as a second check. The variant that runs on the Owner's own trade log additionally needs the Owner tools
// switch on, decided by the same hidden-route predicate the Owner-tool pages use (D-1214), never by a copy of it.
import { isPinnedOwner } from "@/lib/auth/blueprintGuard";
import type { CurrentUser } from "@/lib/auth/session";
import { hiddenForEntry, ownerToolsSwitchOn } from "@/lib/http/hiddenRoutes";
import { financialYearOf } from "@/lib/market/seed/taxYear.mjs";

export async function logVariantAllowed(user: CurrentUser): Promise<boolean> {
  const hidden = await hiddenForEntry("owner_tools", user, {
    isPinnedOwner: (u: CurrentUser) => isPinnedOwner(u, process.env),
    ownerToolsOn: ownerToolsSwitchOn,
  });
  return !hidden;
}

export type TaxQuery = { fy: number | null; source: "book" | "log" };

const FIRST_FY = 2000; // threshold-ok: earliest year the selector accepts
const LAST_FY_AHEAD = 1; // threshold-ok: one year past the current one

/** The query the page and the CSV route share: `fy` (a year) and `source` (book or log). Anything else is ignored. */
export function parseTaxQuery(get: (k: string) => string | null | undefined): TaxQuery {
  const f = get("fy");
  const fy = f !== null && f !== undefined && /^\d{4}$/.test(f) ? parseInt(f, 10) : null;
  return {
    fy: fy !== null && fy >= FIRST_FY ? fy : null,
    source: get("source") === "log" ? "log" : "book",
  };
}

/** The year to show when none is asked for: the one the date is in. */
export function defaultFy(market: string, d: string): number {
  return financialYearOf(market, d);
}

export const yearChoices = (current: number): number[] => {
  const out: number[] = [];
  for (let y = current + LAST_FY_AHEAD; y >= current - 5; y -= 1) out.push(y); // threshold-ok: five past years
  return out;
};
