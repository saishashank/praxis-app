// Migration runner core (D-030). Plain JS + JSDoc so both the TS code and scripts/db/migrate.mjs
// can import it without a build step. Never logs URLs or tokens.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * @typedef {{ version: number, name: string, checksum: string, up: string[], down: string[] }} Migration
 * @typedef {import("@libsql/client").Client} Client
 */

const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/**
 * Split a SQL section into statements. Statements end at a line ending in ";"; inside a
 * CREATE TRIGGER the statement ends only at a line that is exactly "END;".
 * @param {string} text
 * @returns {string[]}
 */
export function splitStatements(text) {
  /** @type {string[]} */
  const out = [];
  let buf = [];
  let inTrigger = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const t = line.trim();
    if (buf.length === 0) {
      if (t === "" || t.startsWith("--")) continue;
      inTrigger = /^CREATE\s+TRIGGER\b/i.test(t);
    }
    buf.push(line);
    const done = inTrigger ? /^END;$/i.test(t) : t.endsWith(";");
    if (done) {
      out.push(buf.join("\n"));
      buf = [];
    }
  }
  if (buf.length > 0) throw new Error("migration section has an unterminated statement");
  return out;
}

/**
 * @param {string} content
 * @param {string} file
 * @returns {{ up: string[], down: string[] }}
 */
export function parseMigration(content, file) {
  const lines = content.split(/\r?\n/);
  const upAt = lines.findIndex((l) => l.trim() === "-- +up");
  const downAt = lines.findIndex((l) => l.trim() === "-- +down");
  if (upAt < 0 || downAt < 0 || downAt < upAt) {
    throw new Error(`migration ${file}: needs '-- +up' then '-- +down' sections`);
  }
  return {
    up: splitStatements(lines.slice(upAt + 1, downAt).join("\n")),
    down: splitStatements(lines.slice(downAt + 1).join("\n")),
  };
}

/**
 * @param {string} dir
 * @returns {Promise<Migration[]>}
 */
export async function loadMigrations(dir) {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  /** @type {Migration[]} */
  const list = [];
  for (const f of files) {
    const m = FILE_RE.exec(f);
    if (!m) throw new Error(`migration file name not allowed: ${f}`);
    const version = Number(m[1]);
    if (version !== list.length + 1) throw new Error(`migration versions must be contiguous: ${f}`);
    const content = await readFile(path.join(dir, f), "utf8");
    const checksum = createHash("sha256").update(content).digest("hex");
    list.push({ version, name: m[2], checksum, ...parseMigration(content, f) });
  }
  return list;
}

/** @param {Client} db */
async function ensureTable(db) {
  await db.execute(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );
}

/** @param {Client} db */
async function appliedRows(db) {
  const r = await db.execute(
    "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
  );
  return r.rows.map((x) => ({
    version: Number(x.version),
    name: String(x.name),
    checksum: String(x.checksum),
  }));
}

/**
 * Apply all pending migrations in order, one transaction per file.
 * @param {Client} db
 * @param {Migration[]} migrations
 * @returns {Promise<{ applied: number, version: number }>}
 */
export async function migrateUp(db, migrations) {
  await ensureTable(db);
  const done = await appliedRows(db);
  for (const row of done) {
    const m = migrations.find((x) => x.version === row.version);
    if (!m) throw new Error(`applied migration ${row.version} has no file`);
    if (m.checksum !== row.checksum) {
      throw new Error(`migration ${row.version} (${row.name}) changed after it was applied`);
    }
  }
  let applied = 0;
  let version = done.length ? done[done.length - 1].version : 0;
  for (const m of migrations) {
    if (done.some((d) => d.version === m.version)) continue;
    await db.batch(
      [
        ...m.up,
        {
          sql: "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
          args: [m.version, m.name, m.checksum, new Date().toISOString()],
        },
      ],
      "write",
    );
    applied++;
    version = m.version;
  }
  return { applied, version };
}

/**
 * Roll back the last n applied migrations.
 * @param {Client} db
 * @param {Migration[]} migrations
 * @param {number} n
 * @returns {Promise<{ rolledBack: number, version: number }>}
 */
export async function migrateDown(db, migrations, n) {
  await ensureTable(db);
  const done = (await appliedRows(db)).reverse().slice(0, n);
  let rolledBack = 0;
  for (const row of done) {
    const m = migrations.find((x) => x.version === row.version);
    if (!m) throw new Error(`applied migration ${row.version} has no file`);
    await db.batch(
      [...m.down, { sql: "DELETE FROM schema_migrations WHERE version = ?", args: [m.version] }],
      "write",
    );
    rolledBack++;
  }
  const rest = await appliedRows(db);
  return { rolledBack, version: rest.length ? rest[rest.length - 1].version : 0 };
}
