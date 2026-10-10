// @vitest-environment node
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs signer without types (the Actions-side twin)
import { sign } from "../../scripts/smoke/sign.mjs";
import { computeSignature, isValidSecret, verifySignedRequest } from "@/lib/security/hmac";
import { TursoNonceStore, type NonceStore } from "@/lib/security/replay";

const SECRET = "a".repeat(64);
const BODY = '{"purpose":"self-check"}';
const NOW = 1_700_000_000;
const NONCE = "0123456789abcdef0123456789abcdef";
// Fixed literal for (SECRET, BODY, NOW, NONCE). A change to either signer breaks this test.
const KNOWN_SIGNATURE = "d115837af5305a21feb65b671c7f044bb5c564d701b89c5badaf99b27c1747c8";

class MemoryStore implements NonceStore {
  seen = new Set<string>();
  async claim(nonce: string) {
    if (this.seen.has(nonce)) return false;
    this.seen.add(nonce);
    return true;
  }
}
const failingStore: NonceStore = {
  claim: async () => {
    throw new Error("boom");
  },
};

const headersFor = (body = BODY, ts = NOW, nonce = NONCE, secret = SECRET) =>
  new Headers(sign(secret, body, ts, nonce) as Record<string, string>);
const verify = (over: Partial<Parameters<typeof verifySignedRequest>[0]> = {}) =>
  verifySignedRequest({
    secret: SECRET,
    headers: headersFor(),
    rawBody: BODY,
    nowSec: NOW,
    store: new MemoryStore(),
    ...over,
  });

describe("signature known answer", () => {
  it("matches node:crypto, the literal, and sign.mjs", () => {
    const expected = createHmac("sha256", SECRET).update(`${NOW}.${NONCE}.${BODY}`).digest("hex");
    expect(computeSignature(SECRET, String(NOW), NONCE, BODY)).toBe(expected);
    expect(expected).toBe(KNOWN_SIGNATURE);
    expect(sign(SECRET, BODY, NOW, NONCE)).toEqual({
      "X-Praxis-Timestamp": String(NOW),
      "X-Praxis-Nonce": NONCE,
      "X-Praxis-Signature": KNOWN_SIGNATURE,
    });
  });
});

describe("verifySignedRequest", () => {
  it("accepts a valid request", async () => {
    expect(await verify()).toEqual({ ok: true });
  });
  it("rejects a wrong signature", async () => {
    const h = headersFor();
    h.set("X-Praxis-Signature", "0".repeat(64));
    expect(await verify({ headers: h })).toEqual({ ok: false, status: 401 });
  });
  it("rejects a signature made with another secret", async () => {
    expect(await verify({ headers: headersFor(BODY, NOW, NONCE, "b".repeat(64)) })).toEqual({
      ok: false,
      status: 401,
    });
  });
  it("rejects a tampered body", async () => {
    expect(await verify({ rawBody: '{"purpose":"other"}' })).toEqual({ ok: false, status: 401 });
  });
  it("accepts exactly 300 s old and 300 s ahead, rejects 301 s either way", async () => {
    expect((await verify({ nowSec: NOW + 300 })).ok).toBe(true);
    expect((await verify({ nowSec: NOW - 300 })).ok).toBe(true);
    expect(await verify({ nowSec: NOW + 301 })).toEqual({ ok: false, status: 401 });
    expect(await verify({ nowSec: NOW - 301 })).toEqual({ ok: false, status: 401 });
  });
  it.each([
    ["X-Praxis-Timestamp", "12.5"],
    ["X-Praxis-Timestamp", ""],
    ["X-Praxis-Nonce", "ABCDEF0123456789ABCDEF0123456789"],
    ["X-Praxis-Nonce", "abc"],
    ["X-Praxis-Signature", "xyz"],
    ["X-Praxis-Signature", KNOWN_SIGNATURE.toUpperCase()],
  ])("rejects malformed %s=%s", async (name, value) => {
    const h = headersFor();
    h.set(name, value);
    expect(await verify({ headers: h })).toEqual({ ok: false, status: 401 });
  });
  it("rejects missing headers", async () => {
    expect(await verify({ headers: new Headers() })).toEqual({ ok: false, status: 401 });
  });
  it.each([undefined, "", "short", "A".repeat(64)])("503 for bad secret %j", async (secret) => {
    expect(await verify({ secret })).toEqual({ ok: false, status: 503 });
  });
  it("rejects a replayed nonce", async () => {
    const store = new MemoryStore();
    expect((await verify({ store })).ok).toBe(true);
    expect(await verify({ store })).toEqual({ ok: false, status: 401 });
  });
  it("does not claim the nonce for an invalid signature", async () => {
    const store = new MemoryStore();
    await verify({ store, rawBody: "tampered" });
    expect(store.seen.size).toBe(0);
  });
  it("fails closed (503) when the store fails", async () => {
    expect(await verify({ store: failingStore })).toEqual({ ok: false, status: 503 });
  });
  it("claims with expiry ts + 300", async () => {
    let got = 0;
    await verify({
      store: {
        claim: async (_n, exp) => {
          got = exp;
          return true;
        },
      },
    });
    expect(got).toBe(NOW + 300);
  });
});

describe("isValidSecret", () => {
  it("accepts 64 lowercase hex only", () => {
    expect(isValidSecret(SECRET)).toBe(true);
    expect(isValidSecret("g".repeat(64))).toBe(false);
  });
});

describe("TursoNonceStore", () => {
  const ok = (affected: number, type = "ok") => ({
    status: 200,
    json: async () => ({
      results: [
        { type: "ok" },
        { type: "ok" },
        { type, response: { result: { affected_row_count: affected } } },
        { type: "ok" },
      ],
    }),
  });
  const make = (fetchImpl: unknown, url = "libsql://db.example.test") =>
    new TursoNonceStore(url, "TOKEN-SECRET", fetchImpl as typeof fetch, () => 1234);

  it("sends the four statements and treats affected_row_count 1 as claimed", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const store = make(async (url: string, init: RequestInit) => {
      seen = { url, init };
      return ok(1);
    });
    expect(await store.claim(NONCE, 99)).toBe(true);
    expect(seen?.url).toBe("https://db.example.test/v2/pipeline");
    const reqs = JSON.parse(seen?.init.body as string).requests;
    expect(reqs[0].stmt.sql).toMatch(/^CREATE TABLE IF NOT EXISTS request_nonce/);
    expect(reqs[1].stmt).toEqual({
      sql: "DELETE FROM request_nonce WHERE expires_at < ?",
      args: [{ type: "integer", value: "1234" }],
    });
    expect(reqs[2].stmt.sql).toMatch(/ON CONFLICT DO NOTHING$/);
    expect(reqs[2].stmt.args).toEqual([
      { type: "text", value: NONCE },
      { type: "integer", value: "99" },
    ]);
    expect(reqs[3]).toEqual({ type: "close" });
  });
  it("0 affected rows = replay", async () => {
    expect(await make(async () => ok(0)).claim(NONCE, 1)).toBe(false);
  });
  it("throws on HTTP error, bad shape, statement error, unknown count, bad config", async () => {
    await expect(make(async () => ({ status: 500 })).claim(NONCE, 1)).rejects.toThrow();
    await expect(
      make(async () => ({ status: 200, json: async () => ({}) })).claim(NONCE, 1),
    ).rejects.toThrow();
    await expect(make(async () => ok(1, "error")).claim(NONCE, 1)).rejects.toThrow();
    await expect(make(async () => ok(7)).claim(NONCE, 1)).rejects.toThrow();
    await expect(make(async () => ok(1), "ftp://x").claim(NONCE, 1)).rejects.toThrow();
    await expect(
      new TursoNonceStore("libsql://a.test", undefined).claim(NONCE, 1),
    ).rejects.toThrow();
  });
  it("can be constructed with the default fetch and clock", () => {
    expect(new TursoNonceStore("libsql://a.test", "t")).toBeInstanceOf(TursoNonceStore);
  });
});
