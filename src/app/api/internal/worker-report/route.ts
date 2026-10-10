// Signed Worker self-check report (SEC-101, SEC-017 c2). POST only: other methods get Next's 405.
import { TursoNonceStore } from "@/lib/security/replay";
import { mainDb } from "@/lib/db/client";
import { createWorkerReportHandler } from "@/lib/workerReport/handler";
import { recordWorkerReport } from "@/lib/workerReport/record";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const env = process.env;
  return createWorkerReportHandler({
    env,
    store: new TursoNonceStore(env.TURSO_MAIN_URL, env.TURSO_MAIN_TOKEN),
    nowSec: () => Math.floor(Date.now() / 1000),
    recordRun: (report) => recordWorkerReport(mainDb(), report),
  })(req);
}
