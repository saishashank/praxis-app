// Shape of a page-registry entry. Kept free of Playwright imports so Vitest can read it.
import type { Action, Role } from "../../src/lib/auth/permissions";

export type PageEntry = {
  /** Repo-relative path of the page.tsx file. */
  file: string;
  /** URL pattern; dynamic segments stay in brackets, e.g. /cards/[id]. */
  path: string;
  /** The action the page passes to requireUser first, or "public" for a page with no guard. */
  action: Action | "public";
  /** Roles allowed to see it; omit to derive from the action ("all" for public pages). */
  roles?: readonly Role[] | "all";
  /** Expected h1 text for a normal render, when fixed. */
  h1?: string;
  /** True when the page needs a seeded row to render (dynamic id); skipped by the generic sweep. */
  needsData?: boolean;
};
