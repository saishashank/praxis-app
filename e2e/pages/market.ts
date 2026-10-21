// Page registry, Market area (M7 T15; UXN-270..273, AT-25).
import type { PageEntry } from "./types";

export const MARKET_PAGES: PageEntry[] = [
  { file: "src/app/(app)/market/page.tsx", path: "/market", action: "read", h1: "Market" },
  {
    file: "src/app/(app)/market/[code]/page.tsx",
    path: "/market/[code]",
    action: "read",
    needsData: true,
  },
];
