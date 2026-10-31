// Blueprint access guard (SEC-111, AT-57, D-361, D-367, D-370). Opus reviews every line.
// Only a session whose role is owner AND whose email is the pinned OWNER_EMAIL passes. Everyone else
// (editor, viewer, a second owner-role row, anonymous, auth outage, audit failure) gets the app's
// ordinary 404 through notFound(): the same mechanism and the same rendered not-found page a missing
// route produces, never a 403 and never a redirect to sign-in. The proxy answers the anonymous case
// earlier with a rewrite to an absent path (gate.ts); this guard re-checks on every request.
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { authDb } from "@/lib/db/client";
import { audit, requestMeta, type RequestMeta } from "./audit";
import { isOwnerEmail, type AuthEnv } from "./env";
import { getCurrentUser, type CurrentUser } from "./session";

export const BLUEPRINT_PATH = "/blueprint";
export const ROBOTS_NOINDEX = "noindex, nofollow";

export type BlueprintDeps = {
  getUser: () => Promise<CurrentUser | null>;
  env: AuthEnv;
  meta: () => Promise<RequestMeta>;
  recordEvent: (
    user: CurrentUser,
    action: BlueprintEvent,
    route: string,
    meta: RequestMeta,
  ) => Promise<void>;
};

export type BlueprintEvent = "blueprint.view" | "blueprint.export";

export const defaultDeps: BlueprintDeps = {
  getUser: getCurrentUser,
  env: process.env,
  meta: async () => requestMeta(await headers()),
  recordEvent: async (user, action, route, meta) => {
    // Route and time only (D-370): `at` is stamped by the audit chain; no query string, no body.
    await audit(authDb(), process.env, meta, {
      actorUserId: user.id,
      action,
      targetType: "page",
      targetId: route,
      detail: { route },
    });
  },
};

// The pin: role owner (already downgraded by session.ts for any other address) AND the pinned email.
export function isPinnedOwner(user: CurrentUser | null, env: AuthEnv): user is CurrentUser {
  return user !== null && user.role === "owner" && isOwnerEmail(env, user.email);
}

async function resolve(
  route: string,
  event: BlueprintEvent,
  deps: BlueprintDeps,
): Promise<CurrentUser | null> {
  try {
    const user = await deps.getUser();
    if (!isPinnedOwner(user, deps.env)) return null;
    await deps.recordEvent(user, event, route, await deps.meta());
    return user;
  } catch {
    return null; // fail closed and look like a missing route
  }
}

// Pages: the pinned Owner gets the user back (and a view row); all others get the app 404.
export async function requirePinnedOwner(
  route: string = BLUEPRINT_PATH,
  deps: BlueprintDeps = defaultDeps,
): Promise<CurrentUser> {
  const user = await resolve(route, "blueprint.view", deps);
  if (!user) notFound();
  return user;
}

// Route handlers: same check; a refusal throws the identical not-found signal a page throws, which
// Next renders as the same 404 a missing route gives. Pass "blueprint.export" for the export route.
export async function requirePinnedOwnerRoute(
  route: string,
  event: BlueprintEvent = "blueprint.view",
  deps: BlueprintDeps = defaultDeps,
): Promise<CurrentUser> {
  const user = await resolve(route, event, deps);
  if (!user) notFound();
  return user;
}

// For other responses of the page/data routes (SEC-112, AT-57 e).
export const NOINDEX_HEADERS: Readonly<Record<string, string>> = {
  "X-Robots-Tag": ROBOTS_NOINDEX,
  "Cache-Control": "no-store",
};
