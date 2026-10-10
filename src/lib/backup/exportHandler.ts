// POST handler for the signed auth-DB backup export (DAT-143, ROL-101a, PLT-022b, SEC-017).
// Only Vercel holds the auth-DB token, so the nightly backup job asks this route for an
// already-encrypted export. Same shape as src/lib/maintenance/handler.ts: dependencies injected,
// every failure body generic. The route NEVER returns plaintext: the body is age ciphertext for
// the configured BACKUP_PUBLIC_KEY, and the key cannot be supplied by the caller (the body is
// exactly {"purpose":"backup-export","date":"YYYY-MM-DD"}; any other field is a 400).
import type { Client } from "@libsql/client";
import { isValidSecret, verifySignedRequest } from "@/lib/security/hmac";
import type { NonceStore } from "@/lib/security/replay";
import { exportEncrypted, parseRecipient } from "./crypto";
import { isValidDate } from "./retention";

export const MAX_BODY_BYTES = 4096;
export const COUNTS_HEADER = "X-Praxis-Backup-Counts";

export type Deps = {
  env: Record<string, string | undefined>;
  store: NonceStore;
  nowSec: () => number;
  // Factory, so a misconfigured database surfaces as 503 inside the handler's try/catch.
  authDb: () => Client;
};

const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

const unauthorized = () => json(401, { error: "unauthorized" });
const unavailable = () => json(503, { error: "unavailable" });
const badRequest = () => json(400, { error: "bad_request" });

export function createBackupExportHandler(deps: Deps) {
  return async function handle(req: Request): Promise<Response> {
    try {
      // Misconfigured secret: answer before reading the body or evaluating any signature.
      if (!isValidSecret(deps.env.ACTIONS_HMAC_SECRET)) return unavailable();

      const rawBody = await req.text();
      if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) return badRequest();

      const verdict = await verifySignedRequest({
        secret: deps.env.ACTIONS_HMAC_SECRET,
        headers: req.headers,
        rawBody,
        nowSec: deps.nowSec(),
        store: deps.store,
      });
      if (!verdict.ok) return verdict.status === 401 ? unauthorized() : unavailable();

      // The purpose field is inside the signed body, so a signature is bound to this route.
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return badRequest();
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return badRequest();
      }
      const keys = Object.keys(parsed).sort();
      const { purpose, date } = parsed as { purpose?: unknown; date?: unknown };
      // Exactly these two fields: a caller-supplied key (or anything else) is refused.
      if (keys.length !== 2 || keys[0] !== "date" || keys[1] !== "purpose") return badRequest();
      if (purpose !== "backup-export" || !isValidDate(date)) return badRequest();

      // Fail closed: without a valid public key nothing is exported (never plaintext).
      const recipient = parseRecipient(deps.env.BACKUP_PUBLIC_KEY);
      if (recipient === null) return unavailable();

      const out = await exportEncrypted(deps.authDb(), {
        name: "auth",
        createdAt: new Date(deps.nowSec() * 1000).toISOString(),
        recipient,
      });
      return new Response(out.data as BodyInit, {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Cache-Control": "no-store",
          // Row counts per table only: no values, no hashes of values.
          [COUNTS_HEADER]: JSON.stringify(out.counts),
        },
      });
    } catch {
      return unavailable();
    }
  };
}
