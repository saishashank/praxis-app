// INFRA T7 (REQ\infra\INFRA_REQUIREMENT.md §10): smoke test of a running web, used by the pre-deploy check
// (scripts/selfhost/predeploy.mjs). Zero dependencies: node builtins and fetch only, because it is mounted
// into the web image under test and run there on the check network (`node smoke.mjs http://web:3000`).
//   node smoke.mjs <base-url>
// Checks:
//   1. /api/health answers 200
//   2. the sign-in page renders (200, HTML)
//   3. Home (/), Picks (/picks), Market (/market):
//        - with SMOKE_SESSION_COOKIE ("name=value", a seeded smoke session): each answers 200
//        - without it (the default: the check stack holds no session secret): each must send an anonymous
//          visitor to the sign-in page (redirect to /signin) or answer 401, which proves the app, its
//          routing and the auth gate are alive. The signed-in render of those three pages is then NOT
//          proven by this check (documented gap, INFRA T7).
// Output: one PASS or FAIL line per check with a short fixed detail. Never a URL, a cookie or a page body.
// Exit 0 = all pass, 1 = a check failed, 2 = usage.
import { fileURLToPath } from "node:url";

const TIMEOUT_MS = 20_000;
export const PAGES = [
  ["Home", "/"],
  ["Picks", "/picks"],
  ["Market", "/market"],
];
const COOKIE_PAIR = /^(?:__Secure-)?authjs\.session-token=[\w.%~+/=-]+$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(fetchImpl, base, path, headers = {}) {
  return fetchImpl(`${base}${path}`, {
    redirect: "manual",
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/**
 * @param {string} baseUrl e.g. http://web:3000
 * @param {{ cookie?: string, fetchImpl?: typeof fetch, healthWaitMs?: number, sleepImpl?: (ms: number) => Promise<unknown> }} [o]
 * @returns {Promise<{ ok: boolean, checks: { name: string, ok: boolean, detail: string }[] }>}
 */
export async function runSmoke(baseUrl, o = {}) {
  const fetchImpl = o.fetchImpl ?? fetch;
  const nap = o.sleepImpl ?? sleep;
  const base = String(baseUrl).replace(/\/+$/, "");
  const cookie = (o.cookie ?? "").trim();
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  const attempt = async (name, f) => {
    try {
      const [ok, detail] = await f();
      add(name, ok, detail);
    } catch (e) {
      add(name, false, `request failed: ${e && typeof e.name === "string" ? e.name : "Error"}`);
    }
  };

  // 1. health, with a short wait: the container may have just passed its own healthcheck.
  const deadline = Date.now() + (o.healthWaitMs ?? 60_000);
  let health = [false, "no answer"];
  for (;;) {
    try {
      const res = await get(fetchImpl, base, "/api/health");
      health = [res.status === 200, `HTTP ${res.status}`];
    } catch (e) {
      health = [false, `request failed: ${e && typeof e.name === "string" ? e.name : "Error"}`];
    }
    if (health[0] || Date.now() >= deadline) break;
    await nap(2000);
  }
  add("/api/health", health[0], health[1]);

  // 2. the sign-in page
  await attempt("sign-in page", async () => {
    const res = await get(fetchImpl, base, "/signin");
    const type = res.headers.get("content-type") ?? "";
    await res.arrayBuffer();
    return [res.status === 200 && /text\/html/i.test(type), `HTTP ${res.status}`];
  });

  // 3. Home, Picks, Market
  if (cookie !== "" && !COOKIE_PAIR.test(cookie)) {
    add("session cookie", false, "unexpected shape");
  } else {
    for (const [label, path] of PAGES) {
      await attempt(`${label} (${cookie ? "signed in" : "anonymous gate"})`, async () => {
        const res = await get(fetchImpl, base, path, cookie ? { Cookie: cookie } : {});
        const loc = res.headers.get("location") ?? "";
        await res.arrayBuffer();
        if (cookie) return [res.status === 200, `HTTP ${res.status}`];
        const toSignin = res.status >= 300 && res.status < 400 && /\/signin(\?|$)/.test(loc);
        return [toSignin || res.status === 401, `HTTP ${res.status}`];
      });
    }
  }
  return { ok: checks.every((c) => c.ok), checks };
}

export async function main(argv, env = process.env, out = (s) => console.log(s)) {
  const base = argv[0] ?? "";
  if (!/^https?:\/\/[^\s/]+\/?$/.test(base)) {
    out("usage: smoke.mjs <base-url>");
    return 2;
  }
  const r = await runSmoke(base, { cookie: env.SMOKE_SESSION_COOKIE });
  for (const c of r.checks) out(`smoke: ${c.ok ? "PASS" : "FAIL"} ${c.name}: ${c.detail}`);
  if (!env.SMOKE_SESSION_COOKIE) {
    out(
      "smoke: note: no SMOKE_SESSION_COOKIE, signed-in Home, Picks and Market renders not proven",
    );
  }
  out(`smoke: ${r.ok ? "PASS" : "FAIL"}`);
  return r.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
