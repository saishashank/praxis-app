// Caller-side signer for Actions -> Vercel calls (SEC-017). Zero dependencies.
// The scheme (message, header names) is defined once in src/lib/security/hmacCore.mjs and shared
// with the verifier and the Worker signer (V1-I3); a known-answer test keeps the primitives in step.
import { createHmac } from 'node:crypto';
import { hmacMessage, signedHeaders } from '../../src/lib/security/hmacCore.mjs';

export function sign(secret, body, nowSec, nonce) {
  const timestamp = String(nowSec);
  const signature = createHmac('sha256', secret).update(hmacMessage(timestamp, nonce, body), 'utf8').digest('hex');
  return signedHeaders(timestamp, nonce, signature);
}
