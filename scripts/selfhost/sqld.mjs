// INFRA T4 (REQ\infra\INFRA_REQUIREMENT.md §8.1): helpers to talk to the self-hosted sqld
// (libsql-server) from the restore, migrate, drill and backup scripts. Zero new dependencies:
// everything goes through @libsql/client and fetch.
//
// Namespaces: sqld runs with --enable-namespaces and holds the "main" and "auth" databases as
// namespaces of one server. The namespace of a request is the first label of the Host header, so
//   subdomain mode   the client URL is `http://<ns>.<host>:<port>` (compose network aliases
//                    `main.sqld` and `auth.sqld`); no custom fetch needed.
//   host mode        the client URL is the plain base (`http://sqld:8080`) and a fetch wrapper sets
//                    `Host: <ns>.<host>` (needed for scratch namespaces that have no DNS alias).
// Namespaces are created and dropped with the admin API (`POST /v1/namespaces/<ns>/create`,
// `DELETE /v1/namespaces/<ns>`). Not verified against a real sqld here; branch CI covers it.
//
// Output rules: errors carry a fixed message; never a URL, token or row content.
import { foreignKeyOrder, parseBackup, restoreDatabase } from "../backup/core.mjs";
import { createClient } from "@libsql/client";

export const NS_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ADMIN_TIMEOUT_MS = 30_000;

export class SqldError extends Error {}
const refuse = (why) => {
  throw new SqldError(why);
};
const has = (v) => typeof v === "string" && v.trim() !== "";

/**
 * Where a namespace lives.
 * @param {string} base `http://sqld:8080` (no path)
 * @param {string} ns namespace name (`main`, `auth`, `drill-...`)
 * @param {"subdomain" | "host"} [mode]
 * @returns {{ url: string, host: string | null }} host = the Host header to force (host mode)
 */
export function namespaceTarget(base, ns, mode = "subdomain") {
  if (!NS_RE.test(String(ns))) refuse("sqld: bad namespace name");
  let u;
  try {
    u = new URL(String(base).trim());
  } catch {
    return refuse("sqld: bad base URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") refuse("sqld: base must be http(s)");
  if (mode === "host") {
    return { url: `${u.protocol}//${u.host}`, host: `${ns}.${u.hostname}` };
  }
  return { url: `${u.protocol}//${ns}.${u.host}`, host: null };
}

/**
 * A plain http(s) request through node:http that sends the Host header it is given. Node's global fetch (undici)
 * ignores a `host` header set on a Request, so every host-mode call went to sqld's default namespace (found by
 * branch CI against a real sqld, INFRA T4). Returns a standard Response.
 * @param {Request} req @param {string | null} [host]
 */
export async function nodeHttpFetch(req, host = null) {
  const { request: httpRequest } = await import("node:http");
  const { request: httpsRequest } = await import("node:https");
  const u = new URL(req.url);
  const body = req.body ? Buffer.from(await req.arrayBuffer()) : null;
  const headers = Object.fromEntries(req.headers);
  if (host) headers.host = host;
  if (body) headers["content-length"] = String(body.length);
  const send = u.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const r = send(
      {
        hostname: u.hostname,
        port: u.port || undefined,
        path: `${u.pathname}${u.search}`,
        method: req.method,
        headers,
        signal: req.signal,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("error", reject);
        res.on("end", () => {
          const h = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(", ") : v);
          }
          const status = res.statusCode ?? 502;
          const empty = [101, 204, 205, 304].includes(status);
          resolve(new Response(empty ? null : Buffer.concat(chunks), { status, headers: h }));
        });
      },
    );
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

/**
 * A fetch that sends `Host: <host>` (host mode). `inner(req, host)` does the request; the default is nodeHttpFetch.
 * @param {string} host @param {(req: Request, host: string) => Promise<Response>} [inner]
 */
export function hostFetch(host, inner = nodeHttpFetch) {
  return (input, init) => inner(new Request(input, init), host);
}

/**
 * Open a client on one namespace of a sqld server.
 * @param {{ base: string, ns: string, token?: string, mode?: "subdomain" | "host",
 *   intMode?: "number" | "bigint" | "string", fetchImpl?: (req: Request, host: string) => Promise<Response> }} o
 */
export function openNamespace(o) {
  const t = namespaceTarget(o.base, o.ns, o.mode ?? "subdomain");
  return createClient({
    url: t.url,
    authToken: has(o.token) ? o.token.trim() : undefined,
    ...(o.intMode ? { intMode: o.intMode } : {}),
    ...(t.host ? { fetch: hostFetch(t.host, o.fetchImpl) } : {}),
  });
}

async function admin(adminBase, method, ns, adminAuth, fetchImpl) {
  if (!NS_RE.test(String(ns))) refuse("sqld: bad namespace name");
  let url;
  try {
    const u = new URL(String(adminBase).trim());
    url = `${u.protocol}//${u.host}/v1/namespaces/${ns}${method === "POST" ? "/create" : ""}`;
  } catch {
    return refuse("sqld: bad admin URL");
  }
  let res;
  try {
    res = await fetchImpl(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(has(adminAuth) ? { Authorization: adminAuth.trim() } : {}),
      },
      ...(method === "POST" ? { body: "{}" } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(ADMIN_TIMEOUT_MS),
    });
  } catch {
    return refuse("sqld: admin API unreachable");
  }
  // The body is read only to tell "already exists" from other 400s; it is never returned or printed.
  let exists = false;
  if (res.status === 400 && typeof res.text === "function") {
    try {
      exists = /already exists/i.test((await res.text()).slice(0, 500));
    } catch {
      exists = false;
    }
  }
  return { status: res.status, exists };
}

/** Create the namespace; an existing one is fine (idempotent). */
export async function ensureNamespace(adminBase, ns, { adminAuth, fetchImpl = fetch } = {}) {
  const { status: s, exists } = await admin(adminBase, "POST", ns, adminAuth, fetchImpl);
  if (s >= 200 && s < 300) return "created";
  // Real sqld (v0.24.32) answers 400 "Namespace ... already exists", not 409 (found by branch CI, INFRA T4).
  if (s === 409 || exists) return "exists";
  return refuse(`sqld: create namespace failed (HTTP ${s})`);
}

/** Drop the namespace and its data; a missing one is fine. */
export async function dropNamespace(adminBase, ns, { adminAuth, fetchImpl = fetch } = {}) {
  const { status: s } = await admin(adminBase, "DELETE", ns, adminAuth, fetchImpl);
  if (s >= 200 && s < 300) return "dropped";
  if (s === 404) return "absent";
  return refuse(`sqld: drop namespace failed (HTTP ${s})`);
}

// ---------------------------------------------------------------------------------------------
// Foreign keys (D-713: ON for every connection, like Turso)

/** @param {Pick<import("@libsql/client").Client, "execute">} db */
export async function foreignKeysEnabled(db) {
  const r = await db.execute("PRAGMA foreign_keys");
  return Number(r.rows[0]?.foreign_keys) === 1;
}

/** Throws when `PRAGMA foreign_keys` is not 1. @param {*} db @param {string} label */
export async function assertForeignKeys(db, label) {
  if (!(await foreignKeysEnabled(db))) refuse(`${label}: PRAGMA foreign_keys is not 1`);
}

/** Number of rows `PRAGMA foreign_key_check` reports (0 = no orphan child rows). */
export async function foreignKeyViolations(db) {
  const r = await db.execute("PRAGMA foreign_key_check");
  return r.rows.length;
}

/**
 * Connection check used after a restore, a migration and in CI: reachable, foreign keys ON, and
 * (optionally) no orphan rows. Returns facts only.
 * @returns {Promise<{ foreignKeys: boolean, violations: number | null }>}
 */
export async function connectionCheck(db, { orphans = true } = {}) {
  const foreignKeys = await foreignKeysEnabled(db);
  const violations = orphans ? await foreignKeyViolations(db) : null;
  return { foreignKeys, violations };
}

// ---------------------------------------------------------------------------------------------
// Restore into a namespace / database

/**
 * Restore a decrypted stream into an EMPTY database, then verify: per-table counts and sha256
 * (restoreDatabase does this and throws on a mismatch), `PRAGMA foreign_keys` = 1, and no orphan
 * rows. Returns facts only.
 * @param {import("@libsql/client").Client} db
 * @param {string} text NDJSON dump
 * @param {{ expectDb?: "main" | "auth" }} [opts]
 */
export async function restoreVerified(db, text, opts = {}) {
  const parsed = parseBackup(text); // throws on a bad stream before anything is written
  if (opts.expectDb && parsed.meta.db !== opts.expectDb) {
    refuse(`the dump is the ${parsed.meta.db} database, not ${opts.expectDb}`);
  }
  await assertForeignKeys(db, "target");
  const result = await restoreDatabase(db, text);
  const rows = parsed.meta.tables.reduce((n, t) => n + parsed.end.counts[t], 0);
  for (const t of parsed.meta.tables) {
    if (result.counts[t] !== parsed.end.counts[t] || result.sha256[t] !== parsed.end.sha256[t]) {
      refuse("restored data does not match the dump");
    }
  }
  const check = await connectionCheck(db);
  if (!check.foreignKeys) refuse("target: PRAGMA foreign_keys is not 1 after the restore");
  if (check.violations !== 0) refuse("target: foreign key check found orphan rows");
  return {
    db: parsed.meta.db,
    schemaVersion: parsed.meta.schema_version,
    tables: parsed.meta.tables.length,
    rows,
    counts: result.counts,
  };
}

/**
 * Remove every user table, view and trigger so the database can take a fresh restore. Children
 * are dropped before parents. HIGH-RISK: only called by the Turso refresh, after the owner guard
 * and after the new dump parsed and verified.
 * @param {import("@libsql/client").Client} db
 * @returns {Promise<number>} number of tables dropped
 */
export async function wipeDatabase(db) {
  const r = await db.execute(
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_litestream%' AND name NOT LIKE 'libsql_%'",
  );
  const rows = r.rows.map((x) => ({ type: String(x.type), name: String(x.name), sql: x.sql }));
  const tables = rows.filter((x) => x.type === "table");
  const sqlOf = new Map(tables.map((t) => [t.name, String(t.sql ?? "")]));
  const order = foreignKeyOrder(
    tables.map((t) => t.name),
    sqlOf,
  ).reverse();
  const q = (n) => `"${n.replace(/"/g, '""')}"`;
  const stmts = [
    "PRAGMA defer_foreign_keys = ON",
    ...rows.filter((x) => x.type === "view").map((x) => `DROP VIEW IF EXISTS ${q(x.name)}`),
    ...rows.filter((x) => x.type === "trigger").map((x) => `DROP TRIGGER IF EXISTS ${q(x.name)}`),
    ...order.map((n) => `DROP TABLE IF EXISTS ${q(n)}`),
  ];
  if (stmts.length > 1) await db.batch(stmts, "write");
  return order.length;
}
