// @vitest-environment node
// DAT-143, ROL-101a, PLT-022b, SEC-017, SEC-108 d: signed auth-DB backup export route
// POST /api/internal/backup-export (same cases as the maintenance route tests, plus: the body is
// age ciphertext only, never plaintext, and a caller cannot supply the key).
import { createClient, type Client } from "@libsql/client";
import { generateIdentity, identityToRecipient } from "age-encryption";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs signer without types (the Actions-side twin)
import { sign } from "../../scripts/smoke/sign.mjs";
import * as route from "@/app/api/internal/backup-export/route";
import { COUNTS_HEADER, createBackupExportHandler } from "@/lib/backup/exportHandler";
import { decryptToText, looksLikeAge } from "@/lib/backup/crypto";
import { dumpDatabase } from "@/lib/backup/dump";
import { restoreDatabase } from "@/lib/backup/restore";
import type { NonceStore } from "@/lib/security/replay";
import { cleanupTempDbs, freshDb, tempDbUrl, track } from "../db/helpers";

afterEach(cleanupTempDbs);

const SECRET = "9".repeat(64);
const NOW = 1_700_000_000;
const BODY = '{"purpose":"backup-export","date":"2023-11-15"}';
const MARK = "AUTH-ROW-MARKER-5e2d";
let IDENTITY = "";
let RECIPIENT = "";
beforeAll(async () => {
  IDENTITY = await generateIdentity();
  RECIPIENT = await identityToRecipient(IDENTITY);
});
const env = (over: Record<string, string | undefined> = {}) => ({
  ACTIONS_HMAC_SECRET: SECRET,
  BACKUP_PUBLIC_KEY: RECIPIENT,
  ...over,
});
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
let auth: Client;
beforeEach(async () => {
  auth = await freshDb("auth");
  await auth.execute({
    sql: "INSERT INTO app_user (email, name, created_at, updated_at) VALUES (?, ?, 'a', 'a')",
    args: [`${MARK}@example.test`, "Zoë"],
  });
});
const make = (over: Record<string, unknown> = {}) =>
  createBackupExportHandler({
    env: env(),
    store: memStore(),
    nowSec: () => NOW,
    authDb: () => auth,
    ...over,
  } as Parameters<typeof createBackupExportHandler>[0]);
let n = 0;
const nextNonce = () => (++n).toString(16).padStart(32, "0");
const post = (body = BODY, headers?: Record<string, string>, nonce = nextNonce()) =>
  new Request("https://praxis-host.vercel.app/api/internal/backup-export", {
    method: "POST",
    body,
    headers: headers ?? (sign(SECRET, body, NOW, nonce) as Record<string, string>),
  });
const signed = (body: string) => post(body, sign(SECRET, body, NOW, nextNonce()));

describe("backup export handler", () => {
  it("200: octet-stream age ciphertext only; no plaintext, no row text; counts header", async () => {
    const r = await make()(post());
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/octet-stream");
    expect(r.headers.get("cache-control")).toBe("no-store");
    const bytes = new Uint8Array(await r.arrayBuffer());
    expect(looksLikeAge(bytes)).toBe(true);
    const raw = Buffer.from(bytes);
    expect(raw.includes(MARK)).toBe(false);
    expect(raw.includes("app_user")).toBe(false);
    expect(raw.includes('"kind"')).toBe(false);
    const counts = JSON.parse(r.headers.get(COUNTS_HEADER) ?? "{}");
    expect(counts.app_user).toBe(1);
    expect(r.headers.get(COUNTS_HEADER)).not.toContain(MARK);
  });

  it("the ciphertext decrypts with the private key and restores to the same auth data", async () => {
    const r = await make()(post());
    const text = await decryptToText(new Uint8Array(await r.arrayBuffer()), IDENTITY);
    expect(text).toContain(MARK);
    expect(text).toContain('"db":"auth"');
    const target = track(createClient({ url: tempDbUrl() }));
    const restored = await restoreDatabase(target, text);
    const src = await dumpDatabase(auth, { name: "auth", createdAt: "x" });
    expect(restored.sha256).toEqual(src.sha256);
  });

  it("never returns rate_limit rows (ephemeral)", async () => {
    await auth.execute("INSERT INTO rate_limit SELECT 'ip:1', 5, 5");
    const r = await make()(post());
    const text = await decryptToText(new Uint8Array(await r.arrayBuffer()), IDENTITY);
    expect(text).not.toContain("ip:1");
  });

  it("401 generic body for bad signature, missing headers, replay, stale and future timestamps", async () => {
    const h = make();
    const bad = sign("8".repeat(64), BODY, NOW, "a".repeat(32)) as Record<string, string>;
    const stale = sign(SECRET, BODY, NOW - 301, "b".repeat(32)) as Record<string, string>;
    const future = sign(SECRET, BODY, NOW + 301, "d".repeat(32)) as Record<string, string>;
    const tampered = sign(
      SECRET,
      '{"purpose":"backup-export","date":"2023-11-14"}',
      NOW,
      "e".repeat(32),
    ) as Record<string, string>;
    for (const headers of [bad, stale, future, tampered, {}]) {
      const r = await h(post(BODY, headers));
      expect(r.status).toBe(401);
      expect(r.headers.get("content-type")).toContain("application/json");
      expect(await r.json()).toEqual({ error: "unauthorized" });
    }
    const ok = sign(SECRET, BODY, NOW, "c".repeat(32)) as Record<string, string>;
    expect((await h(post(BODY, ok))).status).toBe(200);
    const replay = await h(post(BODY, ok));
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ error: "unauthorized" });
  });

  it("a maintenance-purpose signature does not work here (purpose is inside the signed body)", async () => {
    const r = await make()(signed('{"purpose":"maintenance","date":"2023-11-15"}'));
    expect(r.status).toBe(400);
  });

  it("400 for bad JSON, wrong shape, bad date, extra fields (no caller-supplied key), oversize", async () => {
    const h = make();
    for (const body of [
      "not json",
      "[]",
      "null",
      '"x"',
      "{}",
      '{"purpose":"backup-export"}',
      '{"purpose":"backup-export","date":"2023-02-30"}',
      '{"purpose":"backup-export","date":"15/11/2023"}',
      '{"purpose":"backup-export","date":20231115}',
      `{"purpose":"backup-export","date":"2023-11-15","recipient":"${RECIPIENT}"}`,
      `{"purpose":"backup-export","date":"2023-11-15","BACKUP_PUBLIC_KEY":"${RECIPIENT}"}`,
      '{"purpose":"other","date":"2023-11-15"}',
      JSON.stringify({ purpose: "backup-export", date: "2023-11-15", pad: "x".repeat(5000) }),
    ]) {
      const r = await h(signed(body));
      expect(r.status, body.slice(0, 40)).toBe(400);
      expect(await r.json()).toEqual({ error: "bad_request" });
    }
  });

  it("503 without a valid BACKUP_PUBLIC_KEY; never plaintext", async () => {
    for (const key of [undefined, "", "age1" + "q".repeat(58), await generateIdentity(), "junk"]) {
      const r = await make({ env: env({ BACKUP_PUBLIC_KEY: key }) })(post());
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ error: "unavailable" });
    }
  });

  it("503 when the HMAC secret is missing or malformed (before reading the body)", async () => {
    for (const s of [undefined, "", "short", "G".repeat(64)]) {
      const r = await make({ env: env({ ACTIONS_HMAC_SECRET: s }) })(post());
      expect(r.status).toBe(503);
    }
  });

  it("503 when the replay store fails or the auth DB is unavailable (fail closed, no body detail)", async () => {
    const failing: NonceStore = {
      claim: async () => {
        throw new Error("boom https://secret-host");
      },
    };
    const a = await make({ store: failing })(post());
    expect(a.status).toBe(503);
    const b = await make({
      authDb: () => {
        throw new Error("database not configured");
      },
    })(post());
    expect(b.status).toBe(503);
    expect(await b.text()).not.toContain("database");
  });

  it("route.ts exports POST only and answers 503 when nothing is configured", async () => {
    expect(Object.keys(route).filter((k) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(k))).toEqual([
      "POST",
    ]);
    const saved = { ...process.env };
    delete process.env.ACTIONS_HMAC_SECRET;
    try {
      const r = await route.POST(post());
      expect(r.status).toBe(503);
    } finally {
      process.env = saved;
    }
  });
});
