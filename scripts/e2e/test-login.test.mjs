// Run: node --test scripts/e2e/test-login.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { testLogin } from "./test-login.mjs";

const SECRET = "b".repeat(64);
const res = (status, setCookie) => ({
  status,
  headers: { getSetCookie: () => (setCookie ? [setCookie] : []), get: () => setCookie ?? null },
});

test("signs the body, posts to the login route and returns the cookie pair", async () => {
  let call;
  const f = async (url, init) => {
    call = { url, init };
    return res(200, "__Secure-authjs.session-token=abc; Path=/; HttpOnly; Secure; SameSite=Lax");
  };
  const cookie = await testLogin("https://stg.example.test/", SECRET, "a@x.test", f);
  assert.equal(cookie, "__Secure-authjs.session-token=abc");
  assert.equal(call.url, "https://stg.example.test/api/test-identity/login");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.body, '{"email":"a@x.test"}');
  const h = call.init.headers;
  const mac = createHmac("sha256", SECRET)
    .update(`${h["X-Praxis-Timestamp"]}.${h["X-Praxis-Nonce"]}.${call.init.body}`)
    .digest("hex");
  assert.equal(h["X-Praxis-Signature"], mac);
  assert.match(h["X-Praxis-Nonce"], /^[0-9a-f]{32}$/);
});

test("falls back to headers.get when getSetCookie is missing", async () => {
  const f = async () => ({ status: 200, headers: { get: () => "authjs.session-token=z; Path=/" } });
  assert.equal(
    await testLogin("http://localhost:3000", SECRET, "a@x.test", f),
    "authjs.session-token=z",
  );
});

test("non-200 or a missing cookie throws without leaking anything", async () => {
  await assert.rejects(
    testLogin("https://s.test", SECRET, "a@x.test", async () => res(401)),
    {
      message: "test login failed: HTTP 401",
    },
  );
  await assert.rejects(
    testLogin("https://s.test", SECRET, "a@x.test", async () => res(200)),
    {
      message: "test login failed: no session cookie",
    },
  );
  await assert.rejects(
    testLogin("https://s.test", SECRET, "a@x.test", async () => res(200, "other=1; Path=/")),
    /no session cookie/,
  );
});
