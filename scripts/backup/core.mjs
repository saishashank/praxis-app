// Backup core (PLT-022, PLT-022b, DAT-143, NFR-004, TST-108). Plain JS + JSDoc so the Vercel
// export route (via src/lib/backup/*), scripts/backup/run.mjs and scripts/backup/drill.mjs share
// ONE implementation (same pattern as src/lib/db/migrate-core.mjs, D-030). Opus reviews every line.
//
// File format (one file per database, then gzip, then age-encrypt to BACKUP_PUBLIC_KEY):
//   NDJSON, one JSON object per line, "\n" terminated:
//   {"kind":"meta","format":1,"db":"main|auth","schema_version":N,"created_at":ISO,
//    "tables":[data tables],"ephemeral":[tables with schema only],"forever":[DAT-142 tables]}
//   per table (schema for EVERY table; rows only for data tables):
//     {"kind":"schema","type":"table","table":t,"sql":<CREATE from sqlite_master>,"ephemeral"?:true}
//     {"kind":"row","table":t,"values":[...]}     BLOB -> {"$b64":..}, bigint -> {"$int":".."},
//                                                  non-finite number -> {"$f":".."}
//   then one schema line per index / trigger / view:
//     {"kind":"schema","type":"index|trigger|view","name":n,"table":t,"sql":...}
//   last line: {"kind":"end","counts":{t:n},"sha256":{t:<sha256 of the table's row lines, each
//     followed by "\n">}}
// Restore refuses a stream whose structure, row counts or checksums do not match (parseBackup).
//
// Plaintext never touches disk: dump -> gzip -> encrypt all happen in memory (small at M1).
// TODO(streaming): stream rows through gzip and age (Encrypter accepts a ReadableStream) once a
// database no longer fits comfortably in memory; the Vercel route also has a response size limit.
// Known limits (documented, not silent): integers beyond 2^53 make the dump fail (libsql
// intMode "number" throws); a REAL that is a whole number (1.0) is stored as 1 (JSON) and takes
// the column's affinity on restore; AUTOINCREMENT sequences are not carried (none used at M1).
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { Decrypter, Encrypter } from "age-encryption";

/**
 * @typedef {import("@libsql/client").Client} Client
 * @typedef {"main" | "auth"} DbName
 * @typedef {{ kind: "meta", format: number, db: DbName, schema_version: number, created_at: string,
 *   tables: string[], ephemeral: string[], forever: string[] }} Meta
 */

export const FORMAT_VERSION = 1;

/** Ephemeral tables: schema is kept (so a restored DB works), rows are never exported. */
export const EPHEMERAL_TABLES = Object.freeze({
  main: Object.freeze(["request_nonce"]),
  auth: Object.freeze(["rate_limit"]),
});

/**
 * DAT-142 "forever" tables (decision cards, trades/fills/ledgers, lessons, change ledger,
 * documents, universe_snapshot, corporate_action, adjustment_factor, trading_calendar,
 * source_register, audit events). Names are provisional until the later schema tasks create
 * them; the dump takes every non-ephemeral table, this list only labels them in the meta line.
 */
export const FOREVER_TABLES = Object.freeze([
  "decision_card",
  "trade",
  "fill",
  "ledger",
  "lesson",
  "change_ledger",
  "document",
  "universe_snapshot",
  "corporate_action",
  "adjustment_factor",
  "trading_calendar",
  "source_register",
  "audit_event",
  // M2 AU data layer (migration 0004): forever per design section 2. No new table is ephemeral:
  // asx_rate_token, worker_state, ingest_cursor and backfill_job are small state that a restore
  // needs (the token row must exist for the compare-and-set).
  "market",
  "instrument",
  "corporate_action_event",
  "source_register_history",
  "quality_score",
  "completion_marker",
]);

const MAX_PLAINTEXT_BYTES = 2 ** 30; // gunzip output cap (decompression-bomb guard)
const AGE_HEADER = "age-encryption.org/v1\n";
const RECIPIENT_RE = /^age1[02-9ac-hj-np-z]{58}$/;
const HEX64 = /^[0-9a-f]{64}$/;

const quote = (name) => `"${String(name).replaceAll('"', '""')}"`;

// ---------------------------------------------------------------------------------------------
// Value encoding

/**
 * @param {unknown} v a libsql column value
 * @returns {unknown} JSON-safe value
 */
export function encodeValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : { $f: String(v) };
  if (typeof v === "bigint") return { $int: v.toString() };
  if (v instanceof ArrayBuffer) return { $b64: Buffer.from(v).toString("base64") };
  if (ArrayBuffer.isView(v)) {
    return { $b64: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64") };
  }
  throw new Error("unsupported column value");
}

/**
 * @param {unknown} v
 * @returns {null | string | number | bigint | ArrayBuffer}
 */
export function decodeValue(v) {
  if (v === null || typeof v === "string") return v;
  if (typeof v === "number") return v;
  if (typeof v === "object" && !Array.isArray(v)) {
    const keys = Object.keys(v);
    if (keys.length === 1) {
      const o = /** @type {Record<string, unknown>} */ (v);
      if (keys[0] === "$int" && typeof o.$int === "string" && /^-?\d+$/.test(o.$int)) {
        return BigInt(o.$int);
      }
      if (keys[0] === "$b64" && typeof o.$b64 === "string") {
        const b = Buffer.from(o.$b64, "base64");
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      }
      if (
        keys[0] === "$f" &&
        typeof o.$f === "string" &&
        ["Infinity", "-Infinity", "NaN"].includes(o.$f)
      ) {
        return Number(o.$f);
      }
    }
  }
  throw new Error("bad value");
}

// ---------------------------------------------------------------------------------------------
// Dump

const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");

/** ORDER BY clause that makes row order deterministic for a table. */
async function orderBy(tx, table, createSql) {
  if (!/WITHOUT\s+ROWID/i.test(createSql)) return "rowid";
  const info = await tx.execute(`PRAGMA table_info(${quote(table)})`);
  const pk = info.rows
    .filter((r) => Number(r.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map((r) => quote(String(r.name)));
  return pk.length ? pk.join(", ") : "1";
}

/**
 * Dump one database to NDJSON text from a single read transaction (one consistent snapshot).
 * @param {Client} db
 * @param {{ name: DbName, createdAt: string, ephemeral?: readonly string[] }} opts
 * @returns {Promise<{ text: string, meta: Meta, counts: Record<string, number>, sha256: Record<string, string> }>}
 */
export async function dumpDatabase(db, opts) {
  const ephemeral = opts.ephemeral ?? EPHEMERAL_TABLES[opts.name];
  const tx = await db.transaction("read");
  try {
    const master = await tx.execute(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const objs = master.rows.map((r) => ({
      type: String(r.type),
      name: String(r.name),
      table: String(r.tbl_name),
      sql: String(r.sql),
    }));
    const tables = objs.filter((o) => o.type === "table");
    const others = objs.filter((o) => o.type !== "table");
    const dataTables = tables.map((t) => t.name).filter((n) => !ephemeral.includes(n));

    let version = 0;
    try {
      const v = await tx.execute("SELECT MAX(version) AS v FROM schema_migrations");
      version = Number(v.rows[0]?.v ?? 0);
    } catch {
      // no schema_migrations table: version 0
    }

    /** @type {Meta} */
    const meta = {
      kind: "meta",
      format: FORMAT_VERSION,
      db: opts.name,
      schema_version: version,
      created_at: opts.createdAt,
      tables: dataTables,
      ephemeral: tables.map((t) => t.name).filter((n) => ephemeral.includes(n)),
      forever: dataTables.filter((n) => FOREVER_TABLES.includes(n)),
    };
    const lines = [JSON.stringify(meta)];
    /** @type {Record<string, number>} */
    const counts = {};
    /** @type {Record<string, string>} */
    const sha256 = {};

    for (const t of tables) {
      const isEphemeral = ephemeral.includes(t.name);
      lines.push(
        JSON.stringify({
          kind: "schema",
          type: "table",
          table: t.name,
          sql: t.sql,
          ...(isEphemeral ? { ephemeral: true } : {}),
        }),
      );
      if (isEphemeral) continue;
      const res = await tx.execute(
        `SELECT * FROM ${quote(t.name)} ORDER BY ${await orderBy(tx, t.name, t.sql)}`,
      );
      const hash = createHash("sha256");
      for (const row of res.rows) {
        const values = res.columns.map((_, i) => encodeValue(row[i]));
        const line = JSON.stringify({ kind: "row", table: t.name, values });
        hash.update(`${line}\n`);
        lines.push(line);
      }
      counts[t.name] = res.rows.length;
      sha256[t.name] = hash.digest("hex");
    }
    for (const o of others) {
      lines.push(
        JSON.stringify({ kind: "schema", type: o.type, name: o.name, table: o.table, sql: o.sql }),
      );
    }
    lines.push(JSON.stringify({ kind: "end", counts, sha256 }));
    return { text: `${lines.join("\n")}\n`, meta, counts, sha256 };
  } finally {
    tx.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Parse / restore

class BackupError extends Error {}
const fail = (why) => {
  throw new BackupError(`backup stream rejected: ${why}`);
};
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Validate a whole stream (structure, per-table row counts, per-table sha256) WITHOUT touching
 * any database. Throws BackupError (message names the problem class, never row content).
 * @param {string} text
 */
export function parseBackup(text) {
  if (typeof text !== "string" || !text.endsWith("\n")) fail("truncated (no final newline)");
  const raw = text.slice(0, -1).split("\n");
  /** @type {any[]} */
  const objs = [];
  for (const line of raw) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      fail("line is not JSON");
    }
    if (!isObj(o) || typeof o.kind !== "string") fail("line has no kind");
    objs.push(o);
  }
  const meta = objs[0];
  if (meta.kind !== "meta" || meta.format !== FORMAT_VERSION) fail("first line is not a v1 meta");
  if (meta.db !== "main" && meta.db !== "auth") fail("unknown database name");
  if (!Array.isArray(meta.tables) || !Array.isArray(meta.ephemeral)) fail("bad meta");
  const end = objs[objs.length - 1];
  if (end.kind !== "end") fail("truncated (no end line)");
  if (!isObj(end.counts) || !isObj(end.sha256)) fail("bad end line");

  /** @type {{ type: string, table: string, name?: string, sql: string, ephemeral: boolean }[]} */
  const schemas = [];
  /** @type {Map<string, { lines: string[], rows: unknown[][] }>} */
  const data = new Map();
  const declared = new Set();
  for (let i = 1; i < objs.length - 1; i++) {
    const o = objs[i];
    if (o.kind === "schema") {
      if (typeof o.sql !== "string" || typeof o.table !== "string") fail("bad schema line");
      if (!["table", "index", "trigger", "view"].includes(o.type)) fail("bad schema type");
      if (o.type === "table") {
        if (declared.has(o.table)) fail("duplicate table");
        declared.add(o.table);
        const eph = o.ephemeral === true;
        if (eph !== meta.ephemeral.includes(o.table)) fail("ephemeral flag disagrees with meta");
        if (!eph) data.set(o.table, { lines: [], rows: [] });
      } else if (typeof o.name !== "string") fail("bad schema line");
      schemas.push({
        type: o.type,
        table: o.table,
        name: o.name,
        sql: o.sql,
        ephemeral: o.ephemeral === true,
      });
    } else if (o.kind === "row") {
      const t = data.get(o.table);
      if (!t || !Array.isArray(o.values)) fail("row for an undeclared table");
      t.lines.push(raw[i]);
      t.rows.push(o.values);
    } else fail("unexpected line kind");
  }
  // The table list must be exactly the data tables seen, in meta order.
  const seen = [...data.keys()];
  if (seen.length !== meta.tables.length || seen.some((n, i) => n !== meta.tables[i])) {
    fail("table list differs from meta");
  }
  for (const name of seen) {
    const t = data.get(name);
    if (end.counts[name] !== t.rows.length) fail("row count mismatch");
    const want = end.sha256[name];
    if (typeof want !== "string" || !HEX64.test(want)) fail("bad checksum");
    const got = sha256Hex(t.lines.map((l) => `${l}\n`).join(""));
    if (got !== want) fail("checksum mismatch");
  }
  if (
    Object.keys(end.counts).length !== seen.length ||
    Object.keys(end.sha256).length !== seen.length
  ) {
    fail("end line lists unknown tables");
  }
  return { meta: /** @type {Meta} */ (meta), schemas, data, end };
}

/**
 * Restore a stream into an EMPTY database in one atomic batch, then re-read the restored
 * database and compare every table's count and sha256 with the stream's end line.
 * Refuses a stream that does not verify (before writing anything) and a non-empty target.
 * @param {Client} db
 * @param {string} text
 * @returns {Promise<{ meta: Meta, counts: Record<string, number>, sha256: Record<string, string> }>}
 */
export async function restoreDatabase(db, text) {
  const parsed = parseBackup(text);
  const existing = await db.execute(
    "SELECT COUNT(*) AS c FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
  );
  if (Number(existing.rows[0].c) !== 0) fail("target database is not empty");

  /** @type {import("@libsql/client").InStatement[]} */
  const stmts = [];
  for (const s of parsed.schemas) if (s.type === "table") stmts.push(s.sql);
  for (const [table, t] of parsed.data) {
    for (const values of t.rows) {
      stmts.push({
        sql: `INSERT INTO ${quote(table)} VALUES (${values.map(() => "?").join(", ")})`,
        args: values.map(decodeValue),
      });
    }
  }
  // Indexes, triggers and views last: no trigger fires for the restore's own inserts.
  for (const s of parsed.schemas) if (s.type !== "table") stmts.push(s.sql);
  await db.batch(stmts, "write");

  const again = await dumpDatabase(db, {
    name: parsed.meta.db,
    createdAt: parsed.meta.created_at,
    ephemeral: parsed.meta.ephemeral,
  });
  for (const name of parsed.meta.tables) {
    if (again.counts[name] !== parsed.end.counts[name]) fail("restored row count mismatch");
    if (again.sha256[name] !== parsed.end.sha256[name]) fail("restored checksum mismatch");
  }
  return { meta: parsed.meta, counts: again.counts, sha256: again.sha256 };
}

// ---------------------------------------------------------------------------------------------
// Encryption (age, X25519 recipient)

/**
 * A BACKUP_PUBLIC_KEY value: a native age X25519 recipient (`age1` + 58 bech32 characters),
 * after trimming surrounding whitespace. Anything else (empty, multi-line, secret key,
 * malformed) is invalid. Returns the normalised recipient or null.
 * @param {unknown} value
 * @returns {string | null}
 */
export function parseRecipient(value) {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!RECIPIENT_RE.test(s)) return null;
  try {
    new Encrypter().addRecipient(s); // the library validates the bech32 checksum
  } catch {
    return null;
  }
  return s;
}

/**
 * @param {Uint8Array} plain
 * @param {string} recipient a valid age1... recipient
 * @returns {Promise<Uint8Array>}
 */
export async function encryptBytes(plain, recipient) {
  const r = parseRecipient(recipient);
  if (r === null) throw new Error("invalid backup public key");
  const e = new Encrypter();
  e.addRecipient(r);
  return e.encrypt(plain);
}

/**
 * @param {Uint8Array} cipher
 * @param {string} identity AGE-SECRET-KEY-1... (offline key, or the drill's throwaway key)
 * @returns {Promise<Uint8Array>}
 */
export async function decryptBytes(cipher, identity) {
  const d = new Decrypter();
  d.addIdentity(identity);
  return d.decrypt(cipher);
}

/** True when the bytes start like a binary age file (used to refuse plaintext by mistake). */
export function looksLikeAge(bytes) {
  return (
    bytes.length > AGE_HEADER.length &&
    Buffer.from(bytes.subarray(0, AGE_HEADER.length)).toString("latin1") === AGE_HEADER
  );
}

/**
 * Dump -> gzip -> age-encrypt, all in memory.
 * @param {Client} db
 * @param {{ name: DbName, createdAt: string, recipient: string }} opts
 */
export async function exportEncrypted(db, opts) {
  const dump = await dumpDatabase(db, { name: opts.name, createdAt: opts.createdAt });
  const gz = gzipSync(Buffer.from(dump.text, "utf8"));
  const data = await encryptBytes(gz, opts.recipient);
  return {
    data,
    tables: dump.meta.tables,
    counts: dump.counts,
    sha256: dump.sha256,
    schemaVersion: dump.meta.schema_version,
  };
}

/**
 * age-decrypt -> gunzip -> NDJSON text.
 * @param {Uint8Array} cipher
 * @param {string} identity
 * @returns {Promise<string>}
 */
export async function decryptToText(cipher, identity) {
  const gz = await decryptBytes(cipher, identity);
  return gunzipSync(gz, { maxOutputLength: MAX_PLAINTEXT_BYTES }).toString("utf8");
}

// ---------------------------------------------------------------------------------------------
// Retention (PLT-022b: 14 daily / 8 weekly / 12 monthly)

const DAY_MS = 86_400_000;
export const KEEP_DAILY = 14;
export const KEEP_WEEKLY = 8;
export const KEEP_MONTHLY = 12;

/** @param {unknown} d a real calendar date YYYY-MM-DD */
export function isValidDate(d) {
  if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = new Date(`${d}T00:00:00.000Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}

const dayNumber = (d) => Math.floor(Date.parse(`${d}T00:00:00.000Z`) / DAY_MS);
// Days since 1970-01-01 of the Monday of the ISO week containing day number n (1970-01-01 = Thu).
const mondayOf = (n) => n - ((n + 3) % 7);
const monthIndex = (d) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) - 1;

/**
 * Which backup dates to KEEP. A date is kept when it is
 *  - one of the 14 most recent days (today and the 13 before: age 0..13), or
 *  - the newest backup of one of the last 8 ISO weeks (this week and the 7 before, Monday start), or
 *  - the newest backup of one of the last 12 calendar months (this month and the 11 before), or
 *  - dated after `today` (clock anomaly: never delete what we cannot place).
 * Invalid date strings are ignored (never returned, so callers never delete them either).
 * @param {string[]} dates YYYY-MM-DD
 * @param {string} today YYYY-MM-DD
 * @returns {string[]} kept dates, ascending, unique
 */
export function selectRetained(dates, today) {
  if (!isValidDate(today)) throw new Error("today is not a valid date");
  const all = [...new Set(dates.filter(isValidDate))].sort();
  const t = dayNumber(today);
  const tWeek = mondayOf(t);
  const tMonth = monthIndex(today);
  const keep = new Set();
  const weekly = new Map(); // weeks ago -> newest date
  const monthly = new Map(); // months ago -> newest date
  for (const d of all) {
    const n = dayNumber(d);
    if (n > t || t - n < KEEP_DAILY) keep.add(d);
    const w = (tWeek - mondayOf(n)) / 7;
    if (w >= 0 && w < KEEP_WEEKLY) weekly.set(w, d); // ascending order: last write is newest
    const m = tMonth - monthIndex(d);
    if (m >= 0 && m < KEEP_MONTHLY) monthly.set(m, d);
  }
  for (const d of weekly.values()) keep.add(d);
  for (const d of monthly.values()) keep.add(d);
  return [...keep].sort();
}

/**
 * Dates to delete = valid dates not retained.
 * @param {string[]} dates
 * @param {string} today
 */
export function selectDeletions(dates, today) {
  const keep = new Set(selectRetained(dates, today));
  return [...new Set(dates.filter(isValidDate))].filter((d) => !keep.has(d)).sort();
}

export const backupTag = (date) => `backup-${date}`;
export const assetName = (db, date) => `${db}-${date}.ndjson.gz.age`;
