// The one hidden-route decision (M21 A2, D-1210, D-1214, D-1215, UXN-324 b, UX-131). Opus reviews every line.
// Paths that answer exactly what a missing route answers for everyone but the viewer the entry names. The proxy
// (gate.ts) decides with this function for pages, RSC payloads and API routes alike; the page and route guards
// (blueprintGuard.ts, ownerToolsGuard.ts) call the same `hiddenForEntry`, so the two checks are one piece of code.
// Fail closed: a throwing dependency (pin read, config read) means "hidden".
import { getConfigCached } from "@/lib/config/runtime";

export type HiddenRoute = {
  id: "blueprint" | "owner_tools";
  /** A prefix hides the path itself and everything below it (segment-wise: "/api/x/" also hides "/api/x"). */
  prefixes: readonly string[];
  visibleTo: "pinned_owner" | "pinned_owner_with_tools";
  /** The page guard every page under these prefixes must call first (tests/ui/pageGuard.test.ts). */
  guard: "requirePinnedOwner" | "requireOwnerTools";
};

export const HIDDEN_ROUTES: readonly HiddenRoute[] = [
  {
    id: "blueprint",
    prefixes: ["/blueprint", "/api/blueprint/"],
    visibleTo: "pinned_owner",
    guard: "requirePinnedOwner",
  },
  {
    id: "owner_tools",
    prefixes: ["/recommendations", "/holdings", "/trades", "/api/owner-tools/"],
    visibleTo: "pinned_owner_with_tools",
    guard: "requireOwnerTools",
  },
];

export type HiddenDeps<S> = {
  /** True only for the pinned Owner (role owner and the pinned e-mail, D-371). */
  isPinnedOwner: (subject: S) => Promise<boolean> | boolean;
  /** True only while `owner_real_money_tools` is "on" (D-1215). */
  ownerToolsOn: () => Promise<boolean> | boolean;
};

/** Decode, collapse repeated slashes: the form the prefixes are compared in. Undecodable paths never match. */
export function normalizePath(raw: string): string | null {
  let p: string;
  try {
    p = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return p.replace(/\/{2,}/g, "/");
}

function underPrefix(p: string, prefix: string): boolean {
  const base = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return p === base || p.startsWith(base + "/");
}

/** The hidden-route entry a path belongs to, or null. */
export function hiddenEntryFor(raw: string): HiddenRoute | null {
  const p = normalizePath(raw);
  if (p === null) return null;
  return HIDDEN_ROUTES.find((e) => e.prefixes.some((x) => underPrefix(p, x))) ?? null;
}

/** True when `subject` must NOT see the entry's routes. A null subject (anonymous) never sees them. */
export async function hiddenForEntry<S>(
  id: HiddenRoute["id"],
  subject: S | null,
  deps: HiddenDeps<S>,
): Promise<boolean> {
  const entry = HIDDEN_ROUTES.find((e) => e.id === id);
  if (!entry || subject === null) return true;
  try {
    if ((await deps.isPinnedOwner(subject)) !== true) return true;
    if (entry.visibleTo === "pinned_owner") return false;
    return (await deps.ownerToolsOn()) !== true;
  } catch {
    return true;
  }
}

/** The proxy's question: is this path hidden from this (signed-in) viewer? Paths outside every entry are not hidden. */
export async function hiddenFor<S>(
  path: string,
  subject: S | null,
  deps: HiddenDeps<S>,
): Promise<boolean> {
  const entry = hiddenEntryFor(path);
  if (entry === null) return false;
  return hiddenForEntry(entry.id, subject, deps);
}

/** The Owner switch through the 60 s config cache; a failed read is the default "off" (D-1215). */
export async function ownerToolsSwitchOn(): Promise<boolean> {
  try {
    return ((await getConfigCached("owner_real_money_tools")) as string) === "on";
  } catch {
    return false;
  }
}
