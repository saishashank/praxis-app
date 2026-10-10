// Signed nightly maintenance route (SEC-017, PLT-016, PLT-076). POST only: other methods get 405.
import { TursoNonceStore } from "@/lib/security/replay";
import { authDb, mainDb } from "@/lib/db/client";
import { createMaintenanceHandler } from "@/lib/maintenance/handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const env = process.env;
  return createMaintenanceHandler({
    env,
    store: new TursoNonceStore(env.TURSO_MAIN_URL, env.TURSO_MAIN_TOKEN),
    nowSec: () => Math.floor(Date.now() / 1000),
    mainDb,
    authDb,
  })(req);
}
