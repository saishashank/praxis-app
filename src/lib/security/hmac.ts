// Signed Actions -> Vercel calls (SEC-017, SEC-101). Small on purpose; Opus reviews every line.
//
// Signing scheme v2 (SEC-115, D-957; the same text is in scripts/smoke/README.md; scripts/smoke/sign.mjs
// is the caller-side twin and a known-answer test keeps both in step):
//   X-Praxis-Version    "2"; anything else (a v1 signer sends none) is refused before the compare
//   X-Praxis-Timestamp  unix seconds, integer string
//   X-Praxis-Nonce      32 lowercase hex characters (16 random bytes), single use
//   X-Praxis-Signature  lowercase hex HMAC-SHA256
//                       key     = the secret string as UTF-8 (ACTIONS_HMAC_SECRET, 64 hex chars)
//                       message = v2, METHOD, path, timestamp, nonce, sha256Hex(rawBody) joined by LF
//                       path = URL pathname only (no query, no host), taken from the request
// So a signature is valid for one method, one path and one body only.
// Verification order: secret configured -> headers well-formed (incl. version) -> |now - ts| <= 300 s
// (past and future) -> constant-time signature compare -> replay claim of the nonce.
// The nonce is claimed only AFTER the signature is valid, so unsigned traffic cannot burn nonces.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { NonceStore } from "./replay";
import {
  HEADER_NONCE,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  HEADER_VERSION,
  HMAC_SCHEME_VERSION,
  hmacMessage,
} from "./hmacCore.mjs";

// The scheme (message, header names) is defined once in hmacCore.mjs and shared with the Node and
// Worker signers (V1-I3).
export { HEADER_NONCE, HEADER_SIGNATURE, HEADER_TIMESTAMP, HEADER_VERSION, HMAC_SCHEME_VERSION };

export const MAX_SKEW_SEC = 300;

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
  method: string,
  path: string,
): string {
  const bodySha256Hex = createHash("sha256").update(rawBody, "utf8").digest("hex");
  return createHmac("sha256", secret)
    .update(hmacMessage({ method, path, timestamp, nonce, bodySha256Hex }), "utf8")
    .digest("hex");
}

// 401 = every authentication failure (callers return the same generic body for all reasons).
// 503 = server misconfigured or the replay store failed (fail closed).
export type VerifyResult = { ok: true } | { ok: false; status: 401 | 503 };

export async function verifySignedRequest(args: {
  secret: string | undefined;
  headers: Headers;
  rawBody: string;
  /** Request method and URL pathname, taken from the request itself (never from the body). */
  method: string;
  path: string;
  nowSec: number;
  store: NonceStore;
}): Promise<VerifyResult> {
  const { secret, headers, rawBody, method, path, nowSec, store } = args;
  if (!isValidSecret(secret)) return { ok: false, status: 503 };

  const timestamp = headers.get(HEADER_TIMESTAMP) ?? "";
  const nonce = headers.get(HEADER_NONCE) ?? "";
  const signature = headers.get(HEADER_SIGNATURE) ?? "";
  // v1 signers send no version header: refused here, before any compare, nonce not claimed.
  if (headers.get(HEADER_VERSION) !== String(HMAC_SCHEME_VERSION))
    return { ok: false, status: 401 };
  if (!TIMESTAMP_RE.test(timestamp) || !NONCE_RE.test(nonce) || !SIGNATURE_RE.test(signature)) {
    return { ok: false, status: 401 };
  }

  const ts = Number(timestamp);
  if (Math.abs(nowSec - ts) > MAX_SKEW_SEC) return { ok: false, status: 401 };

  const expected = Buffer.from(
    computeSignature(secret, timestamp, nonce, rawBody, method, path),
    "hex",
  );
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
