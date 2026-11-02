// Page registry, experts and techniques (M13-lite WP6; UXN-292..295, D-511, D-529). Linked from
// /reviews/learned; no new tab. The claims queue is the only page guarded by review_claims.
import type { PageEntry } from "./types";

export const EXPERTS_PAGES: PageEntry[] = [
  {
    file: "src/app/(app)/reviews/experts/page.tsx",
    path: "/reviews/experts",
    action: "read",
    h1: "Experts",
  },
  {
    file: "src/app/(app)/reviews/experts/[id]/page.tsx",
    path: "/reviews/experts/[id]",
    action: "read",
    needsData: true,
  },
  {
    file: "src/app/(app)/reviews/experts/queue/page.tsx",
    path: "/reviews/experts/queue",
    action: "review_claims",
    h1: "Claims to check",
  },
  {
    file: "src/app/(app)/reviews/techniques/page.tsx",
    path: "/reviews/techniques",
    action: "read",
    h1: "Techniques",
  },
];
