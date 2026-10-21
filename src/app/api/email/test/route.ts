// Owner-only "send test email" (EML-034). POST only: other methods get 405.
import { requestMeta } from "@/lib/auth/audit";
import { withAuth } from "@/lib/auth/guard";
import { authDb, mainDb } from "@/lib/db/client";
import { handleTestEmail } from "@/lib/email/testRoute";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withAuth("admin", async (req, user) =>
  handleTestEmail(
    { mainDb: mainDb(), authDb: authDb(), env: process.env, meta: requestMeta(req.headers) },
    user,
  ),
);
