// Snooze (or un-snooze) one P1/P2 alert for the signed-in user (M5 T6, UXN-160). POST only.
import { requestMeta } from "@/lib/auth/audit";
import { withAuth } from "@/lib/auth/guard";
import { authDb, mainDb } from "@/lib/db/client";
import { handleSnooze, readJson } from "@/lib/alerts/api";
import { alertKeyParam, type KeyCtx } from "@/lib/alerts/params";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withAuth<KeyCtx>("own_preferences", async (req, user, ctx) =>
  handleSnooze(
    { mainDb: mainDb(), authDb: authDb(), env: process.env, meta: requestMeta(req.headers) },
    user,
    await alertKeyParam(ctx),
    await readJson(req),
  ),
);
