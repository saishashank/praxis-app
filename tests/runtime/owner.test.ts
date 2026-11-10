// @vitest-environment node
// INFRA T1 (INFRA §6): the single-clock rule in the app. When the main DB's `clock_owner` names the
// other runtime, the heartbeat and watchdog cron routes answer 200 { ok: true, standby: true } and do
// nothing else. Absent, unreadable or any other value is "cloud". No network, no real secrets.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHeartbeatHandler } from "@/lib/heartbeat/handler";
import {
  CLOCK_OWNER_KEY,
  isOwner,
  onStandby,
  ownerFrom,
  runtimeOf,
  STANDBY_BODY,
} from "@/lib/runtime/owner";
import { createWatchdogHandler } from "@/lib/watchdog/handler";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { A, githubMock, TOKEN } from "../watchdog/helpers";

afterEach(cleanupTempDbs);

const CRON = "c".repeat(32);
const PROD = {
  CRON_SECRET: CRON,
  BACKUP_PUBLIC_KEY: "age1fake",
  GITHUB_READ_TOKEN: TOKEN,
  APP_COMMIT: A,
};
const SELF = { ...PROD, PRAXIS_RUNTIME: "selfhost" };
const NOW = new Date("2026-10-12T00:30:00.000Z");

let db: Client;
beforeEach(async () => {
  db = await freshDb("main");
});

const setOwner = (v: string) =>
  db.execute({
    sql: "INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, ?, 'x')",
    args: [CLOCK_OWNER_KEY, v],
  });
const req = (path: string) =>
  new Request(`https://praxis-host.vercel.app${path}`, {
    headers: { Authorization: `Bearer ${CRON}` },
  });
const runCount = async () => (await db.execute("SELECT 1 FROM run_record")).rows.length;
const incidentCount = async () => (await db.execute("SELECT 1 FROM incident")).rows.length;

const heartbeat = (kind: "morning" | "evening", env: Record<string, string | undefined>) =>
  createHeartbeatHandler(kind, { env, mainDb: () => db, now: () => NOW });
const watchdog = (env: Record<string, string | undefined>) =>
  createWatchdogHandler({
    env,
    fetchImpl: githubMock([{ id: 1, sha: A, state: "success" }]).fetchImpl,
    mainDb: () => db,
    now: () => NOW,
  });

describe("helpers", () => {
  it("runtimeOf: cloud unless PRAXIS_RUNTIME is selfhost", () => {
    expect(runtimeOf({})).toBe("cloud");
    expect(runtimeOf({ PRAXIS_RUNTIME: "" })).toBe("cloud");
    expect(runtimeOf({ PRAXIS_RUNTIME: "nonsense" })).toBe("cloud");
    expect(runtimeOf({ PRAXIS_RUNTIME: "selfhost" })).toBe("selfhost");
  });
  it("ownerFrom: absent, garbage and other values are cloud", () => {
    expect(ownerFrom(undefined)).toBe("cloud");
    expect(ownerFrom(null)).toBe("cloud");
    expect(ownerFrom('"selfhost"')).toBe("selfhost");
    for (const bad of ["", "selfhost", "{", "1", '["selfhost"]', '"other"', '"Selfhost"']) {
      expect(ownerFrom(bad)).toBe("cloud");
    }
  });
  it("isOwner", () => {
    expect(isOwner({}, undefined)).toBe(true);
    expect(isOwner({}, '"selfhost"')).toBe(false);
    expect(isOwner({ PRAXIS_RUNTIME: "selfhost" }, undefined)).toBe(false);
    expect(isOwner({ PRAXIS_RUNTIME: "selfhost" }, '"selfhost"')).toBe(true);
  });
  it("onStandby reads the main DB; an unreadable DB counts as cloud", async () => {
    expect(await onStandby(db, {})).toBe(false);
    await setOwner('"selfhost"');
    expect(await onStandby(db, {})).toBe(true);
    expect(await onStandby(db, { PRAXIS_RUNTIME: "selfhost" })).toBe(false);
    const broken = {
      execute: async () => {
        throw new Error("down");
      },
    } as unknown as Client;
    expect(await onStandby(broken, {})).toBe(false);
    expect(await onStandby(broken, { PRAXIS_RUNTIME: "selfhost" })).toBe(true);
  });
  it("a garbage owner value is cloud", async () => {
    await setOwner("{not json");
    expect(await onStandby(db, {})).toBe(false);
  });
});

describe("the cron routes stand by when the other runtime owns the clock", () => {
  const cases: [
    string,
    (env: Record<string, string | undefined>) => (r: Request) => Promise<Response>,
    string,
  ][] = [
    ["heartbeat-morning", (e) => heartbeat("morning", e), "/api/cron/heartbeat-morning"],
    ["heartbeat-evening", (e) => heartbeat("evening", e), "/api/cron/heartbeat-evening"],
    ["watchdog", (e) => watchdog(e), "/api/cron/watchdog"],
  ];
  for (const [name, make, path] of cases) {
    it(`${name}: owner selfhost, cloud app: 200 standby, no run, no incident`, async () => {
      await setOwner('"selfhost"');
      const res = await make(PROD)(req(path));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(STANDBY_BODY);
      expect(await runCount()).toBe(0);
      expect(await incidentCount()).toBe(0);
    });

    it(`${name}: selfhost app with the key absent stands by`, async () => {
      const res = await make(SELF)(req(path));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, standby: true });
      expect(await runCount()).toBe(0);
    });

    it(`${name}: key absent or garbage, cloud app: runs as before`, async () => {
      for (const v of [null, "{oops", '"cloud"']) {
        await db.execute("DELETE FROM worker_state");
        if (v !== null) await setOwner(v);
        const res = await make(PROD)(req(path));
        expect(res.status).toBe(200);
        expect(await res.json()).not.toEqual(STANDBY_BODY);
      }
      expect(await runCount()).toBeGreaterThan(0);
    });

    it(`${name}: selfhost app acts when owner is selfhost`, async () => {
      await setOwner('"selfhost"');
      const res = await make(SELF)(req(path));
      expect(await res.json()).not.toEqual(STANDBY_BODY);
    });

    it(`${name}: authentication still comes first`, async () => {
      await setOwner('"selfhost"');
      const res = await make(PROD)(
        new Request(`https://praxis-host.vercel.app${path}`, {
          headers: { Authorization: "Bearer wrong" },
        }),
      );
      expect(res.status).toBe(401);
    });
  }
});
