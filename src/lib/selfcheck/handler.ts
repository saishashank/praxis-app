// POST handler for the signed self-check route (SEC-017, SEC-101). Dependencies are injected so
// tests need no network. Every failure body is generic; no secret, URL or upstream body leaves here.
import { isValidSecret, verifySignedRequest } from "@/lib/security/hmac";
import type { NonceStore } from "@/lib/security/replay";
import { runSelfChecks, type Env } from "./checks";
import { MAX_BODY_BYTES } from "./config";

export type Deps = {
  env: Env;
  fetchImpl: typeof fetch;
  store: NonceStore;
  nowSec: () => number;
};

const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

const unauthorized = () => json(401, { error: "unauthorized" });
const unavailable = () => json(503, { error: "unavailable" });
const badRequest = () => json(400, { error: "bad_request" });

export function createSelfCheckHandler(deps: Deps) {
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
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        (parsed as { purpose?: unknown }).purpose !== "self-check"
      ) {
        return badRequest();
      }

      const report = await runSelfChecks(deps.env, deps.fetchImpl);
      // TODO(run-records): write `report` to the run record shown on System Health here.
      return json(200, report);
    } catch {
      return unavailable();
    }
  };
}
