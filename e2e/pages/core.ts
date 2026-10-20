// Page registry, existing pages (M7 design section 5, AT-25). One entry per src/app page.tsx.
// New page tasks add their own file e2e/pages/<area>.ts and one line in e2e/pages/index.ts.
import type { PageEntry } from "./types";

export const CORE_PAGES: PageEntry[] = [
  {
    file: "src/app/signin/page.tsx",
    path: "/signin",
    action: "public",
    roles: "all",
    h1: "Sign in",
  },
  {
    file: "src/app/privacy/page.tsx",
    path: "/privacy",
    action: "public",
    roles: "all",
    h1: "Privacy",
  },
  { file: "src/app/terms/page.tsx", path: "/terms", action: "public", roles: "all", h1: "Terms" },
  { file: "src/app/(app)/page.tsx", path: "/", action: "read", h1: "Praxis" },
  { file: "src/app/(app)/health/page.tsx", path: "/health", action: "read", h1: "System Health" },
  {
    file: "src/app/(app)/settings/page.tsx",
    path: "/settings",
    action: "own_preferences",
    h1: "Settings",
  },
  { file: "src/app/(app)/users/page.tsx", path: "/users", action: "admin", h1: "Users & roles" },
  { file: "src/app/(app)/usage/page.tsx", path: "/usage", action: "admin", h1: "Usage" },
  { file: "src/app/(app)/config/page.tsx", path: "/config", action: "admin", h1: "Configuration" },
  {
    file: "src/app/(app)/review/page.tsx",
    path: "/review",
    action: "admin",
    h1: "Data review queue",
  },
  { file: "src/app/(app)/learning/page.tsx", path: "/learning", action: "read", h1: "Learning" },
  {
    file: "src/app/(app)/learning/lessons/[id]/page.tsx",
    path: "/learning/lessons/[id]",
    action: "read",
    needsData: true,
  },
  {
    file: "src/app/(app)/learning/challengers/[id]/page.tsx",
    path: "/learning/challengers/[id]",
    action: "read",
    needsData: true,
  },
  {
    file: "src/app/(app)/cards/[id]/page.tsx",
    path: "/cards/[id]",
    action: "read",
    needsData: true,
  },
  {
    file: "src/app/(app)/reviews/[date]/page.tsx",
    path: "/reviews/[date]",
    action: "read",
    needsData: true,
  },
];
