// Page registry, Picks area (M7 T14; UXN-040..045, AT-25).
import type { PageEntry } from "./types";

export const PICKS_PAGES: PageEntry[] = [
  { file: "src/app/(app)/picks/page.tsx", path: "/picks", action: "read", h1: "Picks" },
  {
    file: "src/app/(app)/picks/track-record/page.tsx",
    path: "/picks/track-record",
    action: "read",
    h1: "Track record",
  },
  {
    file: "src/app/(app)/picks/[id]/page.tsx",
    path: "/picks/[id]",
    action: "read",
    needsData: true,
  },
];
