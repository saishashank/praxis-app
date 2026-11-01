// The ONE definition of the Actions -> Vercel signing scheme (SEC-017, SEC-101; V1-I3, D-780).
// Pure, dependency-free. Consumed by src/lib/security/hmac.ts (verifier), scripts/smoke/sign.mjs
// (Node callers) and worker/src/selfcheck.ts (WebCrypto, Worker). Only the HMAC primitive differs
// between runtimes; the canonical message, the header names and the header shape live here.
//   key     = the secret string as UTF-8 (ACTIONS_HMAC_SECRET, 64 hex chars)
//   message = `${timestamp}.${nonce}.${rawBody}`
export const HEADER_TIMESTAMP = "x-praxis-timestamp";
export const HEADER_NONCE = "x-praxis-nonce";
export const HEADER_SIGNATURE = "x-praxis-signature";

export function hmacMessage(timestamp, nonce, rawBody) {
  return `${timestamp}.${nonce}.${rawBody}`;
}

/** Outgoing request headers in their conventional capitalisation. */
export function signedHeaders(timestamp, nonce, signatureHex) {
  return {
    "X-Praxis-Timestamp": timestamp,
    "X-Praxis-Nonce": nonce,
    "X-Praxis-Signature": signatureHex,
  };
}
