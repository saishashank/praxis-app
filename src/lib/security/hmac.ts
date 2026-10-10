// Signed Actions -> Vercel calls (SEC-017, SEC-101). Small on purpose; Opus reviews every line.
//
// Signing scheme (the same text is in scripts/smoke/README.md; scripts/smoke/sign.mjs is the
// caller-side twin and a known-answer test keeps both in step):
//   X-Praxis-Timestamp  unix seconds, integer string
//   X-Praxis-Nonce      32 lowercase hex characters (16 random bytes), single use
//   X-Praxis-Signature  lowercase hex HMAC-SHA256
//                       key     = the secret string as UTF-8 (ACTIONS_HMAC_SECRET, 64 hex chars)
//                       message = `${timestamp}.${nonce}.${rawBody}`
// Verification order: secret configured -> headers well-formed -> |now - ts| <= 300 s
// (past and future) -> constant-time signature compare -> replay claim of the nonce.
// The nonce is claimed only AFTER the signature is valid, so unsigned traffic cannot burn nonces.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { NonceStore } from "./replay";

export const MAX_SKEW_SEC = 300;
export const HEADER_TIMESTAMP = "x-praxis-timestamp";
export const HEADER_NONCE = "x-praxis-nonce";
export const HEADER_SIGNATURE = "x-praxis-signature";

const SECRET_RE = /^[0-9a-f]{64}$/;
const TIMESTAMP_RE = /^[0-9]{1,12}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;
const SIGNATURE_RE = /^[0-9a-f]{64}$/;

export function isValidSecret(secret: string | undefined): secret is string {
  return typeof secret === "string" && SECRET_RE.test(secret);
}

export function computeSignature(
  secret: string,
  timestamp: string,
  nonce: string,
  rawBody: string,
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${nonce}.${rawBody}`, "utf8")
    .digest("hex");
}

// 401 = every authentication failure (callers return the same generic body for all reasons).
// 503 = server misconfigured or the replay store failed (fail closed).
export type VerifyResult = { ok: true } | { ok: false; status: 401 | 503 };

export async function verifySignedRequest(args: {
  secret: string | undefined;
  headers: Headers;
  rawBody: string;
  nowSec: number;
  store: NonceStore;
}): Promise<VerifyResult> {
  const { secret, headers, rawBody, nowSec, store } = args;
  if (!isValidSecret(secret)) return { ok: false, status: 503 };

  const timestamp = headers.get(HEADER_TIMESTAMP) ?? "";
  const nonce = headers.get(HEADER_NONCE) ?? "";
  const signature = headers.get(HEADER_SIGNATURE) ?? "";
  if (!TIMESTAMP_RE.test(timestamp) || !NONCE_RE.test(nonce) || !SIGNATURE_RE.test(signature)) {
    return { ok: false, status: 401 };
  }

  const ts = Number(timestamp);
  if (Math.abs(nowSec - ts) > MAX_SKEW_SEC) return { ok: false, status: 401 };

  const expected = Buffer.from(computeSignature(secret, timestamp, nonce, rawBody), "hex");
  const given = Buffer.from(signature, "hex");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, status: 401 };
  }

  try {
    // After ts + 300 s the timestamp check rejects the request anyway, so the nonce can expire.
    const first = await store.claim(nonce, ts + MAX_SKEW_SEC);
    return first ? { ok: true } : { ok: false, status: 401 };
  } catch {
    return { ok: false, status: 503 };
  }
}
