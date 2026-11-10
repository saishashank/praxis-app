// @vitest-environment node
// INFRA T3: the small parts of the clock: command words and env sources of the manifest, the environment
// mapping for the Worker runners, the health JSON and endpoint, the failure email, and the UTC cron matcher.
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { backstopDecision, UTC_CRONS, utcCronsDue } from "../../clock/crons";
import { buildClockEnv, LOCAL_TOKEN_PLACEHOLDER } from "../../clock/env";
import {
  healthBody,
  newHealthState,
  noteError,
  startHealthServer,
  STALE_AFTER_MS,
  STARTUP_GRACE_MS,
} from "../../clock/health";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  localJobsDue,
  loadManifest,
  validateManifest,
  conditionHolds,
  parseCondition,
  resolveSource,
  tokenize,
  type SourceCtx,
} from "../../clock/manifest";
import { failureEmail, sendFailureEmail } from "../../clock/notify";

const FAKE_RESEND_KEY = ["re", "key", "test", "0123456789"].join("_"); // built at run time: a fake, not a secret

describe("tokenize (the words of a job command)", () => {
  const vars = { W: "/srv/praxis/jobs/run-7", HISTORY_FLAG: "--history", EMPTY: "", C: "a:b c:d" };
  it("splits on spaces, honours quotes, expands $W and $VAR", () => {
    expect(tokenize("node scripts/x.mjs --out-dir $W/asx", vars)).toEqual([
      "node",
      "scripts/x.mjs",
      "--out-dir",
      "/srv/praxis/jobs/run-7/asx",
    ]);
    expect(tokenize("node b.mjs --candidate \"$C\" --trains '$C'", vars)).toEqual([
      "node",
      "b.mjs",
      "--candidate",
      "a:b c:d",
      "--trains",
      "$C",
    ]);
    expect(tokenize("node f.mjs ${W}/x", vars)).toEqual([
      "node",
      "f.mjs",
      "/srv/praxis/jobs/run-7/x",
    ]);
  });
  it("an unquoted empty variable vanishes; a quoted one stays as an empty word", () => {
    expect(tokenize("node f.mjs $EMPTY $UNSET", vars)).toEqual(["node", "f.mjs"]);
    expect(tokenize('node f.mjs "$EMPTY"', vars)).toEqual(["node", "f.mjs", ""]);
    expect(tokenize("node f.mjs $HISTORY_FLAG", vars)).toEqual(["node", "f.mjs", "--history"]);
    expect(tokenize("node f.mjs $C", vars)).toEqual(["node", "f.mjs", "a:b", "c:d"]);
  });
  it("refuses shell syntax and unterminated quotes", () => {
    for (const bad of ["a | b", "a > b", "a; b", "a && b", "echo `x`", "ls *", 'a "b']) {
      expect(() => tokenize(bad, vars), bad).toThrow();
    }
  });
});

describe("env sources and conditions of a step", () => {
  const ctx: SourceCtx = {
    env: { TURSO_MAIN_URL: "u", BUILD_COMMIT: "abc" },
    inputs: { history: "true", store: "false", slot: "2040", candidates: "g:m" },
    outputs: { plan: { fetch: "true", chunk_size: "9" } },
  };
  it("resolves every source kind", () => {
    expect(resolveSource("TURSO_MAIN_URL", "env", ctx)).toBe("u");
    expect(resolveSource("COMMIT_SHA", "env:BUILD_COMMIT", ctx)).toBe("abc");
    expect(resolveSource("X", "env", ctx)).toBeUndefined();
    expect(resolveSource("X", "const:production", ctx)).toBe("production");
    expect(resolveSource("S", "input:slot|manual", ctx)).toBe("2040");
    expect(resolveSource("S", "input:other|manual", ctx)).toBe("manual");
    expect(resolveSource("S", "input:other", ctx)).toBe("");
    expect(resolveSource("C", "out:plan.chunk_size", ctx)).toBe("9");
    expect(resolveSource("C", "out:plan.nothing", ctx)).toBe("");
    expect(resolveSource("H", "flag:history=--history|", ctx)).toBe("--history");
    expect(resolveSource("H", "flag:store=1|0", ctx)).toBe("0");
    expect(resolveSource("TURSO_MAIN_URL", "when:store?env", ctx)).toBe("");
    expect(resolveSource("TURSO_MAIN_URL", "when:history?env", ctx)).toBe("u");
  });
  it("evaluates conditions on outputs and outcomes", () => {
    expect(parseCondition("out:plan.fetch=true")).toEqual({
      kind: "out",
      step: "plan",
      key: "fetch",
      value: "true",
    });
    expect(parseCondition("nonsense")).toBeNull();
    expect(conditionHolds("out:plan.fetch=true", ctx.outputs, {})).toBe(true);
    expect(conditionHolds("out:plan.fetch=false", ctx.outputs, {})).toBe(false);
    expect(conditionHolds("outcome:plan=success", ctx.outputs, { plan: "success" })).toBe(true);
    expect(conditionHolds("outcome:plan=success", ctx.outputs, { plan: "failure" })).toBe(false);
    expect(conditionHolds("garbage", ctx.outputs, {})).toBe(false);
  });
});

describe("buildClockEnv (the environment of the Worker runners)", () => {
  it("gives the runners https stand-ins for the http app and database, and maps them back", () => {
    const b = buildClockEnv({
      TURSO_MAIN_URL: "http://main.sqld:8080",
      TURSO_MAIN_TOKEN: "t",
      APP_BASE_URL: "http://web:3000",
      WORKER_HMAC_SECRET: "h",
      GITHUB_DISPATCH_TOKEN: "g",
    });
    expect(b.env.TURSO_MAIN_URL).toBe("libsql://main.sqld:8080");
    expect(b.env.APP_BASE_URL).toBe("https://web:3000");
    expect(b.origins).toEqual({
      "https://main.sqld:8080": "http://main.sqld:8080",
      "https://web:3000": "http://web:3000",
    });
    expect(b.env.PRAXIS_ENV).toBe("production");
    expect(b.warnings).toEqual([]);
  });
  it("leaves https and libsql values alone; a missing dispatch token gets a placeholder and a warning", () => {
    const b = buildClockEnv({
      TURSO_MAIN_URL: "libsql://x.turso.io",
      TURSO_MAIN_TOKEN: "t",
      APP_BASE_URL: "https://app.example.test",
      WORKER_HMAC_SECRET: "h",
    });
    expect(b.env.TURSO_MAIN_URL).toBe("libsql://x.turso.io");
    expect(b.env.APP_BASE_URL).toBe("https://app.example.test");
    expect(b.origins).toEqual({});
    expect(b.env.GITHUB_DISPATCH_TOKEN).toBe(LOCAL_TOKEN_PLACEHOLDER);
    expect(b.warnings.join(" ")).toContain("GITHUB_DISPATCH_TOKEN");
    expect(buildClockEnv({}).warnings.length).toBeGreaterThanOrEqual(5);
  });
});

describe("health", () => {
  const view = (running = [] as { id: number; job: string; startedAt: string }[]) => ({
    running: () => running,
    queued: () => [{ job: "a" }],
  });
  it("reports last tick, owner, running jobs and the last error: only fixed words, ids and times", () => {
    const s = newHealthState({
      nowMs: 0,
      enabled: true,
      runtime: "selfhost",
      build: "0123456789abcdef",
    });
    s.lastTickMs = 100_000;
    s.owner = "selfhost";
    noteError(s, 90_000, "database unreachable");
    const b = healthBody(
      s,
      view([{ id: 4, job: "backup", startedAt: "2026-11-03T12:00:00.000Z" }]),
      130_000,
    );
    expect(b).toMatchObject({
      ok: true,
      runtime: "selfhost",
      enabled: true,
      owner: "selfhost",
      lastTick: "1970-01-01T00:01:40.000Z",
      lastTickAgeS: 30,
      queued: 1,
      lastError: { at: "1970-01-01T00:01:30.000Z", what: "database unreachable" },
      build: "0123456789ab",
    });
    expect(b.running).toEqual([{ id: 4, job: "backup", startedAt: "2026-11-03T12:00:00.000Z" }]);
    expect(Object.keys(b).sort()).toEqual(
      [
        "build",
        "enabled",
        "host",
        "lastError",
        "lastTick",
        "lastTickAgeS",
        "ok",
        "owner",
        "queued",
        "running",
        "runtime",
        "selfCheck",
        "uptimeS",
      ].sort(),
    );
  });
  it("is not ok when an enabled clock has not ticked for 3 minutes (after the start-up grace); disabled is fine", () => {
    const s = newHealthState({ nowMs: 0, enabled: true, runtime: "selfhost" });
    expect(healthBody(s, view(), STARTUP_GRACE_MS - 1).ok).toBe(true); // still starting
    expect(healthBody(s, view(), STARTUP_GRACE_MS + 1).ok).toBe(false); // never ticked
    s.lastTickMs = 1_000_000;
    expect(healthBody(s, view(), 1_000_000 + STALE_AFTER_MS).ok).toBe(true);
    expect(healthBody(s, view(), 1_000_000 + STALE_AFTER_MS + 1).ok).toBe(false);
    const off = newHealthState({ nowMs: 0, enabled: false, runtime: "selfhost" });
    expect(healthBody(off, view(), 10 * STALE_AFTER_MS).ok).toBe(true);
  });
  it("GET /health serves the JSON (200, or 503 when stale); other paths are 404", async () => {
    const s = newHealthState({ nowMs: Date.now(), enabled: true, runtime: "selfhost" });
    s.lastTickMs = Date.now();
    const free = await new Promise<number>((r) => {
      const t = createServer();
      t.listen(0, "127.0.0.1", () => {
        const p = (t.address() as { port: number }).port;
        t.close(() => r(p));
      });
    });
    const server = await startHealthServer(free, s, view(), Date.now, "127.0.0.1");
    try {
      const ok = await fetch(`http://127.0.0.1:${free}/health`);
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { ok: boolean; runtime: string };
      expect(body).toMatchObject({ ok: true, runtime: "selfhost" });
      expect((await fetch(`http://127.0.0.1:${free}/other`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${free}/health`, { method: "POST" })).status).toBe(404);
      s.lastTickMs = Date.now() - 10 * STALE_AFTER_MS;
      s.startedAtMs = Date.now() - 10 * STALE_AFTER_MS;
      expect((await fetch(`http://127.0.0.1:${free}/health`)).status).toBe(503);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe("the failure email", () => {
  const env = {
    EMAIL_PROVIDER: "resend",
    RESEND_API_KEY: FAKE_RESEND_KEY,
    OWNER_EMAIL: "Owner@Example.test",
    PRAXIS_ENV: "production",
  };
  it("is addressed to the Owner only, names the job and `praxis run logs <id>`, carries no secret", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (u: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(u), init: init! });
      return Response.json({ id: "m1" });
    }) as typeof fetch;
    const r = await sendFailureEmail(
      env,
      { job: "backup", runId: 42, status: "failed", exitCode: 1 },
      f,
    );
    expect(r).toBe("sent");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    const body = JSON.parse(String(calls[0]!.init.body)) as {
      to: string[];
      subject: string;
      text: string;
    };
    expect(body.to).toEqual(["owner@example.test"]);
    expect(body.subject).toBe("[Praxis] Job backup failed (run 42)");
    expect(body.text).toContain("praxis run logs 42");
    expect(JSON.stringify(body)).not.toContain(env.RESEND_API_KEY);
    expect((calls[0]!.init.headers as Record<string, string>)["Idempotency-Key"]).toBe(
      "production:jobfail:backup:42",
    );
  });
  it("a timeout says so; no provider, key or address means skipped; a provider error is failed, never thrown", async () => {
    expect(
      failureEmail(env, { job: "x", runId: 1, status: "timeout", exitCode: null }, "o@e.test")
        .subject,
    ).toBe("[Praxis] Job x timed out (run 1)");
    const never = (async () => {
      throw new Error("must not be called");
    }) as typeof fetch;
    const info = { job: "x", runId: 1, status: "failed", exitCode: 2 };
    expect(await sendFailureEmail({ ...env, EMAIL_PROVIDER: "mock" }, info, never)).toBe("skipped");
    expect(await sendFailureEmail({ ...env, RESEND_API_KEY: "" }, info, never)).toBe("skipped");
    expect(await sendFailureEmail({ ...env, OWNER_EMAIL: "" }, info, never)).toBe("skipped");
    const boom = (async () => new Response("no", { status: 500 })) as typeof fetch;
    expect(await sendFailureEmail(env, info, boom)).toBe("failed");
  });
});

describe("the UTC cron matcher", () => {
  it("has 14 entries: 8 Vercel routes and 6 GitHub backstops", () => {
    expect(UTC_CRONS).toHaveLength(14);
    expect(UTC_CRONS.filter((c) => c.source === "vercel")).toHaveLength(8);
    expect(new Set(UTC_CRONS.map((c) => c.id)).size).toBe(14);
  });
  it("two crons share 11:40 UTC; nothing is due at another minute", () => {
    const at = (t: string) => utcCronsDue(Date.parse(`2026-11-03T${t}:00Z`)).map((c) => c.id);
    expect(at("11:40").sort()).toEqual(["heartbeat-evening-2", "watchdog-1"]);
    expect(at("11:41")).toEqual([]);
    expect(at("00:20")).toEqual(["heartbeat-morning-1"]);
  });
  it("a backstop runs on the line of the regime in force and stands down on the other (PLT-019)", () => {
    const c = (id: string) =>
      UTC_CRONS.find((x) => x.id === id) as Extract<
        (typeof UTC_CRONS)[number],
        { source: "github" }
      >;
    const aedt = Date.parse("2026-11-03T09:40:00Z"); // 20:40 AEDT
    expect(backstopDecision(c("watchdog-backstop-1"), aedt)).toEqual({
      run: true,
      inputs: { slot: "2040" },
    });
    expect(backstopDecision(c("watchdog-backstop-2"), Date.parse("2026-11-03T10:40:00Z"))).toEqual({
      run: false,
      inputs: {},
    });
    const aest = Date.parse("2026-07-14T10:40:00Z"); // 20:40 AEST
    expect(backstopDecision(c("watchdog-backstop-2"), aest)).toEqual({
      run: true,
      inputs: { slot: "2040" },
    });
    expect(backstopDecision(c("watchdog-backstop-1"), Date.parse("2026-07-14T09:40:00Z"))).toEqual({
      run: false,
      inputs: {},
    });
    // ingest has no slot input
    expect(
      backstopDecision(c("ingest-batch1-backstop-1"), Date.parse("2026-11-03T07:15:00Z")),
    ).toEqual({ run: true, inputs: {} });
  });
});

describe("noteError", () => {
  it("keeps only a short fixed word", () => {
    const s = newHealthState({ nowMs: 0, enabled: true, runtime: "cloud" });
    noteError(s, 5, "x".repeat(200));
    expect(s.lastError!.what).toHaveLength(60);
  });
});

describe("localSchedule matcher and validation", () => {
  const m = loadManifest(path.resolve(import.meta.dirname, "../../deploy/selfhost/jobs.json"));
  const at = (h: number, mi: number, dow: number) => localJobsDue(m, h * 60 + mi, dow);
  it("bucket-hourly: every hour at :05 from 07:05 to 23:05, every day", () => {
    let n = 0;
    for (let h = 0; h < 24; h++) {
      const due = at(h, 5, 2).includes("bucket-hourly");
      expect(due, String(h)).toBe(h >= 7 && h <= 23);
      if (due) n++;
      expect(at(h, 6, 2)).not.toContain("bucket-hourly");
    }
    expect(n).toBe(17);
  });
  it("turso-refresh nightly at 23:25 (done before the 00:15 replay slot); restore-drill Sunday 10:00 only", () => {
    expect(at(23, 25, 3)).toEqual(["turso-refresh"]);
    expect(at(23, 40, 3)).toEqual([]);
    expect(at(10, 0, 0)).toEqual(["restore-drill"]);
    expect(at(10, 0, 1)).toEqual([]);
  });
  it("replay-sync twice a day: 06:00 (after replay's 5.5 h limit) and 23:10 (before the refresh wipes Turso)", () => {
    expect(at(6, 0, 3)).toEqual(["replay-sync"]);
    expect(at(23, 10, 3)).toEqual(["replay-sync"]);
    expect(at(12, 0, 3)).toEqual([]);
  });
  it("validateManifest refuses a bad local schedule, a workflow on a local job and bad exit codes", () => {
    const base = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, "../../deploy/selfhost/jobs.json"), "utf8"),
    );
    const a = structuredClone(base);
    a.localSchedule["bucket-hourly"].schedule.from = "25:00";
    expect(() => validateManifest(a)).toThrow(/bad schedule/);
    const b = structuredClone(base);
    b.localSchedule["restore-drill"].workflow = "x.yml";
    expect(() => validateManifest(b)).toThrow(/no workflow/);
    const c = structuredClone(base);
    c.localSchedule["turso-refresh"].standbyExitCodes = [0];
    expect(() => validateManifest(c)).toThrow(/standbyExitCodes/);
    const d = structuredClone(base);
    d.localSchedule.backup = d.localSchedule["restore-drill"];
    expect(() => validateManifest(d)).toThrow(/reuse a workflow job name/);
  });
});
