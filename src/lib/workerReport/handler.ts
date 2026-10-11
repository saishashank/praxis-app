// POST handler for the Worker's signed self-check report (SEC-101, SEC-017 c2). The Worker proves
// WORKER_HMAC_SECRET by signing the report; this route verifies it, checks the report is for this
// environment, and records it. Dependencies are injected so tests need no network. Every failure
// body is generic; no secret, request body or upstream text ever leaves here. Opus reviews every line.
import { isValidSecret, verifySignedRequest } from "@/lib/security/hmac";
import type { NonceStore } from "@/lib/security/replay";
import type { WorkerReport, WorkerResult } from "./record";

export type { WorkerReport, WorkerResult };

export const MAX_BODY_BYTES = 4096;
export const MAX_RESULTS = 20;
export const MAX_NAME = 60;
export const MAX_DETAIL = 120;
export const HMAC_RESULT_NAME = "WORKER_HMAC_SECRET";

export type Deps = {
  env: Record<string, string | undefined>;
  store: NonceStore;
  nowSec: () => number;
  /** Writes the run record. Its failure is a 503: "recorded:true" must be true. */
  recordRun: (report: WorkerReport) => Promise<void>;
};

const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const unauthorized = () => json(401, { error: "unauthorized" });
const unavailable = () => json(503, { error: "unavailable" });
const badRequest = () => json(400, { error: "bad_request" });

const has = (v: string | undefined): v is string => typeof v === "string" && v.trim() !== "";

// Production iff it holds BACKUP_PUBLIC_KEY and not the staging-only TEST_IDENTITY_SECRET.
// Anything else is treated as staging; a Worker reporting "production" to it is then refused.
export function appEnvironment(env: Deps["env"]): "production" | "staging" {
  return has(env.BACKUP_PUBLIC_KEY) && !has(env.TEST_IDENTITY_SECRET) ? "production" : "staging";
}

const COMMIT_RE = /^(?:[0-9a-f]{40}|unknown)$/;
const PRINTABLE_RE = /^[\x20-\x7e]*$/;

function parseResults(v: unknown): WorkerResult[] | null {
  if (!Array.isArray(v) || v.length > MAX_RESULTS) return null;
  const out: WorkerResult[] = [];
  for (const item of v) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const { name, ok, detail } = item as Record<string, unknown>;
    if (typeof name !== "string" || name.length < 1 || name.length > MAX_NAME) return null;
    if (typeof detail !== "string" || detail.length > MAX_DETAIL) return null;
    if (typeof ok !== "boolean") return null;
    if (!PRINTABLE_RE.test(name) || !PRINTABLE_RE.test(detail)) return null;
    if (name === HMAC_RESULT_NAME) return null; // that result is added by this route only
    out.push({ name, ok, detail }); // only these three fields are ever copied
  }
  return out;
}

export function createWorkerReportHandler(deps: Deps) {
  return async function handle(req: Request): Promise<Response> {
    try {
      const secret = deps.env.WORKER_HMAC_SECRET;
      // Misconfigured secret: answer before reading the body or evaluating any signature.
      if (!isValidSecret(secret)) return unavailable();

      const rawBody = await req.text();
      if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) return badRequest();

      const verdict = await verifySignedRequest({
        secret,
        headers: req.headers,
        rawBody,
        nowSec: deps.nowSec(),
        store: deps.store,
      });
      if (!verdict.ok) return verdict.status === 401 ? unauthorized() : unavailable();

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return badRequest();
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return badRequest();
      }
      const body = parsed as Record<string, unknown>;
      // purpose and env are inside the signed body: a signature is bound to this route and to the
      // environment, so a staging Worker's report cannot be replayed into production.
      if (body.purpose !== "worker-report") return badRequest();
      if (body.env !== appEnvironment(deps.env)) return badRequest();
      if (typeof body.commit !== "string" || !COMMIT_RE.test(body.commit)) return badRequest();
      const results = parseResults(body.results);
      if (results === null) return badRequest();

      results.push({ name: HMAC_RESULT_NAME, ok: true, detail: "signed report accepted" });
      try {
        await deps.recordRun({ commit: body.commit, results });
      } catch {
        return unavailable(); // nothing logged: the message could carry a value
      }
      return json(200, { recorded: true });
    } catch {
      return unavailable();
    }
  };
}
