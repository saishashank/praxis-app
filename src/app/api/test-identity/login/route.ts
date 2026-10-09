// Staging-only signed test-identity login (SEC-109, TST-113). POST only.
// Disabled (production) -> 404 before the body is read or any database is touched.
import { testIdentityEnabled } from "@/lib/auth/testIdentity";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const env = process.env;
  if (!testIdentityEnabled(env)) {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  // The login logic is loaded only once the guard has passed.
  const { createTestLoginHandler } = await import("./handler");
  const { authDb } = await import("@/lib/db/client");
  const { TursoNonceStore } = await import("@/lib/security/replay");
  return createTestLoginHandler({
    env,
    authDb,
    store: new TursoNonceStore(env.TURSO_MAIN_URL, env.TURSO_MAIN_TOKEN),
    nowSec: () => Math.floor(Date.now() / 1000),
  })(req);
}
