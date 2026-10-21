// Page registry, "What the system learned" (Knowledge) area (M7 T18; UX-070/071, KB-070, UXN-200/201/208).
// These pages moved from /learning; the old paths are permanent redirects in next.config.ts.
import type { PageEntry } from "./types";

export const LEARNED_PAGES: PageEntry[] = [
  {
    file: "src/app/(app)/reviews/learned/page.tsx",
    path: "/reviews/learned",
    action: "read",
    h1: "What the system learned",
  },
  {
    file: "src/app/(app)/reviews/learned/compare/page.tsx",
    path: "/reviews/learned/compare",
    action: "read",
    h1: "Compare versions",
  },
  {
    file: "src/app/(app)/reviews/learned/families/[family]/page.tsx",
    path: "/reviews/learned/families/[family]",
    action: "read",
    needsData: true,
  },
  {
    file: "src/app/(app)/reviews/learned/lessons/[id]/page.tsx",
    path: "/reviews/learned/lessons/[id]",
    action: "read",
    needsData: true,
  },
  {
    file: "src/app/(app)/reviews/learned/challengers/[id]/page.tsx",
    path: "/reviews/learned/challengers/[id]",
    action: "read",
    needsData: true,
  },
];
