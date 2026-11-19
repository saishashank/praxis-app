// Owner-tools access guard (M21 A2, D-1214, UX-131). Opus reviews every line.
// The pages under src/app/(app)/(owner-tools)/ and the routes under /api/owner-tools/ call this FIRST. Only the
// pinned Owner while `owner_real_money_tools` is "on" passes; everyone else (Editor, Viewer, a second owner-role
// row, the Owner while the switch is off, a failed read) gets the app's ordinary 404 through notFound(), the same
// as a missing route. The proxy (gate.ts) already answers that way; this is the second check, and it is the same
// predicate (hiddenForEntry), not a copy of it.
import { notFound } from "next/navigation";
import { hiddenForEntry, ownerToolsSwitchOn } from "@/lib/http/hiddenRoutes";
import { isPinnedOwner } from "./blueprintGuard";
import type { AuthEnv } from "./env";
import { getCurrentUser, type CurrentUser } from "./session";

export type OwnerToolsDeps = {
  getUser: () => Promise<CurrentUser | null>;
  env: AuthEnv;
  ownerToolsOn: () => Promise<boolean>;
};

export const defaultDeps: OwnerToolsDeps = {
  getUser: getCurrentUser,
  env: process.env,
  ownerToolsOn: ownerToolsSwitchOn,
};

async function resolve(deps: OwnerToolsDeps): Promise<CurrentUser | null> {
  try {
    const user = await deps.getUser();
    const hidden = await hiddenForEntry("owner_tools", user, {
      isPinnedOwner: (u: CurrentUser) => isPinnedOwner(u, deps.env),
      ownerToolsOn: deps.ownerToolsOn,
    });
    return hidden ? null : user;
  } catch {
    return null; // fail closed and look like a missing route
  }
}

// Pages: the pinned Owner (switch on) gets the user back; all others get the app 404.
// `route` is for the caller's own bookkeeping (no audit row is written for a view of these tools).
export async function requireOwnerTools(
  _route: string,
  deps: OwnerToolsDeps = defaultDeps,
): Promise<CurrentUser> {
  const user = await resolve(deps);
  if (!user) notFound();
  return user;
}

// Route handlers: the same check; a refusal throws the same not-found signal a page throws.
export async function requireOwnerToolsRoute(
  _route: string,
  deps: OwnerToolsDeps = defaultDeps,
): Promise<CurrentUser> {
  const user = await resolve(deps);
  if (!user) notFound();
  return user;
}

// A yes or no for a surface that is not an Owner-tool page but shows an Owner-tool part to the Owner only (the pick tile's
// slot, M21 B1, D-1219): the same predicate as the guard, never a throw. A null user, a failed read or the switch off is
// false, so nothing of the section is loaded for anyone else.
export async function ownerToolsVisibleTo(
  user: CurrentUser | null,
  deps: OwnerToolsDeps = defaultDeps,
): Promise<boolean> {
  if (user === null) return false;
  return (await resolve({ ...deps, getUser: async () => user })) !== null;
}
