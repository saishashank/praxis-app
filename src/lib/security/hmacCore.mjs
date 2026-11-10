// The ONE definition of the Actions -> Vercel signing scheme (SEC-017, SEC-101, SEC-115; V1-I3, D-780,
// D-957). Pure, dependency-free. Consumed by src/lib/security/hmac.ts (verifier), scripts/smoke/sign.mjs
// (Node callers) and worker/src/selfcheck.ts (WebCrypto, Worker). Only the HMAC and SHA-256 primitives
// differ between runtimes; the canonical message, the header names and the header shape live here.
//   key     = the secret string as UTF-8 (ACTIONS_HMAC_SECRET, 64 hex chars)
//   message = `v2\n${METHOD}\n${path}\n${timestamp}\n${nonce}\n${bodySha256Hex}`
//             METHOD upper-case; path = URL pathname only (no query, no host);
//             bodySha256Hex = lowercase hex SHA-256 of the raw body bytes.
// A signature is therefore valid for one method + path + body only; v1 (`ts.nonce.body`) is refused.
export const HMAC_SCHEME_VERSION = 2;
export const HEADER_TIMESTAMP = "x-praxis-timestamp";
export const HEADER_NONCE = "x-praxis-nonce";
export const HEADER_SIGNATURE = "x-praxis-signature";
export const HEADER_VERSION = "x-praxis-version";

export function hmacMessage({ method, path, timestamp, nonce, bodySha256Hex }) {
  return `v${HMAC_SCHEME_VERSION}\n${String(method).toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${bodySha256Hex}`;
}

/** Outgoing request headers in their conventional capitalisation. */
export function signedHeaders(timestamp, nonce, signatureHex) {
  return {
    "X-Praxis-Timestamp": timestamp,
    "X-Praxis-Nonce": nonce,
    "X-Praxis-Signature": signatureHex,
    "X-Praxis-Version": String(HMAC_SCHEME_VERSION),
  };
}
