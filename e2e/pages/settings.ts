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

// No-JS detail pages behind the rows on /settings (UXR-027).
SETTINGS_PAGES.push(
  {
    file: "src/app/(app)/settings/time/page.tsx",
    path: "/settings/time",
    action: "own_preferences",
    h1: "Time and alerts",
  },
  {
    file: "src/app/(app)/settings/alerts/page.tsx",
    path: "/settings/alerts",
    action: "own_preferences",
    h1: "Alerts",
  },
  {
    file: "src/app/(app)/settings/quiet-hours/page.tsx",
    path: "/settings/quiet-hours",
    action: "own_preferences",
    h1: "Quiet hours",
  },
  {
    file: "src/app/(app)/settings/sign-out-everywhere/page.tsx",
    path: "/settings/sign-out-everywhere",
    action: "admin",
    h1: "Sign out everywhere",
  },
);
