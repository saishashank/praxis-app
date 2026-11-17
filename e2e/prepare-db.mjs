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
import { apply as applyMarketsDev } from "./seed/states/markets-dev.mjs";

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
// E2E_STATES (TST-135, D-967): comma-separated named overlays applied after the scenario, or "all" (every state except the opt-in owner-tools-on; "all,owner-tools-on" adds it; see
// e2e/seed/states.mjs: picks-two-sections, experts-queue, steelman-cards, alerts-muted, market-built-off,
// blueprint-full, owner-tools-on, review-stored, labels-queue, committee-trial, experts-sources). Unset = none. An unknown name stops the run.
const stateNames = parseStates(process.env.E2E_STATES);
const scenario = process.env.E2E_SCENARIO ?? "empty";
const main = createClient({ url: need("TURSO_MAIN_URL") });
try {
  const seeded = await applyScenario(main, scenario);
  console.log(
    `e2e: scenario ${seeded.scenario} (${seeded.instruments} instruments, ${seeded.bars} bars)`,
  );
  if (stateNames.length > 0) {
    // pick_alert.user_id is String(app_user.id): the seeded viewer's id is only known after the auth rows exist.
    const auth = createClient({ url: need("TURSO_AUTH_URL") });
    let viewerId;
    try {
      const v = await auth.execute({
        sql: "SELECT id FROM app_user WHERE email = ?",
        args: ["viewer@praxis.test"],
      });
      viewerId = String(v.rows[0].id);
    } finally {
      auth.close();
    }
    await applyStates(main, stateNames, undefined, { viewerId });
    console.log(`e2e: states ${stateNames.join(", ")}`);
  }
  // M19 D-994 / D-1077: a development lane that sets PRAXIS_MARKETS_ENABLED (for example AU,IN,US) enables those built
  // markets here; unset (every CI lane) the database keeps the production shape (AU only).
  if ((process.env.PRAXIS_MARKETS_ENABLED ?? "").trim() !== "") {
    const enabled = await applyMarketsDev(main);
    console.log(`e2e: markets enabled ${enabled.join(", ")}`);
  }
} finally {
  main.close();
}
console.log("e2e: databases ready");
