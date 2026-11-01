// Build-phase source for the Turso drill (TST-108, D-046): SYNTHETIC data only. Builds a main and
// an auth database in memory through the real migrations, adds fake rows (including price bars for
// the check cohort), exports both encrypted to a throwaway age key generated here, and returns the
// ciphertext plus the throwaway identity. Nothing is read from production, nothing is written to
// disk, the throwaway key exists only in memory.
import { createClient } from "@libsql/client";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateIdentity, identityToRecipient } from "age-encryption";
import { loadMigrations, migrateUp } from "../../src/lib/db/migrate-core.mjs";
import { exportEncrypted } from "../backup/core.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const SYNTH_NOW = "2026-01-02T03:04:05.678Z";
export const SYNTH_MARKER = "SYNTH-ROW-MARKER-77c1"; // must never appear in any output

const CODES = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG"];

function isoDay(i) {
  return new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
}

async function seedMain(db) {
  for (let ci = 0; ci < CODES.length; ci++) {
    for (let i = 0; i < 70; i++) {
      // Deterministic synthetic prices with two decimals and some movement.
      const c = Math.round((10 + ci * 3 + Math.sin(i / 5 + ci) * 2 + i * 0.03) * 100) / 100;
      await db.execute({
        sql: `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
              VALUES ('AU', ?, ?, ?, ?, ?, ?, ?, 'synthetic', ?, ?)`,
        args: [CODES[ci], isoDay(i), c, c + 0.1, c - 0.1, c, 1000 + i, SYNTH_NOW, SYNTH_NOW],
      });
    }
  }
  await db.execute({
    sql: "INSERT INTO app_log (at, level, source, message) VALUES (?, 'info', 'drill', ?)",
    args: [SYNTH_NOW, `${SYNTH_MARKER} log`],
  });
}

async function seedAuth(db) {
  await db.execute({
    sql: `INSERT INTO app_user (email, name, role, status, created_at, updated_at)
          VALUES (?, ?, 'owner', 'active', ?, ?)`,
    args: ["drill-owner@example.test", `${SYNTH_MARKER} owner`, SYNTH_NOW, SYNTH_NOW],
  });
  // V1-S6 / D-714: child rows with a foreign key to app_user, so the drill proves the restore fills
  // parents before children (the stream lists user_preference after app_user only by luck of name).
  await db.execute({
    sql: "INSERT INTO user_preference (user_id, prefs_json, updated_at) SELECT id, '{}', ? FROM app_user",
    args: [SYNTH_NOW],
  });
}

/** @returns {Promise<{ identity: string, cipher: { main: Uint8Array, auth: Uint8Array } }>} */
export async function buildSynthetic() {
  const identity = await generateIdentity();
  const recipient = await identityToRecipient(identity);
  const cipher = {};
  for (const name of ["main", "auth"]) {
    const db = createClient({ url: ":memory:" });
    try {
      await migrateUp(db, await loadMigrations(path.join(root, "db", "migrations", name)));
      if (name === "main") await seedMain(db);
      else await seedAuth(db);
      const exp = await exportEncrypted(db, { name, createdAt: SYNTH_NOW, recipient });
      cipher[name] = exp.data;
    } finally {
      db.close();
    }
  }
  return { identity, cipher: /** @type {any} */ (cipher) };
}
