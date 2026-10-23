// Page registry, Settings sub-pages (M7 T19a; UXN-280..282, UXN-019). /settings itself stays in core.ts.
import type { PageEntry } from "./types";

export const SETTINGS_PAGES: PageEntry[] = [
  {
    file: "src/app/(app)/settings/appearance/page.tsx",
    path: "/settings/appearance",
    action: "own_preferences",
    h1: "Appearance",
  },
  {
    file: "src/app/(app)/settings/region/page.tsx",
    path: "/settings/region",
    action: "own_preferences",
    h1: "Region & markets",
  },
  {
    file: "src/app/(app)/settings/about/page.tsx",
    path: "/settings/about",
    action: "read",
    h1: "About",
  },
];
