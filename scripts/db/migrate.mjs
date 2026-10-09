// Migration CLI (D-030). Usage:
//   node scripts/db/migrate.mjs --if-vercel      (build step: runs only when VERCEL=1; main, then auth)
//   node scripts/db/migrate.mjs --db main|auth   (needs the two env vars for that database)
// Never prints URLs or tokens.
import { createClient } from "@libsql/client";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMigrations, migrateUp } from "../../src/lib/db/migrate-core.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const VARS = {
  main: ["TURSO_MAIN_URL", "TURSO_MAIN_TOKEN"],
  auth: ["TURSO_AUTH_URL", "TURSO_AUTH_TOKEN"],
};

async function run(name) {
  const [urlVar, tokenVar] = VARS[name];
  const url = process.env[urlVar];
  if (!url) throw new Error(`${urlVar} is not set`);
  const authToken = process.env[tokenVar];
  if (!authToken && !url.startsWith("file:")) throw new Error(`${tokenVar} is not set`);
  const client = createClient({ url, authToken: authToken || undefined });
  try {
    const migrations = await loadMigrations(path.join(root, "db", "migrations", name));
    const r = await migrateUp(client, migrations);
    console.log(`migrate ${name}: applied ${r.applied} (now at v${r.version})`);
  } finally {
    client.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--if-vercel")) {
    if (process.env.VERCEL !== "1") {
      console.log("migrate: skipped (not a Vercel build)");
      return;
    }
    await run("main");
    await run("auth");
    return;
  }
  const i = args.indexOf("--db");
  const name = i >= 0 ? args[i + 1] : undefined;
  if (name !== "main" && name !== "auth") throw new Error("usage: --db main|auth or --if-vercel");
  await run(name);
}

main().catch((e) => {
  // Only our own short messages; never the underlying driver error (could echo a URL).
  const msg =
    e instanceof Error && /^(TURSO_\w+ is not set|usage:|migration )/.test(e.message)
      ? e.message
      : "migration failed";
  console.error(`migrate: ${msg}`);
  process.exit(1);
});
