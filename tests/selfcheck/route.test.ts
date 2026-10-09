// @vitest-environment node
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs signer without types (the Actions-side twin)
import { sign } from "../../scripts/smoke/sign.mjs";
import { createSelfCheckHandler } from "@/lib/selfcheck/handler";
import type { NonceStore } from "@/lib/security/replay";
import * as route from "@/app/api/internal/self-check/route";

const SECRET = "9".repeat(64);
const BODY = '{"purpose":"self-check"}';
const NOW = 1_700_000_000;
const ENV = {
  ACTIONS_HMAC_SECRET: SECRET,
  TEST_IDENTITY_SECRET: "1".repeat(64),
  AUTH_SECRET: "2".repeat(64),
  CRON_SECRET: "3".repeat(64),
  PII_HASH_KEY: "4".repeat(64),
  APP_BASE_URL: "https://praxis-host.vercel.app",
  OWNER_EMAIL: "o@example.test",
  RESEND_API_KEY: "re_x",
};
const memStore = (): NonceStore => {
  const seen = new Set<string>();
  return {
    claim: async (n) => {
      if (seen.has(n)) return false;
      seen.add(n);
      return true;
    },
  };
};
// Fake network: every call returns 500, so checks fail but nothing leaves the process.
const offline = (async () =>
  new Response("upstream body SECRET-BODY", { status: 500 })) as typeof fetch;
const make = (over: Record<string, unknown> = {}) =>
  createSelfCheckHandler({
    env: ENV,
    fetchImpl: offline,
    store: memStore(),
    nowSec: () => NOW,
    ...over,
  });
let n = 0;
const nextNonce = () => (++n).toString(16).padStart(32, "0");
const post = (body = BODY, headers?: Record<string, string>, nonce = nextNonce()) =>
  new Request("https://praxis-host.vercel.app/api/internal/self-check", {
    method: "POST",
    body,
    headers: headers ?? (sign(SECRET, body, NOW, nonce) as Record<string, string>),
  });

describe("self-check handler", () => {
  it("200 with per-secret results, no-store, and no secrets or upstream bodies", async () => {
    const r = await make()(post());
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const text = await r.text();
    const json = JSON.parse(text);
    expect(json.env).toBe("staging");
    expect(json.results.length).toBeGreaterThan(5);
    expect(json.commit).toBeNull();
    for (const v of Object.values(ENV)) expect(text).not.toContain(v);
    expect(text).not.toContain("praxis-host");
    expect(text).not.toContain("SECRET-BODY");
  });
  it("401 generic body for bad signature, missing headers, replay, stale timestamp", async () => {
    const h = make();
    const bad = sign("8".repeat(64), BODY, NOW, "a".repeat(32)) as Record<string, string>;
    const stale = sign(SECRET, BODY, NOW - 301, "b".repeat(32)) as Record<string, string>;
    const nonce = "c".repeat(32);
    expect((await h(post(BODY, undefined, nonce))).status).toBe(200);
    for (const req of [
      post(BODY, bad),
      post(BODY, {}),
      post(BODY, stale),
      post(BODY, undefined, nonce),
    ]) {
      const r = await h(req);
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: "unauthorized" });
    }
  });
  it("503 generic when secret is missing or malformed (signature not evaluated)", async () => {
    for (const secret of [undefined, "", "zz"]) {
      const r = await make({ env: { ...ENV, ACTIONS_HMAC_SECRET: secret } })(post());
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ error: "unavailable" });
    }
  });
  it("503 when the replay store fails, without leaking its error", async () => {
    const store = { claim: () => Promise.reject(new Error("db host secret")) };
    const r = await make({ store })(post());
    expect(r.status).toBe(503);
    expect(await r.text()).not.toContain("secret");
  });
  it("400 for oversize body, non-JSON, wrong purpose, non-object (all validly signed)", async () => {
    const h = make();
    for (const body of ["x".repeat(4097), "not json", '{"purpose":"other"}', "null", "[]"]) {
      const r = await h(post(body));
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: "bad_request" });
    }
  });
  it("503 on an unexpected exception", async () => {
    const broken = {
      text: () => Promise.reject(new Error("x")),
      headers: new Headers(),
    } as unknown as Request;
    expect((await make()(broken)).status).toBe(503);
  });
});

describe("route module", () => {
  it("exports POST only, dynamic and nodejs", () => {
    expect(Object.keys(route).sort()).toEqual(["POST", "dynamic", "runtime"]);
    expect(route.dynamic).toBe("force-dynamic");
    expect(route.runtime).toBe("nodejs");
  });
  it("POST answers 503 when ACTIONS_HMAC_SECRET is not configured (no network reached)", async () => {
    const saved = process.env.ACTIONS_HMAC_SECRET;
    delete process.env.ACTIONS_HMAC_SECRET;
    try {
      expect((await route.POST(post(BODY, {}))).status).toBe(503);
    } finally {
      if (saved !== undefined) process.env.ACTIONS_HMAC_SECRET = saved;
    }
  });
  it("POST with a valid signature fails closed (503) when the nonce store is not configured", async () => {
    const saved = { ...process.env };
    process.env.ACTIONS_HMAC_SECRET = SECRET;
    delete process.env.TURSO_MAIN_URL;
    delete process.env.TURSO_MAIN_TOKEN;
    try {
      const headers = sign(SECRET, BODY, Math.floor(Date.now() / 1000), nextNonce());
      const r = await route.POST(post(BODY, headers as Record<string, string>));
      expect(r.status).toBe(503);
    } finally {
      process.env = saved;
    }
  });
});
