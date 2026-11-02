// @vitest-environment node
// M17 WP5: the signed route api/internal/intraday-scan (SEC-017 c2, D-067 pattern): unsigned and
// wrong-purpose requests are refused with fixed words; a signed call on a source that is not accepted
// answers 200 "skipped" and writes nothing. No network.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs signer without types (the Actions-side twin)
import { sign } from "../../scripts/smoke/sign.mjs";
import type { NonceStore } from "@/lib/security/replay";
import { createIntradayScanHandler } from "@/lib/intraday/handler";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const SECRET = "7".repeat(64);
const NOW = Date.UTC(2026, 10, 3, 23, 45, 0) / 1000; // Wed 2026-11-04 10:45 AEDT
const ENV = { WORKER_HMAC_SECRET: SECRET, PRAXIS_ENV: "staging" } as Record<
  string,
  string | undefined
>;
let main: Client;
let n = 0;
const nonce = () => (++n).toString(16).padStart(32, "0");
const store = (): NonceStore => {
  const seen = new Set<string>();
  return {
    claim: async (x) => {
      if (seen.has(x)) return false;
      seen.add(x);
      return true;
    },
  };
};
let calls = 0;
const handler = () =>
  createIntradayScanHandler({
    env: ENV,
    store: store(),
    nowSec: () => NOW,
    today: () => "2026-11-04",
    db: () => main,
    fetch: async () => {
      calls += 1;
      return { ok: false, status: 500, json: async () => ({}) };
    },
    sleep: async () => {},
  });
const req = (b: object, signed = true) => {
  const raw = JSON.stringify(b);
  return new Request("https://praxis-host.vercel.app/api/internal/intraday-scan", {
    method: "POST",
    body: raw,
    headers: signed ? (sign(SECRET, raw, NOW, nonce()) as Record<string, string>) : {},
  });
};
const body = (over: Record<string, unknown> = {}) => ({
  purpose: "intraday-scan",
  env: "staging",
  d: "2026-11-04",
  slot: "intraday-scan",
  ...over,
});

beforeEach(async () => {
  main = await freshDb("main");
  calls = 0;
});

describe("POST /api/internal/intraday-scan", () => {
  it("refuses unsigned and wrong-purpose requests", async () => {
    const h = handler();
    expect((await h(req(body(), false))).status).toBe(401);
    expect((await h(req(body({ purpose: "preopen" })))).status).toBe(400);
  });

  it("a signed call with the source not accepted is a 200 skip and writes nothing", async () => {
    const r = await handler()(req(body()));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "skipped", reason: "source_not_accepted" });
    expect((await main.execute("SELECT 1 FROM quote_run")).rows).toHaveLength(0);
    expect(calls).toBe(0);
  });
});
