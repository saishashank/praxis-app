// POST handler for the Worker's signed Sentinel hand-off (M5 T5; decision 36, D-067 pattern, D-029
// wire format; SEC-017 c2). The Worker fetched the ASX announcements list through the rate token,
// hashed it and sends the changed body here, signed with WORKER_HMAC_SECRET exactly like the
// universe import (same verification and replay code, src/lib/security/hmac.ts). Dependencies are
// injected so tests need no network. Every failure body is a fixed word; the feed, parsed items,
// secrets and upstream text are never echoed or logged. Fail closed: any doubt is 401/400/503.
//
// Signed body (JSON, inside the signature so it is bound to this route, environment and date):
//   { purpose: "sentinel-ingest", env: "production" | "staging", d: "YYYY-MM-DD",
//     sha: "<64 hex SHA-256 of feed>", feed: "<text>" }
import { createHash } from "node:crypto";
import { isValidSecret, verifySignedRequest } from "@/lib/security/hmac";
import type { NonceStore } from "@/lib/security/replay";
import { appEnvironment } from "@/lib/workerReport/handler";
import type { IngestResult } from "./ingest";

export const PURPOSE = "sentinel-ingest";
/** `sentinel_body_max_kb` (256 KB); the Worker never hands over more. */
export const MAX_FEED_BYTES = 256 * 1024;
// JSON escaping can at most double the feed plus a small envelope.
export const MAX_BODY_BYTES = 2 * MAX_FEED_BYTES + 1024;

export type Deps = {
  env: Record<string, string | undefined>;
  store: NonceStore;
  nowSec: () => number;
  /** Sydney date for an instant in seconds. */
  today: (nowSec: number) => string;
  /** Parses, stores and assesses. Never throws (a fault is `{ ok:false, error:"unavailable" }`). */
  ingest: (feed: string, sha: string, today: string, nowSec: number) => Promise<IngestResult>;
};

const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const unauthorized = () => json(401, { error: "unauthorized" });
const unavailable = () => json(503, { error: "unavailable" });
const badRequest = () => json(400, { error: "bad_request" });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SHA_RE = /^[0-9a-f]{64}$/;

export function createSentinelIngestHandler(deps: Deps) {
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

      const nowSec = deps.nowSec();
      const verdict = await verifySignedRequest({
        secret,
        headers: req.headers,
        rawBody,
        nowSec,
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
      const today = deps.today(nowSec);
      if (typeof body.d !== "string" || !DATE_RE.test(body.d) || body.d !== today) {
        return badRequest();
      }
      if (typeof body.feed !== "string" || Buffer.byteLength(body.feed, "utf8") > MAX_FEED_BYTES) {
        return badRequest();
      }
      // The hash binds the body to what the Worker recorded as seen; a mismatch is refused.
      if (typeof body.sha !== "string" || !SHA_RE.test(body.sha)) return badRequest();
      if (createHash("sha256").update(body.feed, "utf8").digest("hex") !== body.sha) {
        return badRequest();
      }

      const r = await deps.ingest(body.feed, body.sha, today, nowSec);
      if (r.ok) return json(200, { new: r.new, assessed: r.assessed, carried: r.carried });
      if (r.error === "unrecognised_format") return json(422, { error: r.error });
      return unavailable();
    } catch {
      return unavailable();
    }
  };
}
