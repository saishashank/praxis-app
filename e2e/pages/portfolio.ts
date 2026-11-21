// Page registry, Portfolio area (D-1849: "My portfolio" moved off Picks to its own tab).
import type { PageEntry } from "./types";

export const PORTFOLIO_PAGES: PageEntry[] = [
  {
    file: "src/app/(app)/portfolio/page.tsx",
    path: "/portfolio",
    action: "read",
    h1: "My portfolio",
  },
];
