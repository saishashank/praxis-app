// Signed intraday scan from the Worker slot `intraday-scan` (M17 WP5, AGT-140). POST only; HMAC +
// single-use nonce, fail closed (src/lib/intraday/handler.ts). Delayed quotes, shadow candidates only.
import { TursoNonceStore } from "@/lib/security/replay";
import { authDb, mainDb } from "@/lib/db/client";
import { sydneyDate } from "@/lib/data/pipeline/rules.mjs";
import { createIntradayScanHandler } from "@/lib/intraday/handler";
import { defaultRecipients } from "@/lib/alerts/pick/poll";
import { mailNewCandidates } from "@/lib/email/pickMail";

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
    // WP4: candidate e-mail (EML-040) after the rows are written; key-idempotent.
    mailCandidates: async (c) =>
      mailNewCandidates(
        { db: mainDb(), env, auth: authDb() },
        c,
        await defaultRecipients(mainDb(), authDb()),
      ),
  })(req);
}
