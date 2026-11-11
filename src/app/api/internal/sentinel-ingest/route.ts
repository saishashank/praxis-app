// Signed Sentinel ingest from the Worker (M5 T5, decision 36). POST only: other methods get Next's 405.
import { TursoNonceStore } from "@/lib/security/replay";
import { mainDb } from "@/lib/db/client";
import { sydneyDate } from "@/lib/data/pipeline/rules.mjs";
import { createSentinelIngestHandler } from "@/lib/sentinel/handler";
import { loadEffectiveCap } from "@/lib/sentinel/cap";
import { ingestFeed } from "@/lib/sentinel/ingest";
import { processAssessments, scheduleFlush } from "@/lib/alerts/deliver";

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
        // DAT-251 b (D-954): the key, bounded by the LLM headroom and, near the Turso line, by 40.
        const cap = await loadEffectiveCap(db, new Date(nowSec * 1000));
        const r = await ingestFeed({
          db,
          feed,
          sha,
          today,
          now: new Date(nowSec * 1000).toISOString(),
          maxItems: cap.cap,
        });
        if (r.ok) {
          // Alerts and the P0 e-mail (M5 T6): a fault here never fails the ingest; the next
          // alert-flush raises whatever is still missing.
          try {
            await processAssessments({ db, env, now: () => new Date(nowSec * 1000) });
          } catch {
            // retried by alert-flush; V1-S9 (D-693): prime the flush so the Worker calls it now
            try {
              const at = new Date(nowSec * 1000);
              await scheduleFlush({ db, env, now: () => at }, at);
            } catch {
              // the Worker's own periodic flush still covers it
            }
          }
        }
        return r;
      } catch {
        return { ok: false, error: "unavailable" };
      }
    },
  })(req);
}
