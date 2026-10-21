// GET the "i" overview of one company (UXN-272, M7 T8, D-136 draft): facts only, all signed-in roles.
// `[code]` is the real code for the Owner and unmasked users, and an opaque slug ("stock-a") for a
// masked user, whose responses carry derived numbers only (DAT-124, D-129). A real code from a masked
// user is 404, the same as an unknown one.
import { withAuth } from "@/lib/auth/guard";
import { loadOverview } from "@/lib/ui/loaders/market";
import { envFor } from "@/lib/ui/loaders/shell";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "Cache-Control": "private, no-store" };
type Ctx = { params: Promise<{ code: string }> };

export const GET = withAuth<Ctx>("read", async (_req, user, ctx) => {
  const { code } = await ctx.params;
  if (!/^[A-Za-z0-9-]{1,16}$/.test(code)) {
    return Response.json({ error: "invalid" }, { status: 400, headers: HEADERS });
  }
  try {
    const view = await loadOverview(await envFor({ id: user.id, role: user.role }), code);
    if (view === null)
      return Response.json({ error: "not_found" }, { status: 404, headers: HEADERS });
    return Response.json(view, { headers: HEADERS });
  } catch {
    return Response.json({ error: "unavailable" }, { status: 503, headers: HEADERS });
  }
});
