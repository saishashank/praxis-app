// OPS-109 b (M18 A2, AT-83): the full watchdog run with the 21:50 slot, a database that holds no
// finished `final` heartbeat for last night or today, a stub Resend provider and a stub route.
// Asserts one `evening_heartbeat_missing` incident email, exit 1, and that a second run is
// de-duplicated (one open incident per kind). No network, no secret: the database is a temp libSQL
// file migrated from db/migrations/main, the signed route is a stub that re-computes the HMAC v2
// signature (SEC-115) from the request it receives.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadMigrations, migrateUp } from "../../src/lib/db/migrate-core.mjs";
import { hmacMessage } from "../../src/lib/security/hmacCore.mjs";
import { loadWatchdogLib } from "./lib.mjs";
import { run } from "./run.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SECRET = "ab".repeat(32);
const OWNER = "owner@example.test";
const D = "2026-10-19";
const T_2150 = new Date("2026-10-19T10:50:30.000Z"); // 21:50 AEDT
const ENV = {
  WATCHDOG_SLOT: "2150",
  APP_BASE_URL: "https://praxis.example.test",
  ACTIONS_HMAC_SECRET: SECRET,
  OWNER_EMAIL: OWNER,
  PII_HASH_KEY: "k".repeat(64),
  EMAIL_PROVIDER: "mock",
  PRAXIS_ENV: "production",
};

let dir;
let db;
let lib;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "praxis-wd-"));
  db = createClient({ url: pathToFileURL(path.join(dir, "t.db")).href });
  await migrateUp(db, await loadMigrations(path.join(root, "db", "migrations", "main")));
  lib = await loadWatchdogLib();
  // Incident emails are only sent in modes incidents/full; a system with history (an earlier Worker night).
  await db.execute({
    sql: "INSERT INTO worker_state (key, value_json, updated_at) VALUES ('email_mode', ?, ?)",
    args: [JSON.stringify("incidents"), T_2150.toISOString()],
  });
  for (const day of ["2026-10-10", D]) {
    await db.execute({
      sql: `INSERT INTO run_record (job, market, concurrency_key, started_at, status)
            VALUES ('worker-clock', 'AU', ?, ?, 'success')`,
      args: [`worker-clock:AU:${day}`, T_2150.toISOString()],
    });
  }
});

after(() => {
  try {
    db?.close();
  } catch {
    // ignore
  }
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Windows may keep a lock briefly.
  }
});

/** Stub Resend: records messages, honours the idempotency key like the real provider's window. */
function stubResend() {
  const outbox = [];
  const seen = new Map();
  return {
    name: "mock",
    outbox,
    async send(msg) {
      const prior = seen.get(msg.idempotencyKey);
      if (prior) return { outcome: "accepted", providerId: prior, httpStatus: 200 };
      const id = `stub-${seen.size + 1}`;
      seen.set(msg.idempotencyKey, id);
      outbox.push(msg);
      return { outcome: "accepted", providerId: id, httpStatus: 200 };
    },
  };
}

/** Stub route: verifies the v2 signature, answers { ok: true } so only the heartbeat check can fail. */
function stubRoute() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const h = init.headers;
    const body = String(init.body);
    const message = hmacMessage({
      method: init.method,
      path: new URL(url).pathname,
      timestamp: h["X-Praxis-Timestamp"],
      nonce: h["X-Praxis-Nonce"],
      bodySha256Hex: createHash("sha256").update(body, "utf8").digest("hex"),
    });
    const expected = createHmac("sha256", SECRET).update(message, "utf8").digest("hex");
    calls.push({
      url,
      version: h["X-Praxis-Version"],
      valid: expected === h["X-Praxis-Signature"],
    });
    return new Response(JSON.stringify({ ok: true, status: "sent" }), { status: 200 });
  };
  return { fetchImpl, calls };
}

test("21:50 with no final heartbeat: one evening_heartbeat_missing incident email, exit 1, de-duplicated", async () => {
  const provider = stubResend();
  const route = stubRoute();
  const lines = [];
  const go = () =>
    run(ENV, {
      fetchImpl: route.fetchImpl,
      out: (s) => lines.push(s),
      now: () => T_2150,
      lib,
      db,
      provider,
    });

  assert.equal(lib.melbourneDate(T_2150), D);
  assert.equal(await go(), 1);
  assert.match(lines.join("\n"), /PROBLEM evening_heartbeat_missing/);
  assert.equal(route.calls[0].version, "2");
  assert.equal(route.calls[0].valid, true, "signed with HMAC v2 over method and path");
  const incidents = (await db.execute("SELECT kind FROM incident")).rows.map((r) => r.kind);
  assert.deepEqual(incidents, ["evening_heartbeat_missing"]);
  assert.equal(provider.outbox.length, 1);
  assert.equal(provider.outbox[0].to, OWNER);

  // second run: still failing (the GitHub failure email), but no second incident or email
  assert.equal(await go(), 1);
  assert.equal(
    (await db.execute("SELECT kind FROM incident")).rows.length,
    1,
    "one open incident per kind",
  );
  assert.equal(provider.outbox.length, 1, "no second email");
  const text = lines.join("\n");
  assert.ok(!text.includes(OWNER) && !text.includes(SECRET), "statuses only");
});

test("a finished morning heartbeat of today silences the check (control)", async () => {
  await db.execute("DELETE FROM incident");
  await db.execute({
    sql: `INSERT INTO run_record (job, market, concurrency_key, started_at, status, details_json)
          VALUES ('heartbeat-morning', 'AU', ?, ?, 'success', ?)`,
    args: [`heartbeat-morning:${D}`, T_2150.toISOString(), JSON.stringify({ final: true })],
  });
  assert.equal(await lib.heartbeatGone(db, D), null);
});
