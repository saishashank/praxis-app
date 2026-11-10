// Migration CLI (D-030). Usage:
//   node scripts/db/migrate.mjs --if-vercel      (build step: runs only when VERCEL=1; main, then auth)
//   node scripts/db/migrate.mjs --db main|auth   (needs the two env vars for that database)
// Self-hosted sqld (INFRA T4): add `--target sqld` to any form. The URL variables then hold the sqld
// namespace URLs (e.g. http://main.sqld:8080; or SQLD_URL and SQLD_NS_MODE for the namespace of a database whose URL
// variable is unset), the token (SQLD_TOKEN, else the database's own) is optional (only when sqld verifies JWTs),
// the namespace is created first when SQLD_ADMIN_URL is set, and each connection is checked:
// `PRAGMA foreign_keys` is 1 (D-713). The default target is turso and behaves exactly as before.
// Rollback (V2-S4, D-703; the procedure is docs/runbooks/rollback-v2.md):
//   MIGRATE_ALLOW_NEWER=1 (or --allow-newer)       a database AHEAD of this tree is left alone, not an error
//   --db main --down-to <version> --confirm-down   run the `-- +down` sections newest first until <version>
// `--down-to` destroys data (0020 deletes every pick_* e-mail row, 0019 drops the Cortex tables): it
// refuses to run without --confirm-down. Never prints URLs or tokens.
import { createClient } from "@libsql/client";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMigrations, migrateDownTo, migrateUp } from "../../src/lib/db/migrate-core.mjs";
import { assertForeignKeys, ensureNamespace, openNamespace } from "../selfhost/sqld.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const VARS = {
  main: ["TURSO_MAIN_URL", "TURSO_MAIN_TOKEN"],
  auth: ["TURSO_AUTH_URL", "TURSO_AUTH_TOKEN"],
};

/** True when the run targets the self-hosted sqld (set once in main()). */
let sqldTarget = false;

const has = (v) => typeof v === "string" && v.trim() !== "";

async function withClient(name, f) {
  const [urlVar, tokenVar] = VARS[name];
  const url = process.env[urlVar];
  // Self-hosted jobs.env holds no TURSO_AUTH_* (the jobs never get the auth database, ROL-101a): with --target sqld the
  // namespace is then reached through SQLD_URL like restore and the backup scripts do, with SQLD_TOKEN (found by the
  // branch-CI bootstrap rehearsal: praxis deploy and restore-latest migrate both databases from jobs.env).
  const viaBase = sqldTarget && !has(url) && has(process.env.SQLD_URL);
  if (!url && !viaBase) throw new Error(`${urlVar} is not set`);
  const authToken =
    sqldTarget && has(process.env.SQLD_TOKEN) ? process.env.SQLD_TOKEN : process.env[tokenVar];
  if (!authToken && !viaBase && !url.startsWith("file:") && !sqldTarget) {
    throw new Error(`${tokenVar} is not set`);
  }
  if (sqldTarget && process.env.SQLD_ADMIN_URL) {
    await ensureNamespace(process.env.SQLD_ADMIN_URL, name, {
      adminAuth: process.env.SQLD_ADMIN_AUTH,
    });
  }
  const client = viaBase
    ? openNamespace({
        base: process.env.SQLD_URL,
        ns: name,
        token: authToken,
        mode: process.env.SQLD_NS_MODE === "host" ? "host" : "subdomain",
      })
    : createClient({ url, authToken: authToken || undefined });
  try {
    if (sqldTarget) await assertForeignKeys(client, `sqld ${name}`);
    return await f(client, await loadMigrations(path.join(root, "db", "migrations", name)));
  } finally {
    client.close();
  }
}

async function run(name, allowNewer) {
  await withClient(name, async (client, migrations) => {
    const r = await migrateUp(client, migrations, { allowNewer });
    const ahead = r.newer?.length
      ? `; database is ahead of this build (v${r.newer.join(", v")} left alone)`
      : "";
    console.log(`migrate ${name}: applied ${r.applied} (now at v${r.version})${ahead}`);
  });
}

async function down(name, target) {
  await withClient(name, async (client, migrations) => {
    const r = await migrateDownTo(client, migrations, target);
    console.log(`migrate ${name}: rolled back ${r.rolledBack} (now at v${r.version})`);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const ti = args.indexOf("--target");
  const target = ti >= 0 ? args[ti + 1] : "turso";
  if (target !== "turso" && target !== "sqld") throw new Error("usage: --target turso|sqld");
  sqldTarget = target === "sqld";
  const allowNewer = args.includes("--allow-newer") || process.env.MIGRATE_ALLOW_NEWER === "1";
  if (args.includes("--if-vercel")) {
    if (process.env.VERCEL !== "1") {
      console.log("migrate: skipped (not a Vercel build)");
      return;
    }
    await run("main", allowNewer);
    await run("auth", allowNewer);
    return;
  }
  const i = args.indexOf("--db");
  const name = i >= 0 ? args[i + 1] : undefined;
  if (name !== "main" && name !== "auth") {
    throw new Error("usage: --db main|auth or --if-vercel");
  }
  const t = args.indexOf("--down-to");
  if (t >= 0) {
    if (!args.includes("--confirm-down")) {
      throw new Error("usage: --down-to <version> needs --confirm-down (it deletes data)");
    }
    const target = Number(args[t + 1]);
    if (!Number.isInteger(target) || target < 0) throw new Error("usage: --down-to <version>");
    await down(name, target);
    return;
  }
  await run(name, allowNewer);
}

main().catch((e) => {
  // Only our own short messages; never the underlying driver error (could echo a URL).
  const msg =
    e instanceof Error &&
    /^(TURSO_\w+ is not set|usage:|sqld [a-z]+: PRAGMA foreign_keys is not 1|sqld: [A-Za-z() 0-9]+$|migration |applied migration \d+ has no file|rollback:)/.test(
      e.message,
    )
      ? e.message
      : "migration failed";
  console.error(`migrate: ${msg}`);
  process.exit(1);
});
