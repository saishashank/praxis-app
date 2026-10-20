// GET one news item for the pop-up (UXN-038, M7 T8, D-136 draft). All signed-in roles; masked for
// non-Owners without a live unmask grant (D-129): "Stock A", masked headline, ISO week, no link. An
// item a masked user may not see is 404, the same as a missing one (no existence oracle).
import { withAuth } from "@/lib/auth/guard";
import { loadNewsItem } from "@/lib/ui/loaders/news";
import { envFor } from "@/lib/ui/loaders/shell";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "Cache-Control": "private, no-store" };
type Ctx = { params: Promise<{ id: string }> };

export const GET = withAuth<Ctx>("read", async (_req, user, ctx) => {
  const { id } = await ctx.params;
  if (!/^\d{1,12}$/.test(id)) {
    return Response.json({ error: "invalid" }, { status: 400, headers: HEADERS });
  }
  try {
    const item = await loadNewsItem(await envFor({ id: user.id, role: user.role }), Number(id));
    if (item === null)
      return Response.json({ error: "not_found" }, { status: 404, headers: HEADERS });
    return Response.json(item, { headers: HEADERS });
  } catch {
    return Response.json({ error: "unavailable" }, { status: 503, headers: HEADERS });
  }
});
