// Resend adapter (M5 T3, design 4.9, EML-001/003): POST https://api.resend.com/emails with fetch,
// a timeout, the `Idempotency-Key` header, and sender `Praxis <onboarding@resend.dev>` (no custom
// domain, EML-003). The API key comes from RESEND_API_KEY (already in Vercel, the smoke test and the
// self-check); it is only ever placed in the Authorization header. Response bodies are not read
// except the id of an accepted send, so nothing the provider says can reach a log.
// [VERIFY at build] that Resend honours Idempotency-Key for 24 h (design 2.4); correctness inside one
// invocation does not depend on it (the claim in send.ts is the primary guard).
import { createHash } from "node:crypto";
import {
  isTestRuntime,
  LiveSendBlockedError,
  RESEND_HOST,
  type EmailEnvVars,
  type EmailProvider,
  type OutgoingEmail,
  type ProviderResult,
} from "./provider";

export const RESEND_URL = `https://${RESEND_HOST}/emails`;
export const RESEND_FROM = "Praxis <onboarding@resend.dev>";
export const RESEND_TIMEOUT_MS = 8000; // design 4.10: timeout <= 8 s

export interface ResendOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  env?: EmailEnvVars;
  timeoutMs?: number;
}

/** Resend limits the key to 256 characters; longer email keys are hashed. */
export function idempotencyHeader(key: string): string {
  return key.length <= 256 ? key : `sha256:${createHash("sha256").update(key).digest("hex")}`;
}

function retryAfter(h: string | null): number | undefined {
  if (!h) return undefined;
  const n = Number(h.trim());
  return Number.isFinite(n) && n >= 0 ? Math.ceil(n) : undefined;
}

export function createResendProvider(opts: ResendOptions): EmailProvider {
  const timeoutMs = opts.timeoutMs ?? RESEND_TIMEOUT_MS;
  return {
    name: "resend",
    async send(msg: OutgoingEmail): Promise<ProviderResult> {
      // The structural guard: no injected fetch in a test run means no send at all.
      if (!opts.fetchImpl && isTestRuntime(opts.env ?? process.env)) {
        throw new LiveSendBlockedError();
      }
      const f = opts.fetchImpl ?? fetch;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await f(RESEND_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyHeader(msg.idempotencyKey),
          },
          body: JSON.stringify({
            from: msg.from,
            to: [msg.to],
            subject: msg.subject,
            html: msg.html,
            text: msg.text,
          }),
          signal: ctl.signal,
        });
        const httpStatus = res.status;
        if (res.ok) {
          let providerId: string | undefined;
          try {
            const j = (await res.json()) as { id?: unknown };
            if (typeof j.id === "string" && j.id.length > 0) providerId = j.id;
          } catch {
            // accepted without a readable id
          }
          return { outcome: "accepted", providerId, httpStatus };
        }
        // 409 = a request with this idempotency key is still in flight: try again later.
        if (httpStatus === 429 || httpStatus === 409 || httpStatus >= 500) {
          return {
            outcome: "retryable",
            httpStatus,
            retryAfterS: retryAfter(res.headers.get("retry-after")),
          };
        }
        return { outcome: "rejected", httpStatus };
      } catch (e) {
        if (e instanceof LiveSendBlockedError) throw e;
        const aborted =
          e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");
        return { outcome: aborted ? "timeout" : "network" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
