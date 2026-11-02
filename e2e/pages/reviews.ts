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
];
