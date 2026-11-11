// Creates the local libSQL files for the E2E run, applies the real migrations and seeds three
// test users (.test addresses only). Everything comes from the environment set by
// playwright.config.ts; nothing here is a secret and nothing is committed.
import { createClient } from "@libsql/client";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyScenario } from "./seed/index.mjs";
import { applyStates, parseStates } from "./seed/states.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const need = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
};

mkdirSync(need("E2E_DIR"), { recursive: true });
for (const db of ["main", "auth"]) {
  const r = spawnSync(process.execPath, [path.join(root, "scripts/db/migrate.mjs"), "--db", db], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const client = createClient({ url: need("TURSO_AUTH_URL") });
const now = new Date().toISOString();
try {
  for (const [email, role] of [
    ["owner@praxis.test", "owner"],
    ["editor@praxis.test", "editor"],
    ["viewer@praxis.test", "viewer"],
  ]) {
    await client.execute({
      sql: `INSERT OR IGNORE INTO app_user (email, name, role, status, created_at, updated_at)
            VALUES (?, ?, ?, 'active', ?, ?)`,
      args: [email, `E2E ${role}`, role, now, now],
    });
  }
} finally {
  client.close();
}
// E2E_SCENARIO: empty (default, production-like data-only) | populated | stale (synthetic ZZ data).
// E2E_STATES (TST-135, D-967): comma-separated named overlays applied after the scenario, or "all" (see
// e2e/seed/states.mjs: picks-two-sections, experts-queue, steelman-cards, alerts-muted, market-built-off,
// blueprint-full). Unset = none. An unknown name stops the run.
const stateNames = parseStates(process.env.E2E_STATES);
const scenario = process.env.E2E_SCENARIO ?? "empty";
const main = createClient({ url: need("TURSO_MAIN_URL") });
try {
  const seeded = await applyScenario(main, scenario);
  console.log(
    `e2e: scenario ${seeded.scenario} (${seeded.instruments} instruments, ${seeded.bars} bars)`,
  );
  if (stateNames.length > 0) {
    await applyStates(main, stateNames);
    console.log(`e2e: states ${stateNames.join(", ")}`);
  }
} finally {
  main.close();
}
console.log("e2e: databases ready");
