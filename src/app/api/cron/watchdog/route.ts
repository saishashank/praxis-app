// Vercel Cron heartbeat for the nightly approved-commit check (PLT-074, SEC-108 d).
// GET only (platform design): other methods get Next's 405. Authenticates itself with CRON_SECRET.
import { mainDb } from "@/lib/db/client";
import { createWatchdogHandler } from "@/lib/watchdog/handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  return createWatchdogHandler({
    env: process.env,
    fetchImpl: fetch,
    mainDb,
    now: () => new Date(),
  })(req);
}
