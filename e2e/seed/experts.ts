// M13-lite WP6 e2e seed (the SQL moved into the named state `experts-queue`, TST-135, D-967): two synthetic
// experts (ZZ names, example.test hosts), one red flag with its source, one proposed cluster and three claims
// waiting in the queue. The state module is plain ESM (.mjs, so prepare-db.mjs can load it); Playwright loads
// specs as CommonJS, so it is imported with importEsm. This file keeps the names the specs use. Idempotent.
// No real name (SEC-110).
import { createClient, type Client } from "@libsql/client";
import { importEsm } from "../esm";

export const EXPERT_A = "X-E2E1";
export const EXPERT_B = "X-E2E2";
export const NAME_A = "ZZ Quiet Author";
export const NAME_B = "ZZ Loud Author";
export const FLAG_TEXT = "ZZ fixture caveat: results are the author's own sample.";
export const CLAIM_A = "C-E2E-1";

export async function ensureExperts(): Promise<void> {
  const state = await importEsm<{ apply(client: Client): Promise<void> }>(
    "e2e/seed/states/experts-queue.mjs",
  );
  const m = createClient({ url: process.env.TURSO_MAIN_URL! });
  try {
    await state.apply(m);
  } finally {
    m.close();
  }
}
