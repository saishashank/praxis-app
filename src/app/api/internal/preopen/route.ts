// Signed pre-open re-check from the Worker slots `pre-open` (09:54) and `pre-open-retry` (09:58)
// (M5 T8, ARN-020a). POST only; HMAC + single-use nonce, fail closed (src/lib/arena/preopenRoute.ts).
import { TursoNonceStore } from "@/lib/security/replay";
import { mainDb } from "@/lib/db/client";
import { sydneyDate } from "@/lib/data/pipeline/rules.mjs";
import { createPreopenHandler } from "@/lib/arena/preopenRoute";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: Request): Promise<Response> {
  const env = process.env;
  return createPreopenHandler({
    env,
    store: new TursoNonceStore(env.TURSO_MAIN_URL, env.TURSO_MAIN_TOKEN),
    nowSec: () => Math.floor(Date.now() / 1000),
    today: (nowSec) => sydneyDate(nowSec * 1000),
    ctx: () => ({ db: mainDb(), env }),
  })(req);
}
