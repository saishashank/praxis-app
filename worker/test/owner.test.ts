// INFRA T1 (INFRA §6): the single-clock rule in the Worker. `worker_state.clock_owner` absent,
// unreadable or any other value means "cloud", so the live system is unchanged; a runtime acts only
// when the owner names it, and a standby tick costs the same requests as a normal one (zero extra
// reads, decision O-81). Real SQLite behind the Turso fake; nothing touches a network.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetClockCache, runClock, type ClockEnv } from "../src/clock";
import { CLOCK_OWNER_KEY, isOwner, ownerFrom, runtimeOf, standbyLine } from "../src/owner";
import { postDeployKey, resetPostDeploy, runPostDeploy } from "../src/postdeploy";
import { runReenable } from "../src/reenable";
import { runRoutes, type RouteEnv } from "../src/routes";
import { runRunNow, type RunNowEnv } from "../src/runNow";
import { AU_SLOTS, type Slot } from "../src/schedule";
import { TOKEN, TURSO_TOKEN, TURSO_URL, makeDb, makeNet, rows, type Net } from "./fakeTurso";

const APP = "https://praxis-app.example.test";
const BASE = {
  PRAXIS_ENV: "production",
  GITHUB_DISPATCH_TOKEN: TOKEN,
  TURSO_MAIN_URL: TURSO_URL,
  TURSO_MAIN_TOKEN: TURSO_TOKEN,
  APP_BASE_URL: APP,
  WORKER_HMAC_SECRET: "7".repeat(64),
};
type AllEnv = ClockEnv & RouteEnv & RunNowEnv;
const CLOUD: AllEnv = { ...BASE };
const SELF: AllEnv = { ...BASE, PRAXIS_RUNTIME: "selfhost" };

const at = (date: string, hm: string, offset = 11) => {
  const [h, m] = hm.split(":").map(Number);
  const [y, mo, d] = date.split("-").map(Number);
  return Date.UTC(y, mo - 1, d, h - offset, m);
};
const MON = "2026-10-19"; // AEDT Monday
const MIN = 60_000;

let db: DatabaseSync;
let net: Net;
let appPosts: number;
let f: typeof fetch;
let logs: string[];

const setState = (key: string, v: string) =>
  db
    .prepare(
      "INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, ?, 'x') " +
        "ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json",
    )
    .run(key, v);
const owner = (v: string) => setState(CLOCK_OWNER_KEY, v);
const dispatchOn = () => setState("dispatch_enabled", '"1"');
const stateKeys = () => rows(db, "SELECT key FROM worker_state ORDER BY key").map((r) => r.key);
const deps = (t: number) => ({ fetch: f, nowMs: () => t });

beforeEach(() => {
  db = makeDb({ sentinel: false });
  net = makeNet(db);
  appPosts = 0;
  logs = [];
  resetClockCache();
  resetPostDeploy();
  f = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).startsWith(APP)) {
      appPosts++;
      return Response.json({ ok: true });
    }
    return net.f(input, init);
  }) as typeof fetch;
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.join(" "));
  });
});
afterEach(() => vi.restoreAllMocks());

describe("owner helpers", () => {
  it("runtimeOf: cloud unless PRAXIS_RUNTIME is selfhost", () => {
    expect(runtimeOf({})).toBe("cloud");
    expect(runtimeOf({ PRAXIS_RUNTIME: "" })).toBe("cloud");
    expect(runtimeOf({ PRAXIS_RUNTIME: "weird" })).toBe("cloud");
    expect(runtimeOf({ PRAXIS_RUNTIME: "selfhost" })).toBe("selfhost");
    expect(runtimeOf({ PRAXIS_RUNTIME: " SelfHost " })).toBe("selfhost");
  });
  it("ownerFrom: absent, garbage and other values are cloud", () => {
    expect(ownerFrom(undefined)).toBe("cloud");
    expect(ownerFrom(null)).toBe("cloud");
    expect(ownerFrom('"cloud"')).toBe("cloud");
    expect(ownerFrom('"selfhost"')).toBe("selfhost");
    for (const bad of ["", "selfhost", "{", "1", "null", '["selfhost"]', '"Selfhost"', '"other"']) {
      expect(ownerFrom(bad)).toBe("cloud");
    }
  });
  it("isOwner and the log line", () => {
    expect(isOwner({}, undefined)).toBe(true);
    expect(isOwner({}, '"selfhost"')).toBe(false);
    expect(isOwner({ PRAXIS_RUNTIME: "selfhost" }, undefined)).toBe(false);
    expect(isOwner({ PRAXIS_RUNTIME: "selfhost" }, '"selfhost"')).toBe(true);
    expect(standbyLine({}, '"selfhost"')).toBe("clock: standby (owner=selfhost, runtime=cloud)");
  });
});

describe("runClock (maintenance slot, Mon 22:30)", () => {
  const T = at(MON, "22:30");
  const tick = (env: ClockEnv) => runClock(env, T, deps(T));

  it("key absent: the cloud Worker dispatches exactly as before", async () => {
    dispatchOn();
    const s = await tick(CLOUD);
    expect(s.dispatched).toEqual(["maintenance"]);
    expect(net.github).toHaveLength(1);
  });

  it("owner selfhost: the cloud Worker dispatches nothing, claims nothing, says standby", async () => {
    dispatchOn();
    owner('"selfhost"');
    const s = await tick(CLOUD);
    expect(s.dispatched).toEqual([]);
    expect(s.skipped).toEqual([{ id: "clock", reason: "standby" }]);
    expect(net.github).toHaveLength(0);
    expect(stateKeys().some((k) => String(k).startsWith("slot:"))).toBe(false);
    expect(logs).toContain("clock: standby (owner=selfhost, runtime=cloud)");
  });

  it("a standby tick costs the same requests as a normal first request (no extra read)", async () => {
    dispatchOn();
    owner('"selfhost"');
    const standby = await tick(CLOUD);
    expect(standby.requests).toBe(1);
    expect(net.pipelines).toBe(1);
  });

  it("PRAXIS_RUNTIME=selfhost with the key absent stands by; with owner selfhost it acts", async () => {
    dispatchOn();
    const s1 = await tick(SELF);
    expect(s1.dispatched).toEqual([]);
    expect(net.github).toHaveLength(0);
    expect(logs).toContain("clock: standby (owner=cloud, runtime=selfhost)");
    owner('"selfhost"');
    const s2 = await tick(SELF);
    expect(s2.dispatched).toEqual(["maintenance"]);
  });

  it("a garbage owner value means cloud", async () => {
    dispatchOn();
    owner("{not json");
    expect((await tick(CLOUD)).dispatched).toEqual(["maintenance"]);
  });

  it("an idle minute still makes zero requests", async () => {
    owner('"selfhost"');
    const t = at(MON, "03:00");
    await runClock(CLOUD, t, deps(t)); // first minute of the day: the rollup
    const before = net.pipelines;
    await runClock(CLOUD, t + MIN, deps(t + MIN));
    expect(net.pipelines).toBe(before);
  });
});

describe("runRoutes", () => {
  const on: Slot[] = AU_SLOTS.map((s) =>
    s.runner === "route" ? { ...s, enabled: true, requiresListing: false } : s,
  );
  const T = at(MON, "20:00");
  const tick = (env: RouteEnv) => runRoutes(env, T, deps(T), on);

  it("key absent: posts as before", async () => {
    dispatchOn();
    expect((await tick(CLOUD)).posted).toEqual(["evening-review"]);
    expect(appPosts).toBe(1);
  });

  it("owner selfhost: the cloud Worker posts nothing and claims nothing", async () => {
    dispatchOn();
    owner('"selfhost"');
    const s = await tick(CLOUD);
    expect(s.posted).toEqual([]);
    expect(appPosts).toBe(0);
    expect(s.requests).toBe(1);
    expect(stateKeys().some((k) => String(k).startsWith("slot:"))).toBe(false);
    expect(logs).toContain("clock: standby (owner=selfhost, runtime=cloud)");
  });

  it("PRAXIS_RUNTIME=selfhost: standby with key absent, acts when owner is selfhost", async () => {
    dispatchOn();
    expect((await tick(SELF)).posted).toEqual([]);
    owner('"selfhost"');
    expect((await tick(SELF)).posted).toEqual(["evening-review"]);
  });
});

describe("runRunNow", () => {
  const T = at(MON, "03:00");
  const add = () =>
    db
      .prepare(
        "INSERT INTO run_now_request (job_id, market, params_json, requested_by_hmac, requested_at, " +
          "audit_ref, status, updated_at) VALUES ('backfill-prices', 'AU', '{}', ?, ?, 'audit:1', 'pending', ?)",
      )
      .run("a".repeat(64), new Date(T - MIN).toISOString(), new Date(T - MIN).toISOString());
  const status = () => rows(db, "SELECT status FROM run_now_request")[0]!.status;
  const tick = (env: RunNowEnv) => runRunNow(env, T, deps(T));

  it("key absent: the cloud Worker runs the request as before", async () => {
    dispatchOn();
    setState("slots_enabled", '["backfill-prices"]');
    add();
    await tick(CLOUD);
    expect(status()).toBe("done");
    expect(net.github).toHaveLength(1);
  });

  it("owner selfhost: the cloud Worker leaves the request pending, runs nothing", async () => {
    dispatchOn();
    setState("slots_enabled", '["backfill-prices"]');
    owner('"selfhost"');
    add();
    const s = await tick(CLOUD);
    expect(status()).toBe("pending");
    expect(net.github).toHaveLength(0);
    expect(s.started).toEqual([]);
    expect(s.requests).toBe(2); // request 1 (expire + read) and request 2 (guarded claim), as normal
    expect(logs).toContain("clock: standby (owner=selfhost, runtime=cloud)");
  });

  it("PRAXIS_RUNTIME=selfhost: pending with the key absent; runs when owner is selfhost", async () => {
    dispatchOn();
    setState("slots_enabled", '["backfill-prices"]');
    add();
    await tick(SELF);
    expect(status()).toBe("pending");
    owner('"selfhost"');
    await tick(SELF);
    expect(status()).toBe("done");
    expect(net.github).toHaveLength(1);
  });

  it("an idle minute makes one request, owner key or not", async () => {
    owner('"selfhost"');
    await tick(CLOUD);
    expect(net.pipelines).toBe(1);
  });
});

describe("runPostDeploy", () => {
  const COMMIT = "b".repeat(40);
  const env = (extra: Record<string, string> = {}) => ({ ...BASE, BUILD_COMMIT: COMMIT, ...extra });
  const d = () => ({ fetch: f, nowMs: () => Date.parse("2026-10-27T01:00:00Z") });

  it("owner selfhost: no post-deploy fill, no claim, one read", async () => {
    dispatchOn();
    owner('"selfhost"');
    expect(await runPostDeploy(env(), d())).toBe("standby");
    expect(net.github).toHaveLength(0);
    expect(net.pipelines).toBe(1);
    expect(
      rows(db, "SELECT 1 FROM worker_state WHERE key = ?", postDeployKey(COMMIT)),
    ).toHaveLength(0);
  });

  it("key absent: dispatches as before; selfhost runtime with the key absent stands by", async () => {
    dispatchOn();
    expect(await runPostDeploy(env({ PRAXIS_RUNTIME: "selfhost" }), d())).toBe("standby");
    expect(await runPostDeploy(env(), d())).toBe("dispatched");
  });
});

describe("runReenable", () => {
  it("does nothing outside its five ticks regardless of the owner key", async () => {
    owner('"selfhost"');
    const t = at(MON, "12:00");
    await runReenable(CLOUD, t, deps(t));
    expect(net.pipelines).toBe(0);
  });

  it("on its tick a standby runtime makes the one existing read and claims nothing", async () => {
    owner('"selfhost"');
    const t = Date.UTC(2026, 9, 19, 2, 40); // 02:40 UTC, the first re-enable tick
    const s = await runReenable(CLOUD, t, deps(t));
    expect(s.requests).toBe(1);
    expect(net.github).toHaveLength(0);
    expect(stateKeys().some((k) => String(k).startsWith("reenable:"))).toBe(false);
    expect(logs).toContain("clock: standby (owner=selfhost, runtime=cloud)");
  });
});
