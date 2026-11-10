// Daily Turso usage sample (OPS-104, PLT-080; D-958, D-963). Runs in the `production` GitHub
// environment on the approved commit (SEC-108 c) from .github/workflows/turso-usage.yml.
//
//   node scripts/usage/turso-sample.mjs sample --out <file>   step 1: ask the Turso platform API
//   node scripts/usage/turso-sample.mjs store  --file <file>  step 2: write one usage_sample row
//
// Step 1 holds the platform token (TURSO_PLATFORM_TOKEN_USAGE, a GitHub production-environment secret,
// `env:` of that one step only, never on Vercel, never in a file) and has no database access. Step 2
// holds the database secrets (TURSO_MAIN_URL, TURSO_MAIN_TOKEN) and no platform token. Without the
// token step 1 writes a sample with source "unavailable" and exits 0, so the build and the Usage page
// work before the Owner has created the token (the meter then stays the labelled estimate).
//
// Endpoints (Turso Platform API reference, docs.turso.tech/api-reference, read 2026-11-11):
//   GET https://api.turso.tech/v1/organizations/{organizationSlug}/usage
//       -> { organization: { uuid, usage: { rows_read, rows_written, storage_bytes, ... }, databases: [
//            { uuid, instances: [ { uuid, usage: { rows_read, rows_written, storage_bytes, ... } } ] } ] } }
//       "current billing cycle usage" (a calendar month on the Free plan).
//   GET https://api.turso.tech/v1/organizations/{organizationSlug}
//       -> { organization: { name, slug, type, plan_id, plan_timeline, overages, blocked_reads, ... } }
// The token goes only to api.turso.tech (fixed here, never taken from a response); redirects are
// refused; a request that fails, times out or answers with anything unexpected yields an
// "unavailable" sample. The log carries the source, the plan id and the three figures: never the
// token, the organization slug, a URL or a response body.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const API = "https://api.turso.tech";
const ORG_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PLAN_RE = /^[A-Za-z0-9_. -]{1,40}$/;
const TIMEOUT_MS = 30_000;

const isCount = (v) => typeof v === "number" && Number.isInteger(v) && v >= 0;

/**
 * Organization-level figures, else the sum over every database instance (older responses).
 * @param {unknown} body the parsed usage response
 * @returns {{ rowsRead: number, rowsWritten: number, storageBytes: number } | null}
 */
export function parseUsage(body) {
  const org = body && typeof body === "object" ? body.organization : null;
  if (!org || typeof org !== "object") return null;
  const u = org.usage;
  if (u && isCount(u.rows_read) && isCount(u.rows_written) && isCount(u.storage_bytes)) {
    return { rowsRead: u.rows_read, rowsWritten: u.rows_written, storageBytes: u.storage_bytes };
  }
  if (!Array.isArray(org.databases)) return null;
  let rowsRead = 0;
  let rowsWritten = 0;
  let storageBytes = 0;
  for (const d of org.databases) {
    for (const i of Array.isArray(d?.instances) ? d.instances : []) {
      const x = i?.usage;
      if (!x || !isCount(x.rows_read) || !isCount(x.rows_written)) return null;
      rowsRead += x.rows_read;
      rowsWritten += x.rows_written;
      storageBytes += isCount(x.storage_bytes) ? x.storage_bytes : 0;
    }
  }
  return { rowsRead, rowsWritten, storageBytes };
}

/**
 * The plan id of the organization ("free", "developer", ... as the API names it), or null.
 * @param {unknown} body the parsed organization response
 */
export function parsePlan(body) {
  const id = body && typeof body === "object" ? body.organization?.plan_id : undefined;
  return typeof id === "string" && PLAN_RE.test(id) ? id : null;
}

/** @param {string} nowIso @param {string} reason */
const unavailable = (nowIso, reason, planName = null) => ({
  sampled_at: nowIso,
  rows_read_month: null,
  rows_written_month: null,
  storage_bytes: null,
  plan_name: planName,
  source: "unavailable",
  reason,
});

/**
 * Ask the platform API once for usage and once for the plan. Never throws.
 * @param {{ TURSO_PLATFORM_TOKEN_USAGE?: string, TURSO_ORG?: string }} env
 * @param {typeof fetch} fetchImpl
 * @param {string} nowIso
 */
export async function sample(env, fetchImpl, nowIso) {
  const token = (env.TURSO_PLATFORM_TOKEN_USAGE ?? "").trim();
  if (token === "") return unavailable(nowIso, "no_token");
  const org = (env.TURSO_ORG ?? "").trim();
  if (!ORG_RE.test(org)) return unavailable(nowIso, "no_organization");
  const get = async (path) => {
    try {
      const res = await fetchImpl(`${API}/v1/organizations/${encodeURIComponent(org)}${path}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status !== 200) return { status: res.status, body: null };
      return { status: 200, body: await res.json() };
    } catch {
      return { status: null, body: null };
    }
  };
  const usage = await get("/usage");
  const plan = await get("");
  const planName = parsePlan(plan.body);
  if (usage.status !== 200) {
    return unavailable(nowIso, `usage_http_${usage.status ?? "error"}`, planName);
  }
  const figures = parseUsage(usage.body);
  if (figures === null) return unavailable(nowIso, "usage_shape", planName);
  return {
    sampled_at: nowIso,
    rows_read_month: figures.rowsRead,
    rows_written_month: figures.rowsWritten,
    storage_bytes: figures.storageBytes,
    plan_name: planName,
    source: "platform",
    reason: "ok",
  };
}

/** One log line: counts, the plan id and the reason only. @param {ReturnType<typeof unavailable>} row */
export function describe(row) {
  const f = (v) => (v === null ? "n/a" : String(v));
  return (
    `turso-usage: source=${row.source} reason=${row.reason} plan=${row.plan_name ?? "unknown"} ` +
    `reads=${f(row.rows_read_month)} writes=${f(row.rows_written_month)} storage_bytes=${f(row.storage_bytes)}`
  );
}

/**
 * Insert one usage_sample row.
 * @param {{ execute: (q: { sql: string, args: unknown[] }) => Promise<unknown> }} db
 * @param {ReturnType<typeof unavailable>} row
 */
export async function store(db, row) {
  await db.execute({
    sql: `INSERT INTO usage_sample (sampled_at, rows_read_month, rows_written_month, storage_bytes,
          plan_name, source) VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      row.sampled_at,
      row.rows_read_month,
      row.rows_written_month,
      row.storage_bytes,
      row.plan_name,
      row.source,
    ],
  });
}

/** @param {string[]} argv @param {string} flag */
const arg = (argv, flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

/**
 * @param {string[]} argv @param {Record<string, string | undefined>} env
 * @param {(line: string) => void} out
 * @param {{ fetchImpl?: typeof fetch, now?: () => Date, connect?: (env: Record<string, string | undefined>) => Promise<any> }} [deps]
 */
export async function run(argv, env, out, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());
  const mode = argv[0];
  if (mode === "sample") {
    const file = arg(argv, "--out");
    if (!file) {
      out("turso-usage: usage: sample --out <file>");
      return 2;
    }
    const row = await sample(env, fetchImpl, now().toISOString());
    writeFileSync(file, JSON.stringify(row));
    out(describe(row));
    return 0; // an unavailable sample is data, not a failure
  }
  if (mode === "store") {
    const file = arg(argv, "--file");
    if (!file) {
      out("turso-usage: usage: store --file <file>");
      return 2;
    }
    let row;
    try {
      row = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      out("turso-usage: failed (sample file unreadable)");
      return 1;
    }
    if (
      !row ||
      (row.source !== "platform" && row.source !== "unavailable") ||
      typeof row.sampled_at !== "string"
    ) {
      out("turso-usage: failed (sample file has an unexpected shape)");
      return 1;
    }
    const url = env.TURSO_MAIN_URL ?? "";
    if (url.trim() === "") {
      out("turso-usage: failed (TURSO_MAIN_URL not set)");
      return 1;
    }
    try {
      const connect =
        deps.connect ??
        (async (e) => {
          const { createClient } = await import("@libsql/client");
          return createClient({ url: e.TURSO_MAIN_URL, authToken: e.TURSO_MAIN_TOKEN });
        });
      const db = await connect(env);
      await store(db, row);
      db.close?.();
    } catch {
      out("turso-usage: failed (database write)");
      return 1;
    }
    out(`turso-usage: stored ${describe(row).slice("turso-usage: ".length)}`);
    return 0;
  }
  out("turso-usage: usage: sample --out <file> | store --file <file>");
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await run(process.argv.slice(2), process.env, (s) => console.log(s)));
}
