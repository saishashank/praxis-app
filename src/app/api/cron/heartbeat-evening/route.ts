// Vercel Cron evening heartbeat (PLT-074). GET only (platform design): other methods get Next's 405.
// Authenticates itself with CRON_SECRET; a no-op outside production.
import { mainDb } from "@/lib/db/client";
import { createHeartbeatHandler } from "@/lib/heartbeat/handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  return createHeartbeatHandler("evening", {
    env: process.env,
    mainDb,
    now: () => new Date(),
  })(req);
}
