// The signed-in user's quiet hours (M5 T6, UXN-160): GET reads, POST sets or clears them.
import { requestMeta } from "@/lib/auth/audit";
import { withAuth } from "@/lib/auth/guard";
import { authDb, mainDb } from "@/lib/db/client";
import { handleQuietHours } from "@/lib/alerts/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const handler = withAuth("own_preferences", async (req, user) =>
  handleQuietHours(
    { mainDb: mainDb(), authDb: authDb(), env: process.env, meta: requestMeta(req.headers) },
    user,
    req,
  ),
);

export const GET = handler;
export const POST = handler;
