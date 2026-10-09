// Vercel-side self-check (SEC-101, SEC-017). Each check resolves to { name, ok, detail }.
// `detail` is a short safe string. NEVER put a secret, email, hostname, URL or response body
// into `detail`. Free list/verify calls only (PRD-007); no email is sent here.
import { randomBytes } from "node:crypto";
import { CHECK_TIMEOUT_MS, CODE_REPO } from "./config";

export type Env = Record<string, string | undefined>;
export type CheckResult = { name: string; ok: boolean; detail: string; pending?: boolean };
export type Check = (env: Env, fetchImpl: typeof fetch) => Promise<CheckResult>;

const result = (name: string, ok: boolean, detail: string): CheckResult => ({ name, ok, detail });
const has = (v: string | undefined): v is string => typeof v === "string" && v.trim() !== "";
const http = (f: typeof fetch, url: string, init: RequestInit = {}) =>
  f(url, { ...init, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });

// Any exception becomes detail = error name only.
async function safe(name: string, body: () => Promise<CheckResult>): Promise<CheckResult> {
  try {
    return await body();
  } catch (e) {
    return result(name, false, e instanceof Error && e.name ? e.name : "Error");
  }
}

// Environment derivation. PRAXIS_ENV is not set on Vercel and we add no new Owner step, so:
//   BACKUP_PUBLIC_KEY present            -> production (only production holds it)
//   else TEST_IDENTITY_SECRET present    -> staging (only staging holds it)
//   else                                 -> unknown (reported; the caller fails the run)
// Production holding TEST_IDENTITY_SECRET is then caught by the SEC-109 check below. The caller
// also compares this value to its own SMOKE_ENV, which catches calling the wrong deployment.
export type DerivedEnv = "production" | "staging" | "unknown";
export function deriveEnv(env: Env): DerivedEnv {
  if (has(env.BACKUP_PUBLIC_KEY)) return "production";
  if (has(env.TEST_IDENTITY_SECRET)) return "staging";
  return "unknown";
}

const HEX64 = /^[0-9a-f]{64}$/;
const BASE64_32 = /^[A-Za-z0-9+/_-]{32,}={0,2}$/;

function hexCheck(name: string, value: string | undefined): CheckResult {
  const label = `${name} format`;
  if (!has(value)) return result(label, false, "missing");
  return HEX64.test(value)
    ? result(label, true, "present, 64 hex")
    : result(label, false, "malformed");
}

function emailCheck(name: string, value: string | undefined): CheckResult {
  const label = `${name} format`;
  if (!has(value)) return result(label, false, "missing");
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
    ? result(label, true, "present, looks like an email")
    : result(label, false, "malformed");
}

export const authSecret: Check = async (env) => {
  const name = "AUTH_SECRET format";
  const v = env.AUTH_SECRET;
  if (!has(v)) return result(name, false, "missing");
  if (HEX64.test(v)) return result(name, true, "present, 64 hex");
  if (BASE64_32.test(v)) return result(name, true, "present, base64 of at least 32 chars");
  return result(name, false, "malformed");
};

export const appBaseUrl: Check = async (env) => {
  const name = "APP_BASE_URL format";
  const v = env.APP_BASE_URL;
  if (!has(v)) return result(name, false, "missing");
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return result(name, false, "malformed");
  }
  const ok =
    u.protocol === "https:" &&
    u.pathname === "/" &&
    u.search === "" &&
    u.hash === "" &&
    u.username === "" &&
    u.password === "" &&
    u.port === "" &&
    u.hostname.endsWith(".vercel.app");
  return ok
    ? result(name, true, "https, no path, vercel.app host")
    : result(name, false, "malformed");
};

export const backupPublicKey: Check = async (env) => {
  const name = "BACKUP_PUBLIC_KEY format";
  if (!has(env.BACKUP_PUBLIC_KEY)) return result(name, false, "missing");
  return /^age1[02-9ac-hj-np-z]{58}$/.test(env.BACKUP_PUBLIC_KEY)
    ? result(name, true, "present, well-formed age key")
    : result(name, false, "malformed");
};

// SEC-109: the test-identity secret must exist in staging only.
export const testIdentityAbsent: Check = async (env) =>
  has(env.TEST_IDENTITY_SECRET)
    ? result("TEST_IDENTITY_SECRET absent", false, "present in production")
    : result("TEST_IDENTITY_SECRET absent", true, "absent, as required");

// Turso HTTP pipeline: https://docs.turso.tech/sdk/http/reference (same as smoke stage 1).
async function tursoRoundTrip(
  name: string,
  rawUrl: string | undefined,
  token: string | undefined,
  f: typeof fetch,
): Promise<CheckResult> {
  return safe(name, async () => {
    if (!has(rawUrl) || !has(token)) return result(name, false, "missing");
    const m = /^(?:libsql|https):\/\/([^/\s]+)\/?$/.exec(rawUrl.trim());
    if (!m) return result(name, false, "malformed");
    const table = `selfcheck_${randomBytes(8).toString("hex")}`;
    const nonce = randomBytes(16).toString("hex");
    const sql = (s: string, args?: { type: string; value: string }[]) => ({
      type: "execute",
      stmt: args ? { sql: s, args } : { sql: s },
    });
    const requests = [
      sql(`CREATE TABLE IF NOT EXISTS ${table} (id INTEGER PRIMARY KEY, v TEXT NOT NULL)`),
      sql(`INSERT INTO ${table} (v) VALUES (?)`, [{ type: "text", value: nonce }]),
      sql(`SELECT v FROM ${table}`),
      sql(`DROP TABLE ${table}`),
      { type: "close" },
    ];
    const res = await http(f, `https://${m[1]}/v2/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requests }),
    });
    if (res.status !== 200) return result(name, false, `HTTP ${res.status}`);
    const json = (await res.json()) as {
      results?: { type?: string; response?: { result?: { rows?: { value?: string }[][] } } }[];
    };
    const results = json?.results;
    if (!Array.isArray(results) || results.length !== requests.length) {
      return result(name, false, "unexpected response");
    }
    if (!results.every((r) => r && r.type === "ok")) return result(name, false, "statement error");
    const got = results[2]?.response?.result?.rows?.[0]?.[0]?.value;
    if (got !== nonce) return result(name, false, "select mismatch");
    return result(name, true, "create/insert/select/drop ok");
  });
}

export const tursoMain: Check = (env, f) =>
  tursoRoundTrip("Turso main DB round-trip", env.TURSO_MAIN_URL, env.TURSO_MAIN_TOKEN, f);
export const tursoAuth: Check = (env, f) =>
  tursoRoundTrip("Turso auth DB round-trip", env.TURSO_AUTH_URL, env.TURSO_AUTH_TOKEN, f);

// Google OAuth client credentials, proven without a user: exchange a deliberately invalid
// authorization code at the token endpoint. Valid client id+secret -> HTTP 400 "invalid_grant";
// wrong client -> HTTP 401 "invalid_client".
// Doc: https://developers.google.com/identity/protocols/oauth2/web-server#exchange-authorization-code
// UNVERIFIED against the live service (no calls allowed while building); confirm on first run.
export const googleOAuth: Check = async (env, f) => {
  const name = "Google OAuth client";
  return safe(name, async () => {
    const id = env.AUTH_GOOGLE_ID;
    const secret = env.AUTH_GOOGLE_SECRET;
    if (!has(id) || !has(secret)) return result(name, false, "missing");
    if (!id.endsWith(".apps.googleusercontent.com")) return result(name, false, "malformed id");
    if (!has(env.APP_BASE_URL)) return result(name, false, "APP_BASE_URL missing");
    const res = await http(f, "https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "praxis-selfcheck-invalid",
        redirect_uri: `${env.APP_BASE_URL.replace(/\/$/, "")}/api/auth/callback/google`,
        client_id: id,
        client_secret: secret,
      }).toString(),
    });
    let error: unknown;
    try {
      error = ((await res.json()) as { error?: unknown })?.error;
    } catch {
      error = undefined;
    }
    if (res.status === 400 && error === "invalid_grant") {
      return result(name, true, "client credentials accepted");
    }
    if (res.status === 401 || error === "invalid_client") {
      return result(name, false, "client rejected");
    }
    return result(name, false, `unexpected ${res.status}`);
  });
};

// Format only: sending is proven by the stage 1 [TEST] email. No network call.
export const resendKey: Check = async (env) => {
  const name = "RESEND_API_KEY format";
  if (!has(env.RESEND_API_KEY)) return result(name, false, "missing");
  return env.RESEND_API_KEY.startsWith("re_")
    ? result(name, true, "present; sending proven by stage 1 [TEST] email")
    : result(name, false, "malformed");
};

export const githubRead: Check = async (env, f) => {
  const name = "GITHUB_READ_TOKEN";
  return safe(name, async () => {
    if (!has(env.GITHUB_READ_TOKEN)) return result(name, false, "missing");
    const res = await http(
      f,
      `https://api.github.com/repos/${CODE_REPO}/deployments?environment=deploy-production&per_page=1`,
      {
        headers: {
          Authorization: `Bearer ${env.GITHUB_READ_TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "praxis-selfcheck",
        },
      },
    );
    return res.status === 200
      ? result(name, true, "HTTP 200")
      : result(name, false, `HTTP ${res.status}`);
  });
};

// Free list/identity endpoints only; never a generation call (same as stage 1).
function llmKey(
  name: string,
  pick: (env: Env) => string | undefined,
  url: string,
  headers: (key: string) => Record<string, string>,
): Check {
  return (env, f) =>
    safe(name, async () => {
      const key = pick(env);
      if (!has(key)) return result(name, false, "missing");
      const res = await http(f, url, { headers: headers(key) });
      return res.status === 200
        ? result(name, true, "HTTP 200")
        : result(name, false, `HTTP ${res.status}`);
    });
}
export const googleAiKey = llmKey(
  "Google AI key",
  (e) => e.GOOGLE_AI_API_KEY,
  "https://generativelanguage.googleapis.com/v1beta/models",
  (k) => ({ "x-goog-api-key": k }),
);
export const groqKey = llmKey(
  "Groq key",
  (e) => e.GROQ_API_KEY,
  "https://api.groq.com/openai/v1/models",
  (k) => ({ Authorization: `Bearer ${k}` }),
);
export const openRouterKey = llmKey(
  "OpenRouter key",
  (e) => e.OPENROUTER_API_KEY,
  "https://openrouter.ai/api/v1/key",
  (k) => ({ Authorization: `Bearer ${k}` }),
);

// c2: created in the M1 Worker step (D-018); absent is "pending", not a failure.
export const workerHmac: Check = async (env) => {
  if (!has(env.WORKER_HMAC_SECRET)) {
    return {
      ...result(
        "WORKER_HMAC_SECRET format",
        false,
        "not set yet (created in the M1 Worker step, D-018)",
      ),
      pending: true,
    };
  }
  return hexCheck("WORKER_HMAC_SECRET", env.WORKER_HMAC_SECRET);
};

const hex =
  (name: string): Check =>
  async (e) =>
    hexCheck(name, e[name]);
const email =
  (name: string): Check =>
  async (e) =>
    emailCheck(name, e[name]);

const COMMON: Check[] = [
  authSecret,
  hex("CRON_SECRET"),
  hex("PII_HASH_KEY"),
  appBaseUrl,
  email("OWNER_EMAIL"),
  tursoMain,
  tursoAuth,
  googleOAuth,
  resendKey,
  workerHmac,
];

export function checksFor(env: DerivedEnv): Check[] {
  if (env === "production") {
    return [
      ...COMMON,
      email("OWNER_RECOVERY_EMAIL"),
      backupPublicKey,
      testIdentityAbsent,
      githubRead,
      googleAiKey,
      groqKey,
      openRouterKey,
    ];
  }
  if (env === "staging") return [...COMMON, hex("TEST_IDENTITY_SECRET")];
  return [
    async () => result("Environment detection", false, "cannot tell staging from production"),
  ];
}

export type SelfCheckReport = {
  env: DerivedEnv;
  commit: string | null;
  results: CheckResult[];
  passed: number;
  failed: number;
  pending: number;
};

export async function runSelfChecks(env: Env, fetchImpl: typeof fetch): Promise<SelfCheckReport> {
  const derived = deriveEnv(env);
  const settled = await Promise.allSettled(checksFor(derived).map((c) => c(env, fetchImpl)));
  const results: CheckResult[] = settled.map((s) =>
    s.status === "fulfilled" ? s.value : result("check", false, "Error"),
  );
  return {
    env: derived,
    commit: env.APP_COMMIT ?? null,
    results,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok && !r.pending).length,
    pending: results.filter((r) => r.pending).length,
  };
}
