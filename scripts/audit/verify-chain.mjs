// Owner-run audit chain verifier (NFR-023, V1-S4). Zero app imports; mirrors src/lib/db/audit.ts.
// Usage: TURSO_AUTH_URL=... TURSO_AUTH_TOKEN=... PII_HASH_KEY=... node scripts/audit/verify-chain.mjs
//   (a local file: URL needs no token). Exit 0 = chain verifies, 1 = broken at row N, 2 = not configured.
// Prints only the row count or the first broken row id; never a key, token or row content.
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";

const GENESIS = "0".repeat(64);
const auditKey = (piiHashKey) =>
  createHmac("sha256", piiHashKey).update("praxis-audit-chain-v1").digest();

/** Returns { rows, brokenId } where brokenId is null when the whole chain verifies. */
export async function verifyChain(db, piiHashKey) {
  const key = auditKey(piiHashKey);
  const res = await db.execute(
    "SELECT id, at, actor_user_id, action, target_type, target_id, detail_json, prev_hmac, row_hmac FROM audit_event ORDER BY id",
  );
  let prev = GENESIS;
  for (const r of res.rows) {
    const content = JSON.stringify([
      String(r.at),
      r.actor_user_id === null ? null : Number(r.actor_user_id),
      String(r.action),
      r.target_type === null ? null : String(r.target_type),
      r.target_id === null ? null : String(r.target_id),
      r.detail_json === null ? null : String(r.detail_json),
    ]);
    const expect = createHmac("sha256", key).update(`${prev}|${content}`).digest("hex");
    if (String(r.prev_hmac) !== prev || String(r.row_hmac) !== expect) {
      return { rows: res.rows.length, brokenId: Number(r.id) };
    }
    prev = String(r.row_hmac);
  }
  return { rows: res.rows.length, brokenId: null };
}

export async function run(env, makeClient, out) {
  const has = (v) => typeof v === "string" && v.trim() !== "";
  if (!has(env.TURSO_AUTH_URL) || !has(env.PII_HASH_KEY)) {
    out("audit: not configured (TURSO_AUTH_URL or PII_HASH_KEY not set)");
    return 2;
  }
  const db = makeClient(env.TURSO_AUTH_URL, env.TURSO_AUTH_TOKEN);
  try {
    const { rows, brokenId } = await verifyChain(db, env.PII_HASH_KEY);
    if (brokenId === null) {
      out(`audit: chain ok (${rows} rows)`);
      return 0;
    }
    out(`audit: chain BROKEN at row ${brokenId} (of ${rows})`);
    return 1;
  } finally {
    db.close?.();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { createClient } = await import("@libsql/client");
  const code = await run(
    process.env,
    (url, authToken) => createClient({ url, authToken: authToken || undefined }),
    (l) => console.log(l),
  );
  process.exit(code);
}
