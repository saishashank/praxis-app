// Shared plumbing of the learning routes (M6 T14): the request context and the id parameter.
import { requestMeta } from "@/lib/auth/audit";
import { authDb, mainDb } from "@/lib/db/client";
import type { OwnerCtx } from "@/lib/learning/ownerActions";

export const ownerCtx = (req: Request): OwnerCtx => ({
  mainDb: mainDb(),
  authDb: authDb(),
  env: process.env,
  meta: requestMeta(req.headers),
});

export type IdCtx = { params: Promise<{ id: string }> };
export type FamilyCtx = { params: Promise<{ family: string }> };

/** Ids contain colons, so they may arrive percent-encoded. */
export function decode(s: string): string {
  try {
    return s.includes("%") ? decodeURIComponent(s) : s;
  } catch {
    return "";
  }
}

export const badBody = (): Response =>
  Response.json({ error: "invalid" }, { status: 400, headers: { "Cache-Control": "no-store" } });
