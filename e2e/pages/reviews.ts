// Page registry, Reviews area (M7 T17; UX-080, UXN-113, UXN-206, UX-071b, AT-25). The review page
// itself (/reviews/[date]) is registered in core.ts.
import type { PageEntry } from "./types";

export const REVIEWS_PAGES: PageEntry[] = [
  { file: "src/app/(app)/reviews/page.tsx", path: "/reviews", action: "read", h1: "Reviews" },
  {
    file: "src/app/(app)/reviews/alerts/page.tsx",
    path: "/reviews/alerts",
    action: "read",
    h1: "Monthly alerts report",
  },
  {
    file: "src/app/(app)/reviews/glossary/page.tsx",
    path: "/reviews/glossary",
    action: "read",
    h1: "Glossary",
  },
  // M21 B3 (D-1223): the paper tax report is Owner only (the "admin" action) and always available.
  {
    file: "src/app/(app)/reviews/tax/page.tsx",
    path: "/reviews/tax",
    action: "admin",
    h1: "Tax report",
  },
  // M22 E2 (KB-082, UXN-296): the expert sources page is Owner only (the "admin" action).
  {
    file: "src/app/(app)/reviews/experts/sources/page.tsx",
    path: "/reviews/experts/sources",
    action: "admin",
    h1: "Expert sources",
  },
];
