// Signed self-check route (SEC-017, SEC-101). POST only: other methods get Next's 405.
import { TursoNonceStore } from "@/lib/security/replay";
import { createSelfCheckHandler } from "@/lib/selfcheck/handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const env = process.env;
  return createSelfCheckHandler({
    env,
    fetchImpl: fetch,
    store: new TursoNonceStore(env.TURSO_MAIN_URL, env.TURSO_MAIN_TOKEN),
    nowSec: () => Math.floor(Date.now() / 1000),
  })(req);
}
