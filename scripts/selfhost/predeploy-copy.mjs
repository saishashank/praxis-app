// INFRA T7 (REQ\infra\INFRA_REQUIREMENT.md §10): a plain (unencrypted) snapshot of the sqld namespaces "main" and
// "auth" to a folder, and the way back. Used by scripts/selfhost/predeploy.mjs:
//   dump  the local pre-deploy snapshot of prod (read-only on prod) in /srv/praxis/backups/pre-deploy-<sha>-<ts>,
//         and the fallback data of the check when last night's backup cannot be decrypted on the box
//   load  restore such a folder into the (empty) namespaces of the throwaway check sqld, verified
//         (counts, sha256, PRAGMA foreign_keys = 1, no orphans), same checks as latest-backup.mjs
// The folder lives on the same host and disk as the sqld files themselves, is created 0700, files 0600, and the
// pre-check copy is deleted when the check ends. Ephemeral tables (sessions, nonces) are left out by the dump.
//   node scripts/selfhost/predeploy-copy.mjs dump --out <dir>
//   node scripts/selfhost/predeploy-copy.mjs load --in <dir>
// env: SQLD_URL [SQLD_NS_MODE=subdomain|host] [SQLD_ADMIN_URL, SQLD_ADMIN_AUTH] and SQLD_TOKEN or TURSO_MAIN_TOKEN /
//   TURSO_AUTH_TOKEN (same names as latest-backup.mjs). Output: names, counts and PASS/FAIL; never a URL, token or row.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDatabase } from "../backup/core.mjs";
import { ensureNamespace, openNamespace, restoreVerified, SqldError } from "./sqld.mjs";

const DBS = ["main", "auth"];
const has = (v) => typeof v === "string" && v.trim() !== "";

function open(env, db) {
  if (!has(env.SQLD_URL)) throw new SqldError("SQLD_URL is not set");
  const token = has(env.SQLD_TOKEN)
    ? env.SQLD_TOKEN
    : env[db === "main" ? "TURSO_MAIN_TOKEN" : "TURSO_AUTH_TOKEN"];
  return openNamespace({
    base: env.SQLD_URL,
    ns: db,
    token,
    mode: env.SQLD_NS_MODE === "host" ? "host" : "subdomain",
    intMode: "bigint",
  });
}

/** @param {string[]} argv @param {Record<string, string | undefined>} env */
export async function run(argv, env, deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const openDb = deps.open ?? ((db) => open(env, db));
  try {
    const mode = argv[0];
    const flag = mode === "dump" ? "--out" : mode === "load" ? "--in" : "";
    if (!flag || argv[1] !== flag || !has(argv[2]) || argv.length !== 3) {
      throw new SqldError("usage: dump --out <dir> | load --in <dir>");
    }
    const dir = path.resolve(argv[2]);
    if (mode === "dump") {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        chmodSync(dir, 0o700);
      } catch {
        /* not supported on this platform */
      }
      for (const db of DBS) {
        const client = openDb(db);
        try {
          const d = await dumpDatabase(client, { name: db, createdAt: new Date().toISOString() });
          writeFileSync(path.join(dir, `${db}.ndjson`), d.text, { mode: 0o600 });
          const rows = Object.values(d.counts).reduce((n, c) => n + c, 0);
          out(
            `predeploy-copy: ${db}: dumped ${Object.keys(d.counts).length} tables, ${rows} rows (schema v${d.meta.schema_version})`,
          );
        } finally {
          client.close();
        }
      }
      out("predeploy-copy: dump PASS");
      return 0;
    }
    for (const db of DBS) {
      const file = path.join(dir, `${db}.ndjson`);
      if (!existsSync(file)) throw new SqldError(`${db}: snapshot file is missing`);
      const text = readFileSync(file, "utf8");
      if (!deps.open && has(env.SQLD_ADMIN_URL)) {
        await ensureNamespace(env.SQLD_ADMIN_URL, db, { adminAuth: env.SQLD_ADMIN_AUTH });
      }
      const client = openDb(db);
      try {
        const r = await restoreVerified(client, text, { expectDb: db });
        out(
          `predeploy-copy: ${db}: restore PASS (schema v${r.schemaVersion}, tables=${r.tables}, rows=${r.rows}, foreign keys ON, no orphans)`,
        );
      } finally {
        client.close();
      }
    }
    out("predeploy-copy: load PASS");
    return 0;
  } catch (e) {
    out(`predeploy-copy: FAIL ${e instanceof SqldError ? e.message : "unexpected error"}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await run(process.argv.slice(2), process.env);
}
