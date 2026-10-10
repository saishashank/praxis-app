// Minimal Turso HTTP pipeline client for the master clock (same wire format as selfcheck.ts).
// One call = ONE subrequest, however many statements it carries (PLT-070: 50 per invocation).
// Errors carry only a fixed name, never a message, URL or value.

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
  response?: { result?: { rows?: WireValue[][]; affected_row_count?: number } };
};

function decodeValue(v: WireValue): string | number | null {
  if (v?.type === "null" || v?.value === undefined) return null;
  return v.type === "integer" ? Number(v.value) : v.value;
}

/** Runs the statements in order in one request. Throws DbError on any failure. */
export async function pipeline(env: DbEnv, stmts: Stmt[], f: typeof fetch): Promise<StmtResult[]> {
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
  return stmts.map((_, i) => {
    const r = results[i];
    if (r?.type !== "ok") throw new DbError("statement-error");
    const out = r.response?.result;
    return {
      rows: (out?.rows ?? []).map((row) => row.map(decodeValue)),
      affected: out?.affected_row_count ?? 0,
    };
  });
}
