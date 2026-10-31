// Signed Evening Review send from the Worker slot `evening-review` and the YAML watchdog (M5 T10,
// D-106). POST only; HMAC + single-use nonce, fail closed (src/lib/review/routeHandler.ts).
import { TursoNonceStore } from "@/lib/security/replay";
import { authDb, mainDb } from "@/lib/db/client";
import { createEveningReviewHandler } from "@/lib/review/routeHandler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  const env = process.env;
  return createEveningReviewHandler({
    env,
    store: new TursoNonceStore(env.TURSO_MAIN_URL, env.TURSO_MAIN_TOKEN),
    nowSec: () => Math.floor(Date.now() / 1000),
    db: () => mainDb(),
    auth: () => authDb(),
  })(req);
}
