// POST handler for the signed maintenance route (SEC-017, PLT-016, PLT-076). Same pattern as
// src/lib/selfcheck/handler.ts: dependencies are injected, every failure body is generic.
import type { Client } from "@libsql/client";
import { isValidSecret, verifySignedRequest } from "@/lib/security/hmac";
import type { NonceStore } from "@/lib/security/replay";
import { isValidDate, runMaintenance } from "./retention";

export const MAX_BODY_BYTES = 4096;

export type Deps = {
  env: Record<string, string | undefined>;
  store: NonceStore;
  nowSec: () => number;
  // Factories, so a misconfigured database surfaces as 503 inside the handler's try/catch.
  mainDb: () => Client;
  authDb: () => Client;
};

const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

const unauthorized = () => json(401, { error: "unauthorized" });
const unavailable = () => json(503, { error: "unavailable" });
const badRequest = () => json(400, { error: "bad_request" });

export function createMaintenanceHandler(deps: Deps) {
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
      if (typeof parsed !== "object" || parsed === null) return badRequest();
      const { purpose, date } = parsed as { purpose?: unknown; date?: unknown };
      if (purpose !== "maintenance" || !isValidDate(date)) return badRequest();

      const outcome = await runMaintenance(
        {
          mainDb: deps.mainDb(),
          authDb: deps.authDb(),
          piiHashKey: deps.env.PII_HASH_KEY,
          now: new Date(deps.nowSec() * 1000),
        },
        date,
      );
      if (outcome.status === "skipped") return json(200, { skipped: true });
      if (outcome.status === "failed") return json(500, { error: "failed" });
      return json(200, { ok: true, skipped: false, date, ...outcome.counts });
    } catch {
      return unavailable();
    }
  };
}
