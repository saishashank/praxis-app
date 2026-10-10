// E2E helper (TST-113): sign in as a seeded test identity on STAGING only.
// Zero dependencies. The secret is TEST_IDENTITY_SECRET (staging); it is never printed.
// Returns the session cookie as "name=value", ready for a Cookie header.
import { randomBytes } from "node:crypto";
import { sign } from "../smoke/sign.mjs";

export async function testLogin(baseUrl, secret, email, fetchImpl = fetch) {
  const body = JSON.stringify({ email });
  const headers = {
    "Content-Type": "application/json",
    ...sign(secret, body, Math.floor(Date.now() / 1000), randomBytes(16).toString("hex")),
  };
  const res = await fetchImpl(`${String(baseUrl).replace(/\/+$/, "")}/api/test-identity/login`, {
    method: "POST",
    headers,
    body,
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  if (res.status !== 200) throw new Error(`test login failed: HTTP ${res.status}`);
  const setCookie =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()[0]
      : res.headers.get("set-cookie");
  const pair = typeof setCookie === "string" ? setCookie.split(";")[0] : "";
  if (!/^(?:__Secure-)?authjs\.session-token=.+/.test(pair))
    throw new Error("test login failed: no session cookie");
  return pair;
}
