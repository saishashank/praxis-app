// Caller-side signer for Actions -> Vercel calls (SEC-017). Zero dependencies.
// Scheme (twin of src/lib/security/hmac.ts; a known-answer test keeps them in step):
//   X-Praxis-Timestamp = unix seconds, X-Praxis-Nonce = 32 lowercase hex (16 random bytes),
//   X-Praxis-Signature = hex HMAC-SHA256(key = secret as UTF-8, message = `${ts}.${nonce}.${body}`)
import { createHmac } from 'node:crypto';

export function sign(secret, body, nowSec, nonce) {
  const timestamp = String(nowSec);
  const signature = createHmac('sha256', secret).update(`${timestamp}.${nonce}.${body}`, 'utf8').digest('hex');
  return {
    'X-Praxis-Timestamp': timestamp,
    'X-Praxis-Nonce': nonce,
    'X-Praxis-Signature': signature,
  };
}
