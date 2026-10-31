// Signed handler of `POST /api/internal/evening-review` (M5 T10; D-029 wire format, SEC-017 c2,
// D-067 pattern, D-096 decisions 11, 12, 41; D-106). Two callers, two secrets:
//   - the Worker slot `evening-review` (WORKER_HMAC_SECRET): { purpose, env, d, slot };
//   - the YAML watchdog (ACTIONS_HMAC_SECRET): { purpose, date, source: "watchdog", slot }.
// The secret that verified the signature decides the caller; the body's `source` is never trusted.
// Verification: secret configured -> headers -> +-300 s -> constant-time signature -> single-use
// nonce (src/lib/security/hmac.ts); every failure body is a fixed word and nothing is echoed. The
// review date must be today or yesterday (Melbourne): a send that finishes after midnight keeps its
// date. The answer is 200 with `ok` true for every state the caller need not retry and `ok` false
// (still 200) when the provider failed, so the watchdog falls back to the direct minimal review.
import type { Client } from "@libsql/client";
import { melbourneDate } from "@/lib/email/keys";
import { LiveSendBlockedError } from "@/lib/email/provider";
import type { EmailEnvVars, EmailProvider } from "@/lib/email/provider";
import { isValidSecret, verifySignedRequest } from "@/lib/security/hmac";
import type { NonceStore } from "@/lib/security/replay";
import { appEnvironment } from "@/lib/workerReport/handler";
import { recordOutcomes } from "@/lib/intraday/outcome";
import { measureCandidates } from "@/lib/intraday/measure";
import { evaluateIntradayStream } from "@/lib/intraday/evaluator";
import { MARKET, runReviewSend, type ReviewSendResult } from "./send";

export const EVENING_REVIEW_PURPOSE = "evening-review";
export const MAX_BODY_BYTES = 2048;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLOT_RE = /^[A-Za-z0-9_-]{1,30}$/;
const DAY_MS = 86_400_000;

export type ReviewRouteDeps = {
  env: EmailEnvVars;
  store: NonceStore;
  nowSec: () => number;
  db: () => Client;
  provider?: EmailProvider;
  sleep?: (ms: number) => Promise<void>;
};

const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

type Caller = "worker" | "watchdog";

export function createEveningReviewHandler(deps: ReviewRouteDeps) {
  return async function handle(req: Request): Promise<Response> {
    try {
      const candidates: { who: Caller; secret: string }[] = [];
      const w = deps.env.WORKER_HMAC_SECRET;
      const a = deps.env.ACTIONS_HMAC_SECRET;
      if (isValidSecret(w)) candidates.push({ who: "worker", secret: w });
      if (isValidSecret(a)) candidates.push({ who: "watchdog", secret: a });
      if (candidates.length === 0) return json(503, { error: "unavailable" });

      const declared = req.headers.get("content-length");
      if (declared !== null && /^\d{1,12}$/.test(declared) && Number(declared) > MAX_BODY_BYTES) {
        return json(400, { error: "bad_request" });
      }
      const rawBody = await req.text();
      if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
        return json(400, { error: "bad_request" });
      }
      const nowSec = deps.nowSec();
      let caller: Caller | null = null;
      let unavailable = false;
      for (const c of candidates) {
        const v = await verifySignedRequest({
          secret: c.secret,
          headers: req.headers,
          rawBody,
          nowSec,
          store: deps.store,
        });
        if (v.ok) {
          caller = c.who;
          break;
        }
        if (v.status === 503) unavailable = true;
      }
      if (caller === null) {
        return unavailable
          ? json(503, { error: "unavailable" })
          : json(401, { error: "unauthorized" });
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
      if (body.purpose !== EVENING_REVIEW_PURPOSE) return json(400, { error: "bad_request" });
      if (caller === "worker" && body.env !== appEnvironment(deps.env)) {
        return json(400, { error: "bad_request" });
      }
      if (body.slot !== undefined && !(typeof body.slot === "string" && SLOT_RE.test(body.slot))) {
        return json(400, { error: "bad_request" });
      }
      const d = caller === "worker" ? body.d : (body.date ?? body.d);
      if (typeof d !== "string" || !DATE_RE.test(d)) return json(400, { error: "bad_request" });
      const nowDate = new Date(nowSec * 1000);
      const today = melbourneDate(nowDate);
      const yesterday = melbourneDate(new Date(nowSec * 1000 - DAY_MS));
      if (d !== today && d !== yesterday) return json(400, { error: "bad_request" });

      const db = deps.db();
      // M17 WP6 (D-399): hand the intraday candidates their outcome (read-after-run, idempotent). An
      // optional step: a failure never blocks the evening review.
      try {
        await recordOutcomes(db, MARKET, d);
      } catch {
        /* the review goes out without outcomes; the next run records them */
      }
      // M17 WP9 (D-399, D-466): measure the candidates whose horizon has completed, then run the
      // VAL-118 evaluator; own try/catch, a failure never blocks the review.
      try {
        await measureCandidates(db, MARKET, d);
        await evaluateIntradayStream(db, MARKET, new Date(nowSec * 1000).toISOString());
      } catch {
        /* measurement is retried by the next evening run */
      }
      const r: ReviewSendResult = await runReviewSend(
        {
          db,
          env: deps.env,
          now: () => new Date(nowSec * 1000),
          provider: deps.provider,
          sleep: deps.sleep,
        },
        d,
      );
      return json(200, {
        ok: r.ok,
        status: r.status,
        d: r.d,
        kind: r.kind,
        version: r.version,
        partial: r.partial,
        late: r.late,
        attempts: r.attempts,
        reason: r.reason ?? null,
        unread_days: r.unread.days,
        unread_incident: r.unread.incident,
      });
    } catch (e) {
      if (e instanceof LiveSendBlockedError) throw e;
      return json(503, { error: "unavailable" });
    }
  };
}
