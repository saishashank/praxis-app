// POST handler for the Worker's signed universe import (M2 T11, D-067; SEC-017 c2). The Worker
// fetched the ASX listed-companies CSV and sends the raw text here, signed with WORKER_HMAC_SECRET
// exactly like the self-check report (same verification and replay code, src/lib/security/hmac.ts).
// Dependencies are injected so tests need no network. Every failure body is a fixed word; the CSV,
// parsed rows, secrets and upstream text are never echoed or logged. Opus reviews every line.
//
// Signed body (JSON, inside the signature so it is bound to this route, environment and date):
//   { purpose: "universe-import", env: "production" | "staging", d: "YYYY-MM-DD", csv: "<text>" }
import { isValidSecret, verifySignedRequest } from "@/lib/security/hmac";
import type { NonceStore } from "@/lib/security/replay";
import { appEnvironment } from "@/lib/workerReport/handler";
import type { ImportResult } from "./import";

export const MAX_CSV_BYTES = 1_048_576; // 1 MB of CSV text
// JSON escaping can at most double the CSV plus a small envelope.
export const MAX_BODY_BYTES = 2 * MAX_CSV_BYTES + 1024;
export const PURPOSE = "universe-import";

export type Deps = {
  env: Record<string, string | undefined>;
  store: NonceStore;
  nowSec: () => number;
  /** Sydney date for an instant in seconds. */
  today: (nowSec: number) => string;
  /** Parses and applies the CSV. Never throws (a fault is `{ ok:false, error:"unavailable" }`). */
  importCsv: (csv: string, today: string) => Promise<ImportResult>;
};

const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const unauthorized = () => json(401, { error: "unauthorized" });
const unavailable = () => json(503, { error: "unavailable" });
const badRequest = () => json(400, { error: "bad_request" });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function createUniverseImportHandler(deps: Deps) {
  return async function handle(req: Request): Promise<Response> {
    try {
      const secret = deps.env.WORKER_HMAC_SECRET;
      // Misconfigured secret: answer before reading the body or evaluating any signature.
      if (!isValidSecret(secret)) return unavailable();

      // Refuse a declared oversize body before reading it (the check after reading covers the rest).
      const declared = req.headers.get("content-length");
      if (declared !== null && /^\d{1,12}$/.test(declared) && Number(declared) > MAX_BODY_BYTES) {
        return badRequest();
      }
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
      if (body.purpose !== PURPOSE) return badRequest();
      if (body.env !== appEnvironment(deps.env)) return badRequest();
      const today = deps.today(deps.nowSec());
      if (typeof body.d !== "string" || !DATE_RE.test(body.d) || body.d !== today) {
        return badRequest();
      }
      if (typeof body.csv !== "string" || Buffer.byteLength(body.csv, "utf8") > MAX_CSV_BYTES) {
        return badRequest();
      }

      const r = await deps.importCsv(body.csv, today);
      if (r.ok) {
        return json(
          200,
          r.status === "applied" ? { result: "applied", counts: r.counts } : { result: r.status },
        );
      }
      if (r.error === "unrecognised_format") return json(422, { error: r.error });
      if (r.error === "suspicious_shrink") return json(409, { error: r.error });
      return unavailable();
    } catch {
      return unavailable();
    }
  };
}
