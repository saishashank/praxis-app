// scripts/selfhost/jwt.mjs: offline checks of the key format and the token shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, mintToken, verifyToken } from "./jwt.mjs";

test("the public key is 32 raw bytes in URL-safe base64 without padding", () => {
  const k = generateKeyPair();
  assert.match(k.publicKey, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(k.publicKey, "base64url").length, 32);
});

test("a token verifies with its own key and not with another", () => {
  const a = generateKeyPair();
  const b = generateKeyPair();
  const t = mintToken(a.privateKeyPem);
  assert.equal(verifyToken(t, a.publicKey), true);
  assert.equal(verifyToken(t, b.publicKey), false);
  const claims = JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString());
  assert.equal(claims.a, "rw");
  assert.ok(claims.exp > claims.iat);
});

test("access, ttl and namespace options reach the claims", () => {
  const k = generateKeyPair();
  const t = mintToken(k.privateKeyPem, { access: "ro", ttlSec: 60, nowSec: 1000, ns: "main" });
  assert.deepEqual(JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString()), {
    a: "ro",
    exp: 1060,
    iat: 1000,
    id: "main",
  });
});
