// Records that the Owner opened a challenger's forward shadow results (M6 T14, ARN-082, D-110 #46).
import { withAuth } from "@/lib/auth/guard";
import { markShadowViewed, toResponse } from "@/lib/learning/ownerActions";
import { decode, ownerCtx, type IdCtx } from "../../../_ctx";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withAuth<IdCtx>("admin", async (req, user, ctx) => {
  const { id } = await ctx.params;
  return toResponse(await markShadowViewed(ownerCtx(req), user, decode(id)));
});
