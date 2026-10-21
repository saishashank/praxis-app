// Signed alert flush from the Worker slot `alert-flush` (M5 T6, decision 40). POST only.
import { TursoNonceStore } from "@/lib/security/replay";
import { mainDb } from "@/lib/db/client";
import { sydneyDate } from "@/lib/data/pipeline/rules.mjs";
import { createAlertFlushHandler } from "@/lib/alerts/machine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: Request): Promise<Response> {
  const env = process.env;
  return createAlertFlushHandler({
    env,
    store: new TursoNonceStore(env.TURSO_MAIN_URL, env.TURSO_MAIN_TOKEN),
    nowSec: () => Math.floor(Date.now() / 1000),
    today: (nowSec) => sydneyDate(nowSec * 1000),
    ctx: () => ({ db: mainDb(), env }),
  })(req);
}
