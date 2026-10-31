// Signed pick-alert poll from the Worker slot `quote-poll` (M17 WP3, ARN-112..114). POST only; HMAC +
// single-use nonce, fail closed (src/lib/alerts/pick/poll.ts). Delayed quotes, append-only transitions.
import { TursoNonceStore } from "@/lib/security/replay";
import { authDb, mainDb } from "@/lib/db/client";
import { sydneyDate } from "@/lib/data/pipeline/rules.mjs";
import { createPickAlertsHandler, defaultRecipients } from "@/lib/alerts/pick/poll";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: Request): Promise<Response> {
  const env = process.env;
  return createPickAlertsHandler({
    env,
    store: new TursoNonceStore(env.TURSO_MAIN_URL, env.TURSO_MAIN_TOKEN),
    nowSec: () => Math.floor(Date.now() / 1000),
    today: (nowSec) => sydneyDate(nowSec * 1000),
    db: () => mainDb(),
    fetch: (url, init) => fetch(url, init),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    recipients: (main) => defaultRecipients(main, authDb()),
  })(req);
}
