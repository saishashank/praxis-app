// Read-only lesson list (M6 T14; all signed-in roles, docs/M6_design.md 4.7).
import { withAuth } from "@/lib/auth/guard";
import { listLessons } from "@/lib/learning/ownerActions";
import { ownerCtx } from "../_ctx";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withAuth("read", async (req) => {
  try {
    return Response.json(
      { lessons: await listLessons(ownerCtx(req).mainDb) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json({ error: "unavailable" }, { status: 503 });
  }
});
