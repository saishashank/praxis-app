// Signed auth-DB backup export (DAT-143, ROL-101a, PLT-022b). POST only: other methods get 405.
// Returns age ciphertext for BACKUP_PUBLIC_KEY, never plaintext.
import { TursoNonceStore } from "@/lib/security/replay";
import { authDb } from "@/lib/db/client";
import { createBackupExportHandler } from "@/lib/backup/exportHandler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const env = process.env;
  return createBackupExportHandler({
    env,
    store: new TursoNonceStore(env.TURSO_MAIN_URL, env.TURSO_MAIN_TOKEN),
    nowSec: () => Math.floor(Date.now() / 1000),
    authDb,
  })(req);
}
