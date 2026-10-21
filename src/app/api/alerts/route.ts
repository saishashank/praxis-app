// The signed-in user's alert inbox and unread badge (M5 T6, UX-052, UXN-157/161). GET only.
import { withAuth } from "@/lib/auth/guard";
import { authDb, mainDb } from "@/lib/db/client";
import { handleList } from "@/lib/alerts/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withAuth("own_preferences", async (req, user) =>
  handleList({ mainDb: mainDb(), authDb: authDb() }, user, new URL(req.url)),
);
