import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error plain .mjs signer without types (the Actions-side twin)
import { sign } from "../../scripts/smoke/sign.mjs";
import worker from "../src/index";
import {
  DAILY_HOUR_UTC,
  DAILY_MINUTE_UTC,
  isDailyTick,
  runChecks,
  runSelfCheck,
  shouldRun,
  signHeaders,
  type SelfCheckEnv,
} from "../src/selfcheck";

const SECRETS = {
  GITHUB_DISPATCH_TOKEN: "ghp_TOPSECRET_dispatch_value",
  WORKER_HMAC_SECRET: "ab".repeat(32),
  TURSO_MAIN_URL: "libsql://praxis-main-secret-host.turso.io",
  TURSO_MAIN_TOKEN: "turso-TOPSECRET-token",
};
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const ENV: SelfCheckEnv = {
  PRAXIS_ENV: "production",
  APP_BASE_URL: "https://praxis-app-ssbn.vercel.app",
  BUILD_COMMIT: COMMIT,
  ...SECRETS,
};
// 2026-10-11 02:15 UTC, and a normal minute.
const DAILY = Date.UTC(2026, 9, 11, 2, 15, 0);
const OTHER = Date.UTC(2026, 9, 11, 2, 16, 0);

type Call = { url: string; method: string; headers: Record<string, string>; body: string };
type Opts = {
  /** Whether the "already recorded?" query returns a row. */
  recorded?: boolean;
  turso?: number | "throw";
  github?: number | "throw";
  app?: number | "throw";
  selectMismatch?: boolean;
};
function fakeFetch(o: Opts = {}) {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ url, method: init?.method ?? "GET", headers, body });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (url.includes("/v2/pipeline")) {
      if (o.turso === "throw") throw new TypeError("net down turso-TOPSECRET-token");
      if (o.turso && o.turso !== 200) return new Response("nope", { status: o.turso });
      const reqs = (
        JSON.parse(body) as { requests: { stmt?: { sql: string; args?: unknown[] } }[] }
      ).requests;
      const first = reqs[0].stmt!.sql;
      if (first.includes("FROM run_record")) {
        const rows = o.recorded ? [[{ type: "integer", value: "1" }]] : [];
        return Response.json({
          results: [
            { type: "ok", response: { type: "execute", result: { rows } } },
            { type: "ok" },
          ],
        });
      }
      const inserted = (reqs[1].stmt!.args![0] as { value: string }).value;
      const got = o.selectMismatch ? "other" : inserted;
      return Response.json({
        results: [
          { type: "ok" },
          { type: "ok" },
          { type: "ok", response: { result: { rows: [[{ type: "text", value: got }]] } } },
          { type: "ok" },
          { type: "ok" },
        ],
      });
    }
    if (url.startsWith("https://api.github.com/")) {
      if (o.github === "throw") throw new Error("boom ghp_TOPSECRET_dispatch_value");
      return new Response("{}", { status: o.github ?? 200 });
    }
    if (url.endsWith("/api/internal/worker-report")) {
      if (o.app === "throw") throw new Error("boom");
      return Response.json({ recorded: true }, { status: o.app ?? 200 });
    }
    throw new Error(`unexpected url ${url}`);
  }) as typeof fetch;
  return { f, calls };
}
const reportCall = (calls: Call[]) => calls.find((c) => c.url.endsWith("/worker-report"));
const sent = (calls: Call[]) => JSON.parse(reportCall(calls)!.body);

afterEach(() => vi.restoreAllMocks());

describe("signature (twin of src/lib/security/hmac.ts and scripts/smoke/sign.mjs)", () => {
  const SECRET = "a".repeat(64);
  const BODY = '{"purpose":"self-check"}';
  const NOW = 1_700_000_000;
  const NONCE = "0123456789abcdef0123456789abcdef";
  // Same literal as tests/security/hmac.test.ts in the app.
  const KNOWN = "d115837af5305a21feb65b671c7f044bb5c564d701b89c5badaf99b27c1747c8";
  it("WebCrypto output equals the literal and sign.mjs", async () => {
    const h = await signHeaders(SECRET, BODY, NOW, NONCE);
    expect(h).toEqual({
      "X-Praxis-Timestamp": String(NOW),
      "X-Praxis-Nonce": NONCE,
      "X-Praxis-Signature": KNOWN,
    });
    expect(h).toEqual(sign(SECRET, BODY, NOW, NONCE));
  });
});

describe("isDailyTick", () => {
  it("is true only at 02:15 UTC", () => {
    expect([DAILY_HOUR_UTC, DAILY_MINUTE_UTC]).toEqual([2, 15]);
    expect(isDailyTick(DAILY)).toBe(true);
    expect(isDailyTick(Date.UTC(2026, 0, 1, 2, 15, 59))).toBe(true);
    expect(isDailyTick(OTHER)).toBe(false);
    expect(isDailyTick(Date.UTC(2026, 9, 11, 3, 15, 0))).toBe(false);
    expect(isDailyTick(Date.UTC(2026, 9, 11, 2, 14, 59))).toBe(false);
  });
});

describe("shouldRun", () => {
  it("runs on the daily tick without asking the database", async () => {
    const { f, calls } = fakeFetch();
    expect(await shouldRun(ENV, DAILY, DAILY, f)).toBe(true);
    expect(calls).toHaveLength(0);
  });
  it("runs on another tick when this commit has no recent record", async () => {
    const { f, calls } = fakeFetch({ recorded: false });
    expect(await shouldRun(ENV, OTHER, OTHER, f)).toBe(true);
    expect(calls).toHaveLength(1);
    const stmt = JSON.parse(calls[0].body).requests[0].stmt;
    expect(stmt.sql).toContain("job='worker-selfcheck'");
    expect(stmt.sql).toContain("commit_sha=?");
    expect(stmt.sql).toContain("LIMIT 1");
    expect(stmt.args[0]).toEqual({ type: "text", value: COMMIT });
    expect(calls[0].url).toBe("https://praxis-main-secret-host.turso.io/v2/pipeline");
    expect(calls[0].method).toBe("POST");
  });
  it("skips when this commit already succeeded (or ran within the last 15 minutes)", async () => {
    const { f, calls } = fakeFetch({ recorded: true });
    expect(await shouldRun(ENV, OTHER, OTHER, f)).toBe(false);
    const args = JSON.parse(calls[0].body).requests[0].stmt.args;
    expect(args[1]).toEqual({ type: "text", value: new Date(OTHER - 15 * 60_000).toISOString() });
  });
  it("without a valid build commit only the daily tick runs", async () => {
    for (const BUILD_COMMIT of [undefined, "", "unknown", "XYZ"]) {
      const { f, calls } = fakeFetch();
      expect(await shouldRun({ ...ENV, BUILD_COMMIT }, OTHER, OTHER, f)).toBe(false);
      expect(calls).toHaveLength(0);
    }
  });
  it("runs (so the failure is reported) when the database is not configured or fails", async () => {
    const a = fakeFetch();
    expect(await shouldRun({ ...ENV, TURSO_MAIN_URL: undefined }, OTHER, OTHER, a.f)).toBe(true);
    expect(await shouldRun({ ...ENV, TURSO_MAIN_TOKEN: "" }, OTHER, OTHER, a.f)).toBe(true);
    expect(await shouldRun({ ...ENV, TURSO_MAIN_URL: "ftp://x" }, OTHER, OTHER, a.f)).toBe(true);
    expect(a.calls).toHaveLength(0);
    for (const turso of [500, "throw"] as const) {
      const b = fakeFetch({ turso });
      expect(await shouldRun(ENV, OTHER, OTHER, b.f)).toBe(true);
    }
  });
});

describe("runChecks", () => {
  it("passes both checks with a healthy network", async () => {
    const { f, calls } = fakeFetch();
    const r = await runChecks(ENV, f);
    expect(r.map((x) => x.ok)).toEqual([true, true]);
    expect(r.map((x) => x.name)).toEqual(["TURSO_MAIN round trip", "GITHUB_DISPATCH_TOKEN"]);
    const sqls = (
      JSON.parse(calls.find((c) => c.url.includes("pipeline"))!.body).requests as {
        stmt?: { sql: string };
      }[]
    ).map((x) => x.stmt?.sql ?? "close");
    expect(sqls[0]).toMatch(/^CREATE TABLE IF NOT EXISTS selfcheck_[0-9a-f]{16} /);
    expect(sqls[1]).toMatch(/^INSERT INTO selfcheck_/);
    expect(sqls[2]).toMatch(/^SELECT v FROM selfcheck_/);
    expect(sqls[3]).toMatch(/^DROP TABLE selfcheck_/);
  });
  it("the dispatch token is only ever used with GET against the workflow list", async () => {
    const { f, calls } = fakeFetch();
    await runChecks(ENV, f);
    const gh = calls.filter((c) => c.url.includes("github.com"));
    expect(gh).toHaveLength(1);
    expect(gh[0].method).toBe("GET");
    expect(gh[0].body).toBe("");
    expect(gh[0].url).toBe(
      "https://api.github.com/repos/saishashank/praxis-app/actions/workflows?per_page=1",
    );
    expect(gh[0].headers.authorization).toBe(`Bearer ${SECRETS.GITHUB_DISPATCH_TOKEN}`);
    expect(gh[0].headers["user-agent"]).toBeTruthy();
    expect(gh[0].headers["x-github-api-version"]).toBeTruthy();
    expect(calls.some((c) => c.url.includes("dispatches"))).toBe(false);
  });
  it("reports each secret as missing when absent, without any network call", async () => {
    const { f, calls } = fakeFetch();
    const r = await runChecks({ PRAXIS_ENV: "staging" }, f);
    expect(r).toEqual([
      { name: "TURSO_MAIN round trip", ok: false, detail: "missing" },
      { name: "GITHUB_DISPATCH_TOKEN", ok: false, detail: "missing" },
    ]);
    expect(calls).toHaveLength(0);
  });
  it("fails with safe details: HTTP status, error name, mismatch", async () => {
    const a = await runChecks(ENV, fakeFetch({ turso: 401, github: 403 }).f);
    expect(a.map((x) => [x.ok, x.detail])).toEqual([
      [false, "HTTP 401"],
      [false, "HTTP 403"],
    ]);
    const b = await runChecks(ENV, fakeFetch({ turso: "throw", github: "throw" }).f);
    expect(b.map((x) => x.detail)).toEqual(["TypeError", "Error"]);
    const c = await runChecks(ENV, fakeFetch({ selectMismatch: true }).f);
    expect(c[0]).toMatchObject({ ok: false, detail: "select mismatch" });
    expect(JSON.stringify([a, b, c])).not.toMatch(/TOPSECRET|secret-host/);
  });
  it("a malformed Turso address fails as malformed", async () => {
    const r = await runChecks({ ...ENV, TURSO_MAIN_URL: "not a url" }, fakeFetch().f);
    expect(r[0]).toMatchObject({ ok: false, detail: "malformed" });
  });
});

describe("runSelfCheck", () => {
  const run = async (env: SelfCheckEnv, t: number, o: Opts = {}) => {
    const net = fakeFetch(o);
    await runSelfCheck(env, t, { fetch: net.f, nowMs: () => t + 5000 });
    return net;
  };

  it("daily tick: checks, then one signed POST with the agreed body", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { calls } = await run(ENV, DAILY);
    const rep = reportCall(calls)!;
    expect(rep.method).toBe("POST");
    expect(rep.url).toBe("https://praxis-app-ssbn.vercel.app/api/internal/worker-report");
    expect(JSON.parse(rep.body)).toEqual({
      purpose: "worker-report",
      env: "production",
      commit: COMMIT,
      results: [
        { name: "TURSO_MAIN round trip", ok: true, detail: "create/insert/select/drop ok" },
        { name: "GITHUB_DISPATCH_TOKEN", ok: true, detail: "HTTP 200" },
      ],
    });
    const ts = Math.floor((DAILY + 5000) / 1000);
    expect(rep.headers["x-praxis-timestamp"]).toBe(String(ts));
    expect(rep.headers["x-praxis-nonce"]).toMatch(/^[0-9a-f]{32}$/);
    expect(rep.headers["x-praxis-signature"]).toBe(
      sign(SECRETS.WORKER_HMAC_SECRET, rep.body, ts, rep.headers["x-praxis-nonce"])[
        "X-Praxis-Signature"
      ],
    );
    expect(rep.headers["content-type"]).toBe("application/json");
    expect(log.mock.calls.map((c) => c[0])).toContain("selfcheck: 2/2 passed");
  });

  it("each run uses a fresh nonce", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const a = await run(ENV, DAILY);
    const b = await run(ENV, DAILY);
    expect(reportCall(a.calls)!.headers["x-praxis-nonce"]).not.toBe(
      reportCall(b.calls)!.headers["x-praxis-nonce"],
    );
  });

  it("other tick, commit already recorded: nothing is checked or sent", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { calls } = await run(ENV, OTHER, { recorded: true });
    expect(calls).toHaveLength(1); // only the decision query
    expect(reportCall(calls)).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });

  it("other tick, new commit: runs once and reports", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { calls } = await run(ENV, OTHER, { recorded: false });
    expect(reportCall(calls)).toBeDefined();
  });

  it("a failed check is reported as failed and counted", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { calls } = await run(ENV, DAILY, { github: 401 });
    expect(sent(calls).results[1]).toEqual({
      name: "GITHUB_DISPATCH_TOKEN",
      ok: false,
      detail: "HTTP 401",
    });
    expect(log.mock.calls.map((c) => c[0])).toContain("selfcheck: 1/2 passed");
  });

  it("missing secrets other than the HMAC secret are still reported as missing", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const env = { ...ENV, GITHUB_DISPATCH_TOKEN: undefined, TURSO_MAIN_TOKEN: undefined };
    const { calls } = await run(env, DAILY);
    expect(sent(calls).results.map((r: { detail: string }) => r.detail)).toEqual([
      "missing",
      "missing",
    ]);
  });

  it("without WORKER_HMAC_SECRET or an app address nothing is sent", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    for (const over of [{ WORKER_HMAC_SECRET: undefined }, { APP_BASE_URL: undefined }]) {
      const { calls } = await run({ ...ENV, ...over }, DAILY);
      expect(reportCall(calls)).toBeUndefined();
    }
    expect(log.mock.calls.map((c) => c[0])).toContain("selfcheck: 2/2 passed");
  });

  it("only https app addresses are used; the commit is sent as unknown when not 40 hex", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const a = await run({ ...ENV, APP_BASE_URL: "http://example.test" }, DAILY);
    expect(reportCall(a.calls)).toBeUndefined();
    const b = await run({ ...ENV, BUILD_COMMIT: undefined }, DAILY);
    expect(sent(b.calls).commit).toBe("unknown");
  });

  it("never throws, and never logs a secret value or hostname, whatever fails", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const o of [
      {},
      { turso: "throw" as const, github: "throw" as const, app: "throw" as const },
      { app: 503 },
      { turso: 500, github: 500 },
    ]) {
      await run(ENV, DAILY, o);
    }
    const all = JSON.stringify([log.mock.calls, err.mock.calls, warn.mock.calls]);
    for (const v of Object.values(SECRETS)) expect(all).not.toContain(v);
    expect(all).not.toMatch(/TOPSECRET|secret-host|vercel\.app/);
    for (const [m] of log.mock.calls) expect(String(m)).toMatch(/^selfcheck: /);
  });

  it("the signed request contains no secret value", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { calls } = await run(ENV, DAILY, { turso: 500, github: 403 });
    const everything = JSON.stringify(reportCall(calls));
    for (const v of Object.values(SECRETS)) expect(everything).not.toContain(v);
  });
});

describe("scheduled handler", () => {
  it("logs the heartbeat first and survives a failing self-check", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    try {
      await worker.scheduled({ scheduledTime: DAILY } as ScheduledController, ENV);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(JSON.parse(log.mock.calls[0][0] as string).kind).toBe("heartbeat");
    expect(log.mock.calls.map((c) => c[0])).toContain("selfcheck: 0/2 passed");
  });
});
