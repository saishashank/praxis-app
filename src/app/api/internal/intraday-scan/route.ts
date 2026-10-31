// Signed intraday scan from the Worker slot `intraday-scan` (M17 WP5, AGT-140). POST only; HMAC +
// single-use nonce, fail closed (src/lib/intraday/handler.ts). Delayed quotes, shadow candidates only.
import { TursoNonceStore } from "@/lib/security/replay";
import { mainDb } from "@/lib/db/client";
import { sydneyDate } from "@/lib/data/pipeline/rules.mjs";
import { createIntradayScanHandler } from "@/lib/intraday/handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: Request): Promise<Response> {
  const env = process.env;
  return createIntradayScanHandler({
    env,
    store: new TursoNonceStore(env.TURSO_MAIN_URL, env.TURSO_MAIN_TOKEN),
    nowSec: () => Math.floor(Date.now() / 1000),
    today: (nowSec) => sydneyDate(nowSec * 1000),
    db: () => mainDb(),
    fetch: (url, init) => fetch(url, init),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  })(req);
}
