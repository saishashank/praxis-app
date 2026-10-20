// Keyed digest behind the opaque references masked viewers get in place of ids that carry a stock
// code or an exact date (`ck:` cards, `pk:` picks, `mk:` alert keys; DAT-124, D-129, D-139). The ids
// are guessable (code x date x family), so a plain SHA-256 could be reversed by trying them all; an
// HMAC under the server's AUTH_SECRET cannot. Each kind has its own label, so a digest of one kind is
// never valid for another. Server only: the secret never reaches a client bundle.
import { createHmac } from "node:crypto";

export const REF_HEX_LENGTH = 16; // threshold-ok: digest length shown in the reference

// Fixed key for tests and local development only; production without AUTH_SECRET throws (fail closed).
const DEV_KEY = "praxis-dev-opaque-ref-key";

function refKey(env: Record<string, string | undefined>): string {
  const k = env.AUTH_SECRET;
  if (k !== undefined && k.length > 0) return k;
  if (env.NODE_ENV === "production")
    throw new Error("AUTH_SECRET is required for opaque references");
  return DEV_KEY;
}

/** 16 hex of HMAC-SHA-256(AUTH_SECRET, "<kind>:<id>"). */
export function opaqueDigest(
  kind: "ck" | "pk" | "mk",
  id: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return createHmac("sha256", refKey(env))
    .update(`${kind}:${id}`)
    .digest("hex")
    .slice(0, REF_HEX_LENGTH);
}
