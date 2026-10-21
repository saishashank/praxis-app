// Owner-only learning action (M6 T14, ROL-102, docs/M6_design.md 4.7): audit event first, then the writer.
import { withAuth } from "@/lib/auth/guard";
import { createOwnerVersion, readBody, toResponse } from "@/lib/learning/ownerActions";
import { badBody, decode, ownerCtx, type FamilyCtx } from "../../../_ctx";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withAuth<FamilyCtx>("admin", async (req, user, ctx) => {
  const b = await readBody(req);
  if (b === null) return badBody();
  const { family } = await ctx.params;
  return toResponse(await createOwnerVersion(ownerCtx(req), user, decode(family), b));
});
