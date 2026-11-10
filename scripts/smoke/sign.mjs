// Caller-side signer for Actions -> Vercel calls (SEC-017, SEC-115). Zero dependencies.
// The scheme (message, header names) is defined once in src/lib/security/hmacCore.mjs and shared
// with the verifier and the Worker signer (V1-I3); a known-answer test keeps the primitives in step.
// v2 (D-957): the signature covers method, path and the body hash, so `target` is required.
import { createHash, createHmac } from 'node:crypto';
import { hmacMessage, signedHeaders } from '../../src/lib/security/hmacCore.mjs';

/** @param {{ method: string, path: string }} target  path = URL pathname only (no query, no host). */
export function sign(secret, body, nowSec, nonce, target) {
  if (!target || !target.method || !target.path) throw new Error('sign: target { method, path } is required (HMAC v2)');
  const timestamp = String(nowSec);
  const bodySha256Hex = createHash('sha256').update(body, 'utf8').digest('hex');
  const message = hmacMessage({ method: target.method, path: target.path, timestamp, nonce, bodySha256Hex });
  const signature = createHmac('sha256', secret).update(message, 'utf8').digest('hex');
  return signedHeaders(timestamp, nonce, signature);
}
