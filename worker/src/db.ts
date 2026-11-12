// Minimal Turso HTTP pipeline client for the master clock (same wire format as selfcheck.ts).
// One call = ONE subrequest, however many statements it carries (PLT-070: 50 per invocation).
// Errors carry only a fixed name, never a message, URL or value.

import { marketOfStatement } from "../../src/lib/market/guard.mjs";
import { refusalIncidentStatement, refusalKey } from "../../src/lib/market/refusalIncident.mjs";

export type Arg = string | number | null;
export type Stmt = { sql: string; args?: Arg[] };
export type Row = (string | number | null)[];
export type StmtResult = { rows: Row[]; affected: number };

export type DbEnv = { TURSO_MAIN_URL?: string; TURSO_MAIN_TOKEN?: string };
export const DB_TIMEOUT_MS = 10_000;

const TURSO_URL_RE = /^(?:libsql|https):\/\/([^/\s]+)\/?$/;

export class DbError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "DbError";
  }
}

/** The write guard refused a row of a market that is not enabled (D-995). Its name is the log word. */
export class MarketNotEnabledError extends DbError {
  constructor() {
    super("market-not-enabled");
    this.name = "MarketNotEnabled";
  }
}

export function dbConfigured(env: DbEnv): boolean {
  return pipelineUrl(env) !== null && (env.TURSO_MAIN_TOKEN ?? "").trim() !== "";
}

function pipelineUrl(env: DbEnv): string | null {
  const m = TURSO_URL_RE.exec((env.TURSO_MAIN_URL ?? "").trim());
  return m ? `https://${m[1]}/v2/pipeline` : null;
}

function encodeArg(a: Arg): { type: string; value?: string } {
  if (a === null) return { type: "null" };
  if (typeof a === "number") return { type: "integer", value: String(Math.trunc(a)) };
  return { type: "text", value: a };
}

type WireValue = { type?: string; value?: string };
type WireResult = {
  type?: string;
  error?: { message?: string };
  response?: { result?: { rows?: WireValue[][]; affected_row_count?: number } };
};

function decodeValue(v: WireValue): string | number | null {
  if (v?.type === "null" || v?.value === undefined) return null;
  return v.type === "integer" ? Number(v.value) : v.value;
}

/**
 * M20 A2 (D-1123): the refusal reporter of the Worker, the same incident as the app's and the scripts' (S2
 * market_not_enabled, src/lib/market/refusalIncident.mjs): at most once per market per isolate-day here, one open
 * incident per kind in the table, best effort. It names the market the way the app does (the statement's own codes
 * checked against the market table). It never throws and its own requests are not reported again.
 */
const reported = new Set<string>();
export function resetRefusalReports(): void {
  reported.clear();
}
async function reportRefusal(
  env: DbEnv,
  stmts: Stmt[],
  table: string | null,
  f: typeof fetch,
): Promise<void> {
  try {
    const known = new Set<string>();
    const enabled = new Set<string>();
    try {
      const [r] = await run(env, [{ sql: "SELECT code, enabled FROM market" }], f, false);
      for (const row of r?.rows ?? []) {
        known.add(String(row[0]));
        if (Number(row[1]) === 1) enabled.add(String(row[0]));
      }
    } catch {
      /* the lookup is best effort */
    }
    const market = marketOfStatement(
      stmts.map((s) => ({ sql: s.sql, args: s.args })),
      (c: string) => enabled.has(c),
      (c: string) => known.has(c),
    );
    const at = new Date();
    const key = refusalKey(at, market);
    if (reported.has(key)) return;
    reported.add(key);
    await run(env, [refusalIncidentStatement(at, market, table) as Stmt], f, false);
  } catch {
    /* best effort: the refusal itself is the outcome */
  }
}

/** Runs the statements in order in one request. Throws DbError on any failure. */
export async function pipeline(env: DbEnv, stmts: Stmt[], f: typeof fetch): Promise<StmtResult[]> {
  return run(env, stmts, f, true);
}

async function run(
  env: DbEnv,
  stmts: Stmt[],
  f: typeof fetch,
  report: boolean,
): Promise<StmtResult[]> {
  const url = pipelineUrl(env);
  const token = (env.TURSO_MAIN_TOKEN ?? "").trim();
  if (url === null || token === "") throw new DbError("not-configured");
  const requests = [
    ...stmts.map((s) => ({
      type: "execute",
      stmt: { sql: s.sql, args: (s.args ?? []).map(encodeArg) },
    })),
    { type: "close" },
  ];
  const res = await f(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests }),
    redirect: "manual",
    signal: AbortSignal.timeout(DB_TIMEOUT_MS),
  });
  if (res.status !== 200) throw new DbError(`http-${res.status}`);
  const json = (await res.json()) as { results?: WireResult[] };
  const results = json?.results;
  if (!Array.isArray(results) || results.length !== requests.length) {
    throw new DbError("unexpected-response");
  }
  const done: StmtResult[] = [];
  for (let i = 0; i < stmts.length; i += 1) {
    const r = results[i];
    if (r?.type !== "ok") {
      // D-995: the write guard of an off market (trigger text `MarketNotEnabled <table>`) becomes a fixed word,
      // never the message; D-1123: and one S2 incident, reported before the throw (best effort)
      const message = r?.error?.message;
      if (typeof message === "string" && message.includes("MarketNotEnabled")) {
        if (report) {
          const table = /MarketNotEnabled ([A-Za-z_][A-Za-z0-9_]*)/.exec(message)?.[1] ?? null;
          await reportRefusal(env, stmts, table, f);
        }
        throw new MarketNotEnabledError();
      }
      throw new DbError("statement-error");
    }
    const out = r.response?.result;
    done.push({
      rows: (out?.rows ?? []).map((row) => row.map(decodeValue)),
      affected: out?.affected_row_count ?? 0,
    });
  }
  return done;
}
