// Signed Sentinel ingest from the Worker (M5 T5, decision 36). POST only: other methods get Next's 405.
import { TursoNonceStore } from "@/lib/security/replay";
import { mainDb } from "@/lib/db/client";
import { getConfig } from "@/lib/config/store";
import { sydneyDate } from "@/lib/data/pipeline/rules.mjs";
import { createSentinelIngestHandler } from "@/lib/sentinel/handler";
import { ingestFeed } from "@/lib/sentinel/ingest";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Hobby allows up to 60 s [VERIFY]; the work is one parse and two small batches.
export const maxDuration = 30;

export async function POST(req: Request): Promise<Response> {
  const env = process.env;
  return createSentinelIngestHandler({
    env,
    store: new TursoNonceStore(env.TURSO_MAIN_URL, env.TURSO_MAIN_TOKEN),
    nowSec: () => Math.floor(Date.now() / 1000),
    today: (nowSec) => sydneyDate(nowSec * 1000),
    ingest: async (feed, sha, today, nowSec) => {
      try {
        const db = mainDb();
        const cap = await getConfig(db, "sentinel_max_items_per_run");
        return await ingestFeed({
          db,
          feed,
          sha,
          today,
          now: new Date(nowSec * 1000).toISOString(),
          maxItems: typeof cap === "number" ? cap : undefined,
        });
      } catch {
        return { ok: false, error: "unavailable" };
      }
    },
  })(req);
}
