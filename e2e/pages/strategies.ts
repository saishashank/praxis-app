// Page registry, Strategies area (M7 T12, D-131). The list, one strategy and the leaderboard.
import type { PageEntry } from "./types";

export const STRATEGIES_PAGES: PageEntry[] = [
  {
    file: "src/app/(app)/strategies/page.tsx",
    path: "/strategies",
    action: "read",
    h1: "Strategies",
  },
  {
    file: "src/app/(app)/strategies/leaderboard/page.tsx",
    path: "/strategies/leaderboard",
    action: "read",
    h1: "Leaderboard",
  },
  {
    file: "src/app/(app)/strategies/[execution]/page.tsx",
    path: "/strategies/[execution]",
    action: "read",
    needsData: true,
  },
];
