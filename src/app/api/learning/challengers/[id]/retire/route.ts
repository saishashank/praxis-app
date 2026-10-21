// Owner-only learning action (M6 T14, ROL-102, docs/M6_design.md 4.7): audit event first, then the writer.
import { withAuth } from "@/lib/auth/guard";
import { retireChallenger, readBody, toResponse } from "@/lib/learning/ownerActions";
import { badBody, decode, ownerCtx, type IdCtx } from "../../../_ctx";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withAuth<IdCtx>("admin", async (req, user, ctx) => {
  const b = await readBody(req);
  if (b === null) return badBody();
  const { id } = await ctx.params;
  return toResponse(await retireChallenger(ownerCtx(req), user, decode(id), b));
});
