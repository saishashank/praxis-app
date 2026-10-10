// Worker credential self-check (SEC-101 stage 2, Worker part). HIGH-RISK: secrets, a signed
// machine call and the Worker CPU budget. Opus reviews every line.
//
// Spec text this file implements (verbatim excerpts; file:line in the private spec v1):
//  - 10_nfr_testing.md:107 SEC-101: "for the cron-only Worker, by a **self-check on a cron tick**
//    after each deploy and daily; each reports pass/fail per secret it holds (never the value) to
//    a run record shown on System Health."
//  - 10_nfr_testing.md:85  SEC-017 (b):   "| (b) Worker dispatch token | fine-grained, code repo only:
//    actions r/w; production Worker dispatches `ref: release` | ≤ 1 y | production Worker secret |"
//  - 10_nfr_testing.md:86  SEC-017 (b-s): "| (b-s) staging Worker dispatch token | separate value, same
//    scope; dispatches `ref: main` in test windows only | ≤ 1 y | staging Worker secret |"
//  - 10_nfr_testing.md:88  SEC-017 (c2):  "| (c2) Worker→Vercel HMAC | random 32 bytes, **separate
//    value per environment** | yearly | Worker + Vercel env of the same environment |"
//  - 10_nfr_testing.md:91  SEC-017 (d):   "| (d) Turso main-DB tokens | one per environment per
//    caller; read-only where the caller only reads | yearly | Vercel env, GitHub environment
//    `production`/`staging`, Worker |"
//  - 12_build_plan.md:42   BLD-012: "The Worker (cron-only, no public `workers.dev` route) is first
//    deployed from CI in M1 as a skeleton (heartbeat record only); its master-clock, rate-token and
//    slot-schedule functions arrive in M2; the Owner never runs `wrangler`."
//  - 10_nfr_testing.md:172 NFR-040: "a staging Worker whose cron is enabled only during test
//    windows"
//  - 02_platform_hosting_auth.md:81 PLT-070 (CPU rule): "10 ms CPU per invocation (network wait
//    excluded), 5 cron triggers per account, 50 subrequests per invocation, 100,000 requests/day."
//  - 02_platform_hosting_auth.md:82 PLT-071: "The Worker's per-minute cron is the master clock: at
//    configured local times it triggers GitHub Actions via `workflow_dispatch` **with `ref:
//    release`** (fine-grained token stored as a Worker secret)."
//
// Notes on how the rules apply here:
//  - BLD-012: M1 is heartbeat only. This self-check never dispatches anything: the dispatch token
//    is proven with one read-only GET (the dispatch itself is M2, PLT-071).
//  - NFR-040: the staging cron stays empty, so on staging this runs only in test windows.
//  - PLT-070 CPU: the only work besides awaiting I/O is two JSON parses and one HMAC, far below
//    10 ms. At most 4 subrequests per tick (limit 50): decision query, Turso check, GitHub check,
//    report POST.
//  - Safe output: results carry only a short fixed detail ("missing", "HTTP 401", an error NAME,
//    ...). No secret, URL, host, response body or error message is returned, sent or logged.
//    The only log lines are "selfcheck: n/m passed" and "selfcheck: report delivered|not delivered".
//  - Signing scheme = src/lib/security/hmac.ts (a known-answer test shares the vector with
//    scripts/smoke/sign.mjs). Dependency-free: WebCrypto + fetch only.

export interface SelfCheckEnv {
  PRAXIS_ENV: string;
  /** Plain vars (wrangler.jsonc / --var). */
  APP_BASE_URL?: string;
  BUILD_COMMIT?: string;
  /** Worker secrets (D-055). Any of them may be absent: the check then reports "missing". */
  GITHUB_DISPATCH_TOKEN?: string;
  WORKER_HMAC_SECRET?: string;
  TURSO_MAIN_URL?: string;
  TURSO_MAIN_TOKEN?: string;
}

export type CheckResult = { name: string; ok: boolean; detail: string };

export const WORKER_SELFCHECK_JOB = "worker-selfcheck";
export const DAILY_HOUR_UTC = 2;
export const DAILY_MINUTE_UTC = 15;
/** After any run of this commit (pass or fail) wait this long before trying again. */
export const RETRY_AFTER_MS = 15 * 60_000;
export const CHECK_TIMEOUT_MS = 10_000;
const CODE_REPO = "saishashank/praxis-app";
const COMMIT_RE = /^[0-9a-f]{40}$/;
const TURSO_URL_RE = /^(?:libsql|https):\/\/([^/\s]+)\/?$/;
const MAX_NAME = 60;
const MAX_DETAIL = 120;

type Fetch = typeof fetch;
export type Deps = { fetch: Fetch; nowMs: () => number };

const has = (v: string | undefined): v is string => typeof v === "string" && v.trim() !== "";
const result = (name: string, ok: boolean, detail: string): CheckResult => ({
  name: name.slice(0, MAX_NAME),
  ok,
  detail: detail.slice(0, MAX_DETAIL),
});
const timed = (f: Fetch, url: string, init: RequestInit = {}) =>
  f(url, { ...init, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });

function randomHex(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function tursoPipelineUrl(rawUrl: string | undefined): string | null {
  const m = TURSO_URL_RE.exec((rawUrl ?? "").trim());
  return m ? `https://${m[1]}/v2/pipeline` : null;
}

/** Any exception becomes detail = the error NAME only (never the message). */
async function safe(name: string, body: () => Promise<CheckResult>): Promise<CheckResult> {
  try {
    return await body();
  } catch (e) {
    return result(name, false, e instanceof Error && e.name ? e.name : "Error");
  }
}

// ---- signing (twin of src/lib/security/hmac.ts and scripts/smoke/sign.mjs) -------------------

const hexOf = (buf: ArrayBuffer) =>
  Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, "0")).join("");

export async function signHeaders(
  secret: string,
  body: string,
  nowSec: number,
  nonce: string,
): Promise<Record<string, string>> {
  const timestamp = String(nowSec);
  const enc = new TextEncoder();
  // key = the secret string as UTF-8 (not hex-decoded), exactly like createHmac("sha256", secret).
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${timestamp}.${nonce}.${body}`));
  return {
    "X-Praxis-Timestamp": timestamp,
    "X-Praxis-Nonce": nonce,
    "X-Praxis-Signature": hexOf(sig),
  };
}

// ---- when to run -----------------------------------------------------------------------------

export function isDailyTick(scheduledTime: number): boolean {
  const d = new Date(scheduledTime);
  return d.getUTCHours() === DAILY_HOUR_UTC && d.getUTCMinutes() === DAILY_MINUTE_UTC;
}

/**
 * Run at 02:15 UTC daily; otherwise only when this build commit has no recorded success (and no
 * run at all in the last 15 minutes, so a failing check set does not repeat every minute).
 * Database trouble or missing database secrets -> run, so the failure itself is reported.
 */
export async function shouldRun(
  env: SelfCheckEnv,
  scheduledTime: number,
  nowMs: number,
  f: Fetch,
): Promise<boolean> {
  if (isDailyTick(scheduledTime)) return true;
  if (!has(env.BUILD_COMMIT) || !COMMIT_RE.test(env.BUILD_COMMIT)) return false;
  const url = tursoPipelineUrl(env.TURSO_MAIN_URL);
  if (url === null || !has(env.TURSO_MAIN_TOKEN)) return true;
  try {
    const cutoff = new Date(nowMs - RETRY_AFTER_MS).toISOString();
    const res = await timed(f, url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.TURSO_MAIN_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requests: [
          {
            type: "execute",
            stmt: {
              sql: `SELECT 1 FROM run_record WHERE job='${WORKER_SELFCHECK_JOB}' AND commit_sha=? AND (status='success' OR started_at>?) LIMIT 1`,
              args: [
                { type: "text", value: env.BUILD_COMMIT },
                { type: "text", value: cutoff },
              ],
            },
          },
          { type: "close" },
        ],
      }),
    });
    if (res.status !== 200) return true;
    const json = (await res.json()) as {
      results?: { type?: string; response?: { result?: { rows?: unknown[] } } }[];
    };
    const first = json?.results?.[0];
    if (first?.type !== "ok" || !Array.isArray(first.response?.result?.rows)) return true;
    return first.response.result.rows.length === 0;
  } catch {
    return true;
  }
}

// ---- checks ----------------------------------------------------------------------------------

const TURSO_NAME = "TURSO_MAIN round trip";
const GITHUB_NAME = "GITHUB_DISPATCH_TOKEN";

// Same shape as the Vercel check and the smoke test: temp table create / insert / select / drop.
async function tursoCheck(env: SelfCheckEnv, f: Fetch): Promise<CheckResult> {
  return safe(TURSO_NAME, async () => {
    if (!has(env.TURSO_MAIN_URL) || !has(env.TURSO_MAIN_TOKEN)) {
      return result(TURSO_NAME, false, "missing");
    }
    const url = tursoPipelineUrl(env.TURSO_MAIN_URL);
    if (url === null) return result(TURSO_NAME, false, "malformed");
    const table = `selfcheck_${randomHex(8)}`;
    const value = randomHex(16);
    const requests = [
      {
        type: "execute",
        stmt: {
          sql: `CREATE TABLE IF NOT EXISTS ${table} (id INTEGER PRIMARY KEY, v TEXT NOT NULL)`,
        },
      },
      {
        type: "execute",
        stmt: { sql: `INSERT INTO ${table} (v) VALUES (?)`, args: [{ type: "text", value }] },
      },
      { type: "execute", stmt: { sql: `SELECT v FROM ${table}` } },
      { type: "execute", stmt: { sql: `DROP TABLE ${table}` } },
      { type: "close" },
    ];
    const res = await timed(f, url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.TURSO_MAIN_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ requests }),
    });
    if (res.status !== 200) return result(TURSO_NAME, false, `HTTP ${res.status}`);
    const json = (await res.json()) as {
      results?: { type?: string; response?: { result?: { rows?: { value?: string }[][] } } }[];
    };
    const results = json?.results;
    if (!Array.isArray(results) || results.length !== requests.length) {
      return result(TURSO_NAME, false, "unexpected response");
    }
    if (!results.every((r) => r && r.type === "ok")) {
      return result(TURSO_NAME, false, "statement error");
    }
    if (results[2]?.response?.result?.rows?.[0]?.[0]?.value !== value) {
      return result(TURSO_NAME, false, "select mismatch");
    }
    return result(TURSO_NAME, true, "create/insert/select/drop ok");
  });
}

// Read-only proof of the dispatch token: list workflows (needs Actions read). NEVER dispatches.
async function githubCheck(env: SelfCheckEnv, f: Fetch): Promise<CheckResult> {
  return safe(GITHUB_NAME, async () => {
    if (!has(env.GITHUB_DISPATCH_TOKEN)) return result(GITHUB_NAME, false, "missing");
    const res = await timed(
      f,
      `https://api.github.com/repos/${CODE_REPO}/actions/workflows?per_page=1`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "praxis-sentinel-selfcheck",
        },
      },
    );
    return res.status === 200
      ? result(GITHUB_NAME, true, "HTTP 200")
      : result(GITHUB_NAME, false, `HTTP ${res.status}`);
  });
}

// WORKER_HMAC_SECRET is proven by the signed report itself (the app records that result).
export async function runChecks(env: SelfCheckEnv, f: Fetch): Promise<CheckResult[]> {
  return Promise.all([tursoCheck(env, f), githubCheck(env, f)]);
}

// ---- orchestration ---------------------------------------------------------------------------

function reportUrl(base: string | undefined): string | null {
  if (!has(base)) return null;
  try {
    const u = new URL(base);
    if (u.protocol !== "https:") return null;
    return new URL("/api/internal/worker-report", u.origin).toString();
  } catch {
    return null;
  }
}

async function sendReport(env: SelfCheckEnv, results: CheckResult[], deps: Deps): Promise<boolean> {
  const url = reportUrl(env.APP_BASE_URL);
  if (url === null || !has(env.WORKER_HMAC_SECRET)) return false;
  const body = JSON.stringify({
    purpose: "worker-report",
    env: env.PRAXIS_ENV,
    commit:
      has(env.BUILD_COMMIT) && COMMIT_RE.test(env.BUILD_COMMIT) ? env.BUILD_COMMIT : "unknown",
    results,
  });
  const headers = await signHeaders(
    env.WORKER_HMAC_SECRET,
    body,
    Math.floor(deps.nowMs() / 1000),
    randomHex(16),
  );
  const res = await timed(deps.fetch, url, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body,
    redirect: "manual", // a redirect must never carry the signed request elsewhere
  });
  return res.status === 200;
}

const realDeps = (): Deps => ({ fetch: (i, init) => fetch(i, init), nowMs: () => Date.now() });

/** Never throws: a self-check problem must not disturb the heartbeat or other cron work. */
export async function runSelfCheck(
  env: SelfCheckEnv,
  scheduledTime: number,
  deps: Deps = realDeps(),
): Promise<void> {
  try {
    if (!(await shouldRun(env, scheduledTime, deps.nowMs(), deps.fetch))) return;
    const results = await runChecks(env, deps.fetch);
    const passed = results.filter((r) => r.ok).length;
    console.log(`selfcheck: ${passed}/${results.length} passed`);
    let delivered = false;
    try {
      delivered = await sendReport(env, results, deps);
    } catch {
      delivered = false;
    }
    console.log(`selfcheck: report ${delivered ? "delivered" : "not delivered"}`);
  } catch {
    // Nothing is logged: an exception message could carry a value.
  }
}
