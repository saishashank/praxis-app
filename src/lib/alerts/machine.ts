// Signed Worker -> app routes of the alert path (M5 T6; D-067 pattern, D-029 wire format, SEC-017 c2):
//   POST /api/internal/alert-flush   body { purpose: "alert-flush", env, d }
//   POST /api/internal/incident      body { purpose: "incident", env, d, kind, window_min? }
// Same verification as the Sentinel ingest (src/lib/security/hmac.ts: secret, headers, +-300 s,
// constant-time signature, single-use nonce). Every failure body is a fixed word; nothing the
// request says is echoed or logged. Fail closed: any doubt is 401/400/503.
import type { Client } from "@libsql/client";
import { isValidSecret, verifySignedRequest } from "@/lib/security/hmac";
import type { NonceStore } from "@/lib/security/replay";
import { appEnvironment } from "@/lib/workerReport/handler";
import { flushAlerts } from "./flush";
import { openIncident, INCIDENT_KINDS, type IncidentKind } from "./incident";
import type { AlertCtx } from "./deliver";

export const FLUSH_PURPOSE = "alert-flush";
export const INCIDENT_PURPOSE = "incident";
export const MAX_BODY_BYTES = 2048;

export type MachineDeps = {
  env: Record<string, string | undefined>;
  store: NonceStore;
  nowSec: () => number;
  /** Melbourne/Sydney date for an instant in seconds. */
  today: (nowSec: number) => string;
  /** The database and sender context (injected so tests need no network). */
  ctx: () => AlertCtx;
};

const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type Run = (body: Record<string, unknown>, nowSec: number) => Promise<Response>;

export function signed(purpose: string, deps: MachineDeps, run: Run) {
  return async function handle(req: Request): Promise<Response> {
    try {
      const secret = deps.env.WORKER_HMAC_SECRET;
      if (!isValidSecret(secret)) return json(503, { error: "unavailable" });
      const declared = req.headers.get("content-length");
      if (declared !== null && /^\d{1,12}$/.test(declared) && Number(declared) > MAX_BODY_BYTES) {
        return json(400, { error: "bad_request" });
      }
      const rawBody = await req.text();
      if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
        return json(400, { error: "bad_request" });
      }
      const nowSec = deps.nowSec();
      const verdict = await verifySignedRequest({
        secret,
        headers: req.headers,
        rawBody,
        nowSec,
        store: deps.store,
      });
      if (!verdict.ok) {
        return verdict.status === 401
          ? json(401, { error: "unauthorized" })
          : json(503, { error: "unavailable" });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return json(400, { error: "bad_request" });
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return json(400, { error: "bad_request" });
      }
      const body = parsed as Record<string, unknown>;
      if (body.purpose !== purpose) return json(400, { error: "bad_request" });
      if (body.env !== appEnvironment(deps.env)) return json(400, { error: "bad_request" });
      if (typeof body.d !== "string" || !DATE_RE.test(body.d) || body.d !== deps.today(nowSec)) {
        return json(400, { error: "bad_request" });
      }
      return await run(body, nowSec);
    } catch {
      return json(503, { error: "unavailable" });
    }
  };
}

export function createAlertFlushHandler(deps: MachineDeps) {
  return signed(FLUSH_PURPOSE, deps, async () => {
    const r = await flushAlerts(deps.ctx());
    return json(200, {
      status: r.status,
      raised: r.raised,
      regime: r.regime !== null,
      retried: r.retried,
      batched: r.batched,
      email: r.email,
      due: r.due,
    });
  });
}

export function createIncidentHandler(deps: MachineDeps) {
  return signed(INCIDENT_PURPOSE, deps, async (body, nowSec) => {
    const kind = body.kind;
    if (typeof kind !== "string" || !Object.hasOwn(INCIDENT_KINDS, kind)) {
      return json(400, { error: "bad_request" });
    }
    const w = body.window_min;
    if (w !== undefined && !(typeof w === "number" && Number.isInteger(w) && w >= 1 && w <= 1440)) {
      return json(400, { error: "bad_request" });
    }
    const r = await openIncident(deps.ctx(), kind as IncidentKind, {
      windowMin: typeof w === "number" ? w : undefined,
      nowMs: nowSec * 1000,
    });
    return json(200, { opened: r.opened, severity: r.severity, email: r.email });
  });
}

export type { Client };
