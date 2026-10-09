// Server-side authorisation (PLT-031, ROL-102a, AT-02). Every page, route handler and server
// action calls requireUser / withAuth. A refusal for role is audit-logged as auth.forbidden.
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { authDb } from "@/lib/db/client";
import { audit, requestMeta, type RequestMeta } from "./audit";
import { can, type Action } from "./permissions";
import { AuthUnavailableError, getCurrentUser, type CurrentUser } from "./session";

export class ForbiddenError extends Error {
  readonly status = 403;
  constructor() {
    super("forbidden");
    this.name = "ForbiddenError";
  }
}

export type GuardDeps = {
  getUser: () => Promise<CurrentUser | null>;
  recordForbidden: (
    user: CurrentUser,
    action: string,
    path: string,
    meta: RequestMeta,
  ) => Promise<void>;
  meta: () => Promise<RequestMeta>;
};

export const defaultDeps: GuardDeps = {
  getUser: getCurrentUser,
  recordForbidden: async (user, action, path, meta) => {
    await audit(authDb(), process.env, meta, {
      actorUserId: user.id,
      action: "auth.forbidden",
      targetType: "app_user",
      targetId: String(user.id),
      detail: { action, path, role: user.role },
    });
  },
  meta: async () => requestMeta(await headers()),
};

export type Outcome =
  | { kind: "ok"; user: CurrentUser }
  | { kind: "unauthenticated" }
  | { kind: "forbidden" }
  | { kind: "unavailable" };

export async function authorize(
  action: Action | string,
  path: string,
  meta: RequestMeta | null,
  deps: GuardDeps = defaultDeps,
): Promise<Outcome> {
  let user: CurrentUser | null;
  try {
    user = await deps.getUser();
  } catch {
    return { kind: "unavailable" };
  }
  if (!user) return { kind: "unauthenticated" };
  if (can(user.role, action)) return { kind: "ok", user };
  try {
    await deps.recordForbidden(user, action, path, meta ?? (await deps.meta()));
  } catch {
    return { kind: "unavailable" }; // refusal must be auditable; otherwise fail closed with 503
  }
  return { kind: "forbidden" };
}

// Pages and server actions. No session -> /signin?callbackUrl=<path> (UX-121).
export async function requireUser(
  action: Action | string,
  path: string,
  deps: GuardDeps = defaultDeps,
): Promise<CurrentUser> {
  const out = await authorize(action, path, null, deps);
  if (out.kind === "ok") return out.user;
  if (out.kind === "unauthenticated") redirect(`/signin?callbackUrl=${encodeURIComponent(path)}`);
  if (out.kind === "forbidden") throw new ForbiddenError();
  throw new AuthUnavailableError();
}

const json = (status: number, error: string) =>
  Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });

// Route handlers: 401 JSON / 403 JSON (+ audit) / 503 JSON.
export function withAuth<C = unknown>(
  action: Action | string,
  handler: (req: Request, user: CurrentUser, ctx: C) => Promise<Response>,
  deps: GuardDeps = defaultDeps,
): (req: Request, ctx: C) => Promise<Response> {
  return async (req, ctx) => {
    const path = new URL(req.url).pathname;
    const out = await authorize(action, path, requestMeta(req.headers), deps);
    if (out.kind === "ok") return handler(req, out.user, ctx);
    if (out.kind === "unauthenticated") return json(401, "unauthorized");
    if (out.kind === "forbidden") return json(403, "forbidden");
    return json(503, "unavailable");
  };
}
