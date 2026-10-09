// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  appBaseUrl,
  authSecret,
  backupPublicKey,
  deriveEnv,
  githubRead,
  googleAiKey,
  googleOAuth,
  groqKey,
  openRouterKey,
  resendKey,
  runSelfChecks,
  testIdentityAbsent,
  tursoAuth,
  tursoMain,
  workerHmac,
  type Env,
} from "@/lib/selfcheck/checks";

const HEX = "c".repeat(64);
const AGE = "age1" + "q".repeat(58);
const SECRETS = {
  AUTH_SECRET: HEX,
  CRON_SECRET: "d".repeat(64),
  PII_HASH_KEY: "e".repeat(64),
  APP_BASE_URL: "https://praxis-secret-host.vercel.app",
  OWNER_EMAIL: "owner-secret@example.test",
  TURSO_MAIN_URL: "libsql://main-secret.example.test",
  TURSO_MAIN_TOKEN: "MAIN-TOKEN-SECRET",
  TURSO_AUTH_URL: "libsql://auth-secret.example.test",
  TURSO_AUTH_TOKEN: "AUTH-TOKEN-SECRET",
  AUTH_GOOGLE_ID: "123.apps.googleusercontent.com",
  AUTH_GOOGLE_SECRET: "GOOGLE-SECRET-VALUE",
  RESEND_API_KEY: "re_RESEND_SECRET",
  WORKER_HMAC_SECRET: "f".repeat(64),
};
const PROD: Env = {
  ...SECRETS,
  OWNER_RECOVERY_EMAIL: "recovery-secret@example.test",
  BACKUP_PUBLIC_KEY: AGE,
  GITHUB_READ_TOKEN: "GH-SECRET",
  GOOGLE_AI_API_KEY: "GAI-SECRET",
  GROQ_API_KEY: "GROQ-SECRET",
  OPENROUTER_API_KEY: "OR-SECRET",
  APP_COMMIT: "abc123",
};
const STAGING: Env = { ...SECRETS, TEST_IDENTITY_SECRET: "1".repeat(64) };

const res = (status: number, body: unknown = {}) =>
  ({ status, json: async () => body }) as unknown as Response;

// Fake network: Turso echoes the inserted nonce; Google answers invalid_grant; the rest 200.
function fakeFetch(over: Record<string, () => Response> = {}) {
  const calls: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    for (const [prefix, make] of Object.entries(over)) if (url.startsWith(prefix)) return make();
    if (url.endsWith("/v2/pipeline")) {
      const reqs = JSON.parse(init?.body as string).requests;
      const nonce = reqs[1].stmt.args[0].value;
      return res(200, {
        results: [
          { type: "ok" },
          { type: "ok" },
          { type: "ok", response: { result: { rows: [[{ type: "text", value: nonce }]] } } },
          { type: "ok" },
          { type: "ok" },
        ],
      });
    }
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return res(400, { error: "invalid_grant" });
    }
    return res(200);
  }) as unknown as typeof fetch;
  return Object.assign(f, { calls });
}

describe("deriveEnv", () => {
  it("derives from which secrets exist", () => {
    expect(deriveEnv(PROD)).toBe("production");
    expect(deriveEnv(STAGING)).toBe("staging");
    expect(deriveEnv({})).toBe("unknown");
    expect(deriveEnv({ BACKUP_PUBLIC_KEY: AGE, TEST_IDENTITY_SECRET: HEX })).toBe("production");
  });
});

describe("runSelfChecks", () => {
  it("production: everything passes, no pending, never leaks values", async () => {
    const f = fakeFetch();
    const r = await runSelfChecks(PROD, f);
    expect(r.results.filter((x) => !x.ok)).toEqual([]);
    expect(r).toMatchObject({ env: "production", commit: "abc123", failed: 0, pending: 0 });
    expect(r.passed).toBe(r.results.length);
    const text = JSON.stringify(r);
    for (const [k, v] of Object.entries(PROD))
      if (v && k !== "APP_COMMIT") expect(text).not.toContain(v);
    expect(text).not.toContain("secret-host");
    expect(
      f.calls.some((u) => u.startsWith("https://api.github.com/repos/saishashank/praxis-app/")),
    ).toBe(true);
  });
  it("staging: passes, has no production-only checks, commit null", async () => {
    const r = await runSelfChecks(STAGING, fakeFetch());
    expect(r).toMatchObject({ env: "staging", commit: null, failed: 0 });
    expect(r.results.some((x) => x.name === "TEST_IDENTITY_SECRET format" && x.ok)).toBe(true);
    expect(r.results.some((x) => x.name === "GITHUB_READ_TOKEN")).toBe(false);
  });
  it("absent WORKER_HMAC_SECRET is pending and not a failure", async () => {
    const env = { ...STAGING, WORKER_HMAC_SECRET: undefined };
    const r = await runSelfChecks(env, fakeFetch());
    expect(r).toMatchObject({ failed: 0, pending: 1 });
    expect(r.results.find((x) => x.pending)).toMatchObject({ ok: false });
  });
  it("unknown environment fails with one result", async () => {
    const r = await runSelfChecks({}, fakeFetch());
    expect(r).toMatchObject({ env: "unknown", failed: 1 });
  });
  it("a throwing network call becomes the error name only", async () => {
    const f = (async () => {
      throw Object.assign(new Error("host secret"), { name: "TimeoutError" });
    }) as unknown as typeof fetch;
    const r = await runSelfChecks(STAGING, f);
    expect(r.results.find((x) => x.name === "Turso main DB round-trip")?.detail).toBe(
      "TimeoutError",
    );
    expect(JSON.stringify(r)).not.toContain("host secret");
  });
});

describe("individual checks", () => {
  const f = fakeFetch();
  it("AUTH_SECRET accepts hex or base64, rejects others", async () => {
    expect((await authSecret({ AUTH_SECRET: HEX }, f)).ok).toBe(true);
    expect((await authSecret({ AUTH_SECRET: "QUJD".repeat(11) }, f)).detail).toMatch(/base64/);
    expect((await authSecret({ AUTH_SECRET: "short" }, f)).detail).toBe("malformed");
    expect((await authSecret({}, f)).detail).toBe("missing");
  });
  it("APP_BASE_URL rules", async () => {
    const t = async (v?: string) => (await appBaseUrl({ APP_BASE_URL: v }, f)).ok;
    expect(await t("https://x.vercel.app")).toBe(true);
    expect(await t("https://x.vercel.app/")).toBe(true);
    expect(await t("http://x.vercel.app")).toBe(false);
    expect(await t("https://x.vercel.app/p")).toBe(false);
    expect(await t("https://x.vercel.app/?q=1")).toBe(false);
    expect(await t("https://x.example.com")).toBe(false);
    expect(await t("https://u:p@x.vercel.app")).toBe(false);
    expect(await t("not a url")).toBe(false);
    expect(await t(undefined)).toBe(false);
  });
  it("BACKUP_PUBLIC_KEY", async () => {
    expect((await backupPublicKey({ BACKUP_PUBLIC_KEY: AGE }, f)).ok).toBe(true);
    expect((await backupPublicKey({ BACKUP_PUBLIC_KEY: "age1bad" }, f)).ok).toBe(false);
    expect((await backupPublicKey({}, f)).detail).toBe("missing");
  });
  it("production with TEST_IDENTITY_SECRET present fails (SEC-109)", async () => {
    expect((await testIdentityAbsent({ TEST_IDENTITY_SECRET: HEX }, f)).ok).toBe(false);
    expect((await testIdentityAbsent({}, f)).ok).toBe(true);
    const r = await runSelfChecks({ ...PROD, TEST_IDENTITY_SECRET: HEX }, fakeFetch());
    expect(r.env).toBe("production");
    expect(r.results.find((x) => x.name === "TEST_IDENTITY_SECRET absent")?.ok).toBe(false);
    expect(r.failed).toBe(1);
  });
  it("hex / email format failures in a full run", async () => {
    const env = { ...PROD, CRON_SECRET: "nothex", OWNER_EMAIL: "bad", PII_HASH_KEY: undefined };
    const r = await runSelfChecks(env, fakeFetch());
    const d = (n: string) => r.results.find((x) => x.name === n)?.detail;
    expect(d("CRON_SECRET format")).toBe("malformed");
    expect(d("OWNER_EMAIL format")).toBe("malformed");
    expect(d("PII_HASH_KEY format")).toBe("missing");
  });
  it("email format: missing", async () => {
    const r = await runSelfChecks({ ...PROD, OWNER_RECOVERY_EMAIL: undefined }, fakeFetch());
    expect(r.results.find((x) => x.name === "OWNER_RECOVERY_EMAIL format")?.detail).toBe("missing");
  });
  it("WORKER_HMAC_SECRET present but malformed fails (not pending)", async () => {
    const r = await workerHmac({ WORKER_HMAC_SECRET: "x" }, f);
    expect(r).toMatchObject({ ok: false, detail: "malformed" });
    expect(r.pending).toBeUndefined();
  });
  it("RESEND_API_KEY format only, no network", async () => {
    const net = fakeFetch();
    expect((await resendKey({ RESEND_API_KEY: "re_x" }, net)).ok).toBe(true);
    expect((await resendKey({ RESEND_API_KEY: "sk_x" }, net)).ok).toBe(false);
    expect((await resendKey({}, net)).detail).toBe("missing");
    expect(net.calls).toEqual([]);
  });
  it("Turso: pass, missing, malformed, HTTP, shape, statement error, mismatch", async () => {
    const e = { TURSO_MAIN_URL: "libsql://h.test", TURSO_MAIN_TOKEN: "t" };
    const body = (r: unknown) => () => res(200, r);
    const five = (types: string[]) => ({ results: types.map((type) => ({ type })) });
    const d = async (over: Record<string, () => Response>) =>
      (await tursoMain(e, fakeFetch(over))).detail;
    expect((await tursoMain(e, fakeFetch())).ok).toBe(true);
    expect((await tursoMain({}, f)).detail).toBe("missing");
    expect((await tursoMain({ ...e, TURSO_MAIN_URL: "ftp://x" }, f)).detail).toBe("malformed");
    expect(await d({ "https://h.test": () => res(401) })).toBe("HTTP 401");
    expect(await d({ "https://h.test": body({ results: [] }) })).toBe("unexpected response");
    expect(await d({ "https://h.test": body(five(["ok", "ok", "ok", "error", "ok"])) })).toBe(
      "statement error",
    );
    expect(await d({ "https://h.test": body(five(["ok", "ok", "ok", "ok", "ok"])) })).toBe(
      "select mismatch",
    );
  });
  it("Turso auth DB uses the auth variables", async () => {
    const net = fakeFetch();
    const r = await tursoAuth({ TURSO_AUTH_URL: "libsql://auth.test", TURSO_AUTH_TOKEN: "t" }, net);
    expect(r).toMatchObject({ name: "Turso auth DB round-trip", ok: true });
    expect(net.calls[0]).toBe("https://auth.test/v2/pipeline");
  });
  it("Google OAuth: invalid_grant passes, invalid_client fails, others fail", async () => {
    const g = (r: () => Response) =>
      googleOAuth(PROD, fakeFetch({ "https://oauth2.googleapis.com": r }));
    expect(await g(() => res(400, { error: "invalid_grant" }))).toMatchObject({
      ok: true,
      detail: "client credentials accepted",
    });
    expect(await g(() => res(401, { error: "invalid_client" }))).toMatchObject({
      ok: false,
      detail: "client rejected",
    });
    expect((await g(() => res(400, { error: "invalid_client" }))).detail).toBe("client rejected");
    expect((await g(() => res(500, {}))).detail).toBe("unexpected 500");
    const nonJson = () =>
      ({ status: 400, json: () => Promise.reject(new Error("x")) }) as unknown as Response;
    expect((await g(nonJson)).detail).toBe("unexpected 400");
  });
  it("Google OAuth request shape and config errors", async () => {
    let init: RequestInit | undefined;
    const net = (async (_u: string, i?: RequestInit) => {
      init = i;
      return res(400, { error: "invalid_grant" });
    }) as unknown as typeof fetch;
    await googleOAuth({ ...PROD, APP_BASE_URL: "https://x.vercel.app/" }, net);
    const p = new URLSearchParams(init?.body as string);
    expect(p.get("grant_type")).toBe("authorization_code");
    expect(p.get("redirect_uri")).toBe("https://x.vercel.app/api/auth/callback/google");
    expect(p.get("client_id")).toBe(PROD.AUTH_GOOGLE_ID);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect((await googleOAuth({}, f)).detail).toBe("missing");
    expect((await googleOAuth({ ...PROD, AUTH_GOOGLE_ID: "x" }, f)).detail).toBe("malformed id");
    expect((await googleOAuth({ ...PROD, APP_BASE_URL: undefined }, f)).detail).toBe(
      "APP_BASE_URL missing",
    );
  });
  it("GitHub and LLM key checks: pass, HTTP failure, missing", async () => {
    const bad = fakeFetch({ "https://": () => res(403) });
    const cases = [
      [githubRead, { GITHUB_READ_TOKEN: "t" }],
      [googleAiKey, { GOOGLE_AI_API_KEY: "t" }],
      [groqKey, { GROQ_API_KEY: "t" }],
      [openRouterKey, { OPENROUTER_API_KEY: "t" }],
    ] as const;
    for (const [chk, env] of cases) {
      expect((await chk(env, fakeFetch())).ok).toBe(true);
      expect((await chk(env, bad)).detail).toBe("HTTP 403");
      expect((await chk({}, f)).detail).toBe("missing");
    }
  });
});
