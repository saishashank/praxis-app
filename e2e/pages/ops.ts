// Page registry, Ops checklist and What-if (M7 T19b; UX-118, UX-119, OPS-020, AT-25).
import type { PageEntry } from "./types";

export const OPS_PAGES: PageEntry[] = [
  { file: "src/app/(app)/ops/page.tsx", path: "/ops", action: "admin", h1: "Ops checklist" },
  {
    file: "src/app/(app)/ops/go-live/page.tsx",
    path: "/ops/go-live",
    action: "admin",
    h1: "Go-live sign-off",
  },
  { file: "src/app/(app)/what-if/page.tsx", path: "/what-if", action: "what_if", h1: "What-if" },
];
