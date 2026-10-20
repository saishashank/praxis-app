// Page registry (M7 design section 5, AT-25/AT-26). tests/ui/pageGuard.test.ts fails when a
// src/app page.tsx is missing here, when an entry has no page, or when the registered action
// differs from what the page's server guard enforces. Add new areas as e2e/pages/<area>.ts.
import { ROLES, can, type Role } from "../../src/lib/auth/permissions";
import { CORE_PAGES } from "./core";
import { MARKET_PAGES } from "./market";
import { PICKS_PAGES } from "./picks";
import { STRATEGIES_PAGES } from "./strategies";
import { RISK_IDEAS_PAGES } from "./riskIdeas";
import { NEWS_PAGES } from "./news";
import { REVIEWS_PAGES } from "./reviews";
import type { PageEntry } from "./types";

export type { PageEntry } from "./types";

export const PAGES: PageEntry[] = [
  ...CORE_PAGES,
  ...MARKET_PAGES,
  ...PICKS_PAGES,
  ...STRATEGIES_PAGES,
  ...RISK_IDEAS_PAGES,
  ...NEWS_PAGES,
  ...REVIEWS_PAGES,
];

/** Roles that may open the page (derived from the guard action unless the entry lists them). */
export function allowedRoles(entry: PageEntry): readonly Role[] {
  if (entry.roles === "all" || entry.action === "public") return ROLES;
  if (entry.roles) return entry.roles;
  return ROLES.filter((r) => can(r, entry.action));
}

/** Pages a role may open and that render without seeded rows: the generic sweep list. */
export function sweepPaths(role: Role): string[] {
  return PAGES.filter((p) => !p.needsData && allowedRoles(p).includes(role)).map((p) => p.path);
}

/** Signed-in pages (the ones behind requireUser). */
export const GUARDED = PAGES.filter((p) => p.action !== "public");
