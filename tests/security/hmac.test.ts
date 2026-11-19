// @vitest-environment node
import { createHash, createHmac } from "node:crypto";
import { describe, expect, it, beforeEach } from "vitest";
// @ts-expect-error plain .mjs signer without types (the Actions-side twin)
import { sign } from "../../scripts/smoke/sign.mjs";
import {
  HEADER_NONCE,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  HEADER_VERSION,
  HMAC_SCHEME_VERSION,
  hmacMessage,
  signedHeaders,
} from "@/lib/security/hmacCore.mjs";
import { computeSignature, isValidSecret, verifySignedRequest } from "@/lib/security/hmac";
import { TursoNonceStore, type NonceStore } from "@/lib/security/replay";

const SECRET = "a".repeat(64);
const BODY = '{"purpose":"self-check"}';
const NOW = 1_700_000_000;
const NONCE = "0123456789abcdef0123456789abcdef";
const METHOD = "POST";
const PATH = "/api/internal/self-check";
const TARGET = { method: METHOD, path: PATH };
const BODY_SHA256 = "ec1ae6408754723394aa07541c0445102a9a99a42637390c542fb95a89664041";
// Fixed v2 literal for (SECRET, BODY, NOW, NONCE, POST, PATH). A change to any signer breaks this test.
const KNOWN_SIGNATURE = "9898d6c5f0870de218e1461a0944ed763e9926b6cd3f7c9f01bacaa529a73367";
// The v1 signature of the same inputs (message ts.nonce.body): must be refused (SEC-115).
const V1_SIGNATURE = "d115837af5305a21feb65b671c7f044bb5c564d701b89c5badaf99b27c1747c8";

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

const headersFor = (body = BODY, ts = NOW, nonce = NONCE, secret = SECRET, target = TARGET) =>
  new Headers(sign(secret, body, ts, nonce, target) as Record<string, string>);
const verify = (over: Partial<Parameters<typeof verifySignedRequest>[0]> = {}) =>
  verifySignedRequest({
    secret: SECRET,
    headers: headersFor(),
    rawBody: BODY,
    method: METHOD,
    path: PATH,
    nowSec: NOW,
    store: new MemoryStore(),
    ...over,
  });

describe("signature known answer", () => {
  it("matches node:crypto, the literal, and sign.mjs", () => {
    const message = ["v2", "POST", PATH, String(NOW), NONCE, BODY_SHA256].join("\n");
    const expected = createHmac("sha256", SECRET).update(message).digest("hex");
    expect(createHash("sha256").update(BODY).digest("hex")).toBe(BODY_SHA256);
    expect(computeSignature(SECRET, String(NOW), NONCE, BODY, METHOD, PATH)).toBe(expected);
    expect(expected).toBe(KNOWN_SIGNATURE);
    expect(sign(SECRET, BODY, NOW, NONCE, TARGET)).toEqual({
      "X-Praxis-Timestamp": String(NOW),
      "X-Praxis-Nonce": NONCE,
      "X-Praxis-Signature": KNOWN_SIGNATURE,
      "X-Praxis-Version": "2",
    });
  });
  it("sign.mjs refuses to sign without a method and path", () => {
    expect(() => sign(SECRET, BODY, NOW, NONCE)).toThrow(/target/);
  });
});

describe("hmacCore: the one definition of the scheme (V1-I3)", () => {
  it("message and header names are the documented ones", () => {
    expect(
      hmacMessage({ method: "post", path: "/p", timestamp: "1", nonce: "n", bodySha256Hex: "h" }),
    ).toBe("v2\nPOST\n/p\n1\nn\nh");
    expect(HMAC_SCHEME_VERSION).toBe(2);
    expect([HEADER_TIMESTAMP, HEADER_NONCE, HEADER_SIGNATURE, HEADER_VERSION]).toEqual([
      "x-praxis-timestamp",
      "x-praxis-nonce",
      "x-praxis-signature",
      "x-praxis-version",
    ]);
    expect(signedHeaders("1", "n", "s")).toEqual({
      "X-Praxis-Timestamp": "1",
      "X-Praxis-Nonce": "n",
      "X-Praxis-Signature": "s",
      "X-Praxis-Version": "2",
    });
  });
  it("the verifier and the caller-side signer both go through it", () => {
    const sig = createHmac("sha256", SECRET)
      .update(
        hmacMessage({
          method: METHOD,
          path: PATH,
          timestamp: String(NOW),
          nonce: NONCE,
          bodySha256Hex: BODY_SHA256,
        }),
      )
      .digest("hex");
    expect(sig).toBe(KNOWN_SIGNATURE);
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
  it("v2 passes; the SAME v1-signed request (old literal, no version header) is refused, nonce not claimed", async () => {
    const store = new MemoryStore();
    expect(await verify({ store })).toEqual({ ok: true });
    const v1Store = new MemoryStore();
    const v1 = new Headers({
      "X-Praxis-Timestamp": String(NOW),
      "X-Praxis-Nonce": NONCE,
      "X-Praxis-Signature": V1_SIGNATURE,
    });
    expect(await verify({ headers: v1, store: v1Store })).toEqual({ ok: false, status: 401 });
    // even with the version header added, a v1 signature does not verify as v2
    v1.set("X-Praxis-Version", "2");
    expect(await verify({ headers: v1, store: v1Store })).toEqual({ ok: false, status: 401 });
    expect(v1Store.seen.size).toBe(0);
  });
  it.each(["1", "3", "", "02"])(
    "refuses version header %j before the compare, nonce not claimed",
    async (v) => {
      const store = new MemoryStore();
      const h = headersFor();
      h.set("X-Praxis-Version", v);
      expect(await verify({ headers: h, store })).toEqual({ ok: false, status: 401 });
      expect(store.seen.size).toBe(0);
    },
  );
  it("refuses a signature made for another method (GET vs POST)", async () => {
    const store = new MemoryStore();
    expect(await verify({ method: "GET", store })).toEqual({ ok: false, status: 401 });
    expect(store.seen.size).toBe(0);
  });
  it("refuses a signature made for another path", async () => {
    const store = new MemoryStore();
    expect(await verify({ path: "/api/internal/maintenance", store })).toEqual({
      ok: false,
      status: 401,
    });
    expect(store.seen.size).toBe(0);
  });
  it("refuses a replay of the same signed request against another path or method with the same nonce", async () => {
    const store = new MemoryStore();
    expect((await verify({ store })).ok).toBe(true);
    // replay of the identical request: nonce already claimed
    expect(await verify({ store })).toEqual({ ok: false, status: 401 });
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
  // First call of a store: prune + insert + close; later calls inside a minute: insert + close.
  const ok = (affected: number, type = "ok", prune = true) => ({
    status: 200,
    json: async () => ({
      results: [
        ...(prune ? [{ type: "ok" }] : []),
        { type, response: { result: { affected_row_count: affected } } },
        { type: "ok" },
      ],
    }),
  });
  let nowSec = 1234;
  const make = (fetchImpl: unknown, url = "libsql://db.example.test") =>
    new TursoNonceStore(url, "TOKEN-SECRET", fetchImpl as typeof fetch, () => nowSec);
  beforeEach(() => {
    nowSec = 1234;
  });

  it("sends prune, insert and close (no DDL) and treats affected_row_count 1 as claimed", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const store = make(async (url: string, init: RequestInit) => {
      seen = { url, init };
      return ok(1);
    });
    expect(await store.claim(NONCE, 99)).toBe(true);
    expect(seen?.url).toBe("https://db.example.test/v2/pipeline");
    const reqs = JSON.parse(seen?.init.body as string).requests;
    expect(reqs).toHaveLength(3);
    expect(JSON.stringify(reqs)).not.toMatch(/CREATE TABLE/i);
    expect(reqs[0].stmt).toEqual({
      sql: "DELETE FROM request_nonce WHERE expires_at < ?",
      args: [{ type: "integer", value: "1234" }],
    });
    expect(reqs[1].stmt.sql).toMatch(/ON CONFLICT DO NOTHING$/);
    expect(reqs[1].stmt.args).toEqual([
      { type: "text", value: NONCE },
      { type: "integer", value: "99" },
    ]);
    expect(reqs[2]).toEqual({ type: "close" });
  });
  it("prunes at most once a minute per store and skips DDL on every call (V1-S11)", async () => {
    const bodies: string[][] = [];
    const store = make(async (_u: string, init: RequestInit) => {
      const reqs = JSON.parse(init.body as string).requests as { stmt?: { sql: string } }[];
      bodies.push(reqs.map((r) => r.stmt?.sql ?? "close"));
      return ok(1, "ok", reqs.length === 3);
    });
    await store.claim("a".repeat(32), 99);
    nowSec += 30;
    await store.claim("b".repeat(32), 99);
    nowSec += 31;
    await store.claim("c".repeat(32), 99);
    expect(bodies.map((b) => b.length)).toEqual([3, 2, 3]);
    expect(bodies.flat().some((q) => /CREATE/i.test(q))).toBe(false);
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
