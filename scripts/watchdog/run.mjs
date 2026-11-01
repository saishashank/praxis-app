// YAML watchdog (M5 T12, docs/M5_design.md 4.8, D-096 decisions 11, 12, 42; PLT-019, PLT-074,
// NFR-006, AT-20). Runs from .github/workflows/watchdog.yml (workflow_dispatch only) on the
// approved commit in the `production` environment.
//   env: WATCHDOG_SLOT (2040 | 2150 | manual, default manual), WATCHDOG_DELIBERATE_FAILURE (1),
//        APP_BASE_URL, ACTIONS_HMAC_SECRET, TURSO_MAIN_URL, TURSO_MAIN_TOKEN, RESEND_API_KEY,
//        OWNER_EMAIL, PII_HASH_KEY, EMAIL_PROVIDER (set by the workflow), PRAXIS_ENV.
// Steps: (1) deliberate-failure mode (Owner test of GitHub's failure email) exits 1 at once;
// (2) POST the signed evening-review route (idempotent: sends or reports already sent);
// (3) route unreachable/not ok -> read the database; if `review:<d>` is not sent, send the minimal
// review directly (same email key, so never a second email); (4) Worker and review checks, a
// problem -> one incident email and exit 1; at 21:50 also exit 1 while an incident opened today is
// open; at 21:50 also a heartbeat-presence check (R3-I3, D-818: no finished evening heartbeat of last night and
// no finished morning heartbeat of today -> evening_heartbeat_missing); (5) database unreachable -> one `dbdown:<d>:<slot>` email, exit 1.
// Output is statuses only: no URL, secret, address or body is ever printed.
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { sign } from "../smoke/sign.mjs";

const TIMEOUT_MS = 60000;
const SLOTS = ["2040", "2150", "manual"];
const has = (v) => typeof v === "string" && v.trim() !== "";

/** Calls the signed route. Returns "ok" (200 with ok:true) or a short failure reason. */
export async function callRoute(env, fetchImpl, d, slot, nowMs) {
  if (!has(env.APP_BASE_URL) || !has(env.ACTIONS_HMAC_SECRET)) return "not configured";
  const body = JSON.stringify({ purpose: "evening-review", date: d, source: "watchdog", slot });
  const headers = {
    "Content-Type": "application/json",
    ...sign(
      env.ACTIONS_HMAC_SECRET,
      body,
      Math.floor(nowMs / 1000),
      randomBytes(16).toString("hex"),
    ),
  };
  let res;
  try {
    res = await fetchImpl(`${env.APP_BASE_URL.replace(/\/+$/, "")}/api/internal/evening-review`, {
      method: "POST",
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    return `request failed: ${e && typeof e.name === "string" ? e.name : "Error"}`;
  }
  if (res.status !== 200) return `HTTP ${res.status}`;
  try {
    const data = await res.json();
    return data && data.ok === true ? "ok" : "unexpected response";
  } catch {
    return "unexpected response";
  }
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {{ fetchImpl?: typeof fetch, out?: (s: string) => void, now?: () => Date,
 *   lib?: any, db?: any, provider?: any }} deps
 * @returns {Promise<number>} exit code
 */
export async function run(env, deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const now = deps.now ?? (() => new Date());
  const slot = SLOTS.includes(env.WATCHDOG_SLOT ?? "") ? env.WATCHDOG_SLOT : "manual";

  if (env.WATCHDOG_DELIBERATE_FAILURE === "1") {
    out(`watchdog ${slot}: DELIBERATE FAILURE (Owner test of the failure email); nothing else ran`);
    return 1;
  }

  const lib = deps.lib ?? (await (await import("./lib.mjs")).loadWatchdogLib());
  const d = lib.melbourneDate(now());
  const provider = deps.provider;

  // Step 2: the route.
  const routeResult = await callRoute(env, deps.fetchImpl ?? fetch, d, slot, now().getTime());
  const routeOk = routeResult === "ok";
  out(`watchdog ${slot} ${d}: evening-review route ${routeOk ? "ok" : `NOT ok (${routeResult})`}`);

  async function dbDown() {
    const r = await lib.sendDbDown(env, slot, now(), provider);
    out(`watchdog ${slot} ${d}: DATABASE UNREACHABLE; database-down email ${r}; failing the run`);
    return 1;
  }

  async function withDb(db) {
    const ctx = { db, env, now, provider };
    let failed = !routeOk;
    const problems = await lib.runChecks(db, d, slot);

    // Step 3: the direct minimal review when the route did not deliver.
    let final = problems;
    if (!routeOk) {
      const status = await lib.reviewStatus(db, d);
      if (status === "sent") {
        out(`watchdog ${slot} ${d}: review already sent (route down but not needed)`);
      } else {
        const reason =
          slot === "2150"
            ? "The email route was unreachable at 21:50."
            : "The email route was unreachable at 20:40.";
        const r = await lib.sendFallbackReview(ctx, d, reason, problems);
        out(`watchdog ${slot} ${d}: minimal review ${r.status}`);
        // Re-run the checks so a review the fallback just sent is not reported missing.
        final = await lib.runChecks(db, d, slot);
      }
    }

    // Step 4: a problem sends one incident email and fails the run on purpose.
    for (const p of final) {
      failed = true;
      const r = await lib.sendProblemEmail(ctx, d, slot, p, now());
      out(`watchdog ${slot} ${d}: PROBLEM ${p.kind}; incident email ${r.status}`);
    }
    if (!final.length) out(`watchdog ${slot} ${d}: checks ok`);
    if (failed) out(`watchdog ${slot} ${d}: failing the run on purpose (GitHub failure email)`);
    return failed ? 1 : 0;
  }

  let db = deps.db;
  let ownsDb = false;
  if (!db) {
    try {
      db = lib.openDb(env);
      ownsDb = true;
    } catch {
      db = null;
    }
  }
  try {
    if (!db || !(await lib.probeDb(db))) return await dbDown();
    try {
      return await withDb(db);
    } catch {
      // A database error mid-run counts as "unreachable" (NFR-006 l.15).
      return await dbDown();
    }
  } finally {
    if (ownsDb) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await run(process.env));
}
