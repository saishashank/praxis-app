// Signed universe import from the Worker (M2 T11, D-067). POST only: other methods get Next's 405.
import { TursoNonceStore } from "@/lib/security/replay";
import { mainDb } from "@/lib/db/client";
import { sydneyDate } from "@/lib/data/pipeline/rules.mjs";
import { createUniverseImportHandler } from "@/lib/data/universe/handler";
import { importUniverse } from "@/lib/data/universe/import";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const env = process.env;
  return createUniverseImportHandler({
    env,
    store: new TursoNonceStore(env.TURSO_MAIN_URL, env.TURSO_MAIN_TOKEN),
    nowSec: () => Math.floor(Date.now() / 1000),
    today: (nowSec) => sydneyDate(nowSec * 1000),
    importCsv: (csv, today) =>
      importUniverse({
        db: mainDb(),
        csv,
        today,
        now: () => new Date().toISOString(),
        env,
      }),
  })(req);
}
