// Page registry, Risk overview and Tonight's trade ideas (M7 T13). The Decision Card page stays in
// core.ts (it is a dynamic route that needs seeded data).
import type { PageEntry } from "./types";

export const RISK_IDEAS_PAGES: PageEntry[] = [
  {
    file: "src/app/(app)/strategies/risk/page.tsx",
    path: "/strategies/risk",
    action: "read",
    h1: "Risk overview",
  },
  {
    file: "src/app/(app)/strategies/ideas/page.tsx",
    path: "/strategies/ideas",
    action: "read",
    h1: "Tonight's trade ideas",
  },
];
