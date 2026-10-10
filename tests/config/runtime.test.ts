// @vitest-environment node
// PLT-041 (runtime config reads), SEC-014 / PLT-033 (limits accessors)
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CACHE_TTL_MS,
  FAILURE_TTL_MS,
  getConfigCached,
  invalidateConfigCache,
  peekConfig,
} from "@/lib/config/runtime";
import { setConfig } from "@/lib/config/store";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

let db: Client;
let clock = 1_000_000;
const now = () => clock;
let opened = 0;
const deps = () => ({
  db: () => {
    opened += 1;
    return db;
  },
  now,
});

beforeEach(async () => {
  invalidateConfigCache();
  clock = 1_000_000;
  opened = 0;
  db = await freshDb("main");
});

const set = (value: number) =>
  setConfig(db, { key: "retention_logs_days", value, userId: 1, now: "2026-10-10T00:00:00.000Z" });

describe("getConfigCached", () => {
  it("returns the default, then caches (hit)", async () => {
    expect(await getConfigCached("retention_logs_days", "global", deps())).toBe(30);
    await set(7);
    expect(await getConfigCached("retention_logs_days", "global", deps())).toBe(30); // cached
    expect(opened).toBe(1);
  });

  it("reads the stored value and expires after 60 s", async () => {
    await set(7);
    expect(await getConfigCached("retention_logs_days", "global", deps())).toBe(7);
    await set(9);
    clock += CACHE_TTL_MS - 1;
    expect(await getConfigCached("retention_logs_days", "global", deps())).toBe(7);
    clock += 1;
    expect(await getConfigCached("retention_logs_days", "global", deps())).toBe(9);
  });

  it("invalidateConfigCache drops the cache", async () => {
    await set(7);
    expect(await getConfigCached("retention_logs_days", "global", deps())).toBe(7);
    await set(9);
    invalidateConfigCache();
    expect(await getConfigCached("retention_logs_days", "global", deps())).toBe(9);
  });

  it("scopes are cached separately and fall back to global", async () => {
    await set(7);
    await setConfig(db, {
      key: "retention_logs_days",
      scope: "AU",
      value: 3,
      userId: 1,
      now: "2026-10-10T00:00:00.000Z",
    });
    expect(await getConfigCached("retention_logs_days", "AU", deps())).toBe(3);
    expect(await getConfigCached("retention_logs_days", "global", deps())).toBe(7);
  });

  it("concurrent misses share one read", async () => {
    await Promise.all([
      getConfigCached("retention_logs_days", "global", deps()),
      getConfigCached("retention_logs_days", "global", deps()),
    ]);
    expect(opened).toBe(1);
  });

  it("a DB error returns the default, never throws, and retries after 10 s", async () => {
    const broken = {
      db: () => {
        throw new Error("down");
      },
      now,
    };
    expect(await getConfigCached("retention_logs_days", "global", broken)).toBe(30);
    await set(7);
    expect(await getConfigCached("retention_logs_days", "global", deps())).toBe(30); // failure cached
    clock += FAILURE_TTL_MS;
    expect(await getConfigCached("retention_logs_days", "global", deps())).toBe(7);
  });

  it("a query error returns the default", async () => {
    const bad = {
      db: () => ({ execute: () => Promise.reject(new Error("x")) }) as unknown as Client,
      now,
    };
    expect(await getConfigCached("rate_limits", "global", bad)).toEqual({
      signin_per_min_ip: 10,
      writes_per_min_user: 60,
      exports_per_hour_user: 5,
    });
  });

  it("without injected deps and no env it falls back to the default", async () => {
    vi.stubEnv("TURSO_MAIN_URL", "");
    expect(await getConfigCached("session_lifetime_days")).toBe(14);
    vi.unstubAllEnvs();
  });

  it("closes a client it opened itself", async () => {
    const close = vi.fn();
    vi.resetModules();
    vi.doMock("@/lib/db/client", () => ({
      mainDb: () => ({
        execute: async () => ({ rows: [{ value_json: "5" }] }),
        close,
      }),
    }));
    const fresh = await import("@/lib/config/runtime");
    expect(await fresh.getConfigCached("retention_logs_days")).toBe(5);
    expect(close).toHaveBeenCalledTimes(1);
    vi.doUnmock("@/lib/db/client");
    vi.resetModules();
  });
});

describe("peekConfig", () => {
  it("returns the default synchronously, then the stored value once refreshed", async () => {
    await set(7);
    expect(peekConfig("retention_logs_days", "global", deps())).toBe(30);
    await getConfigCached("retention_logs_days", "global", deps()); // joins the in-flight refresh
    expect(peekConfig("retention_logs_days", "global", deps())).toBe(7);
  });

  it("serves the stale value while it refreshes after expiry", async () => {
    await set(7);
    await getConfigCached("retention_logs_days", "global", deps());
    await set(9);
    clock += CACHE_TTL_MS;
    expect(peekConfig("retention_logs_days", "global", deps())).toBe(7);
    await getConfigCached("retention_logs_days", "global", deps());
    expect(peekConfig("retention_logs_days", "global", deps())).toBe(9);
  });
});

describe("limits accessors read the store", () => {
  async function limitsWith(rate: unknown, days?: unknown) {
    vi.resetModules();
    vi.doMock("@/lib/db/client", () => ({
      mainDb: () => ({ execute: (a: never) => db.execute(a), close: () => undefined }),
    }));
    for (const [key, value] of [
      ["rate_limits", rate],
      ["session_lifetime_days", days],
    ] as const) {
      if (value === undefined) continue;
      await db.execute({
        sql: "INSERT INTO config_version (key, scope, value_json, changed_at) VALUES (?, 'global', ?, ?)",
        args: [key, JSON.stringify(value), "2026-10-10T00:00:00.000Z"],
      });
    }
    const limits = await import("@/lib/http/limits");
    const runtime = await import("@/lib/config/runtime");
    limits.getRateLimits(); // cold: default, starts the refresh
    limits.getSessionMaxAgeSec();
    await runtime.getConfigCached("rate_limits");
    await runtime.getConfigCached("session_lifetime_days");
    return limits;
  }
  afterEach(() => {
    vi.doUnmock("@/lib/db/client");
    vi.resetModules();
  });

  it("uses stored rate limits and session lifetime", async () => {
    const l = await limitsWith(
      { signin_per_min_ip: 3, writes_per_min_user: 20, exports_per_hour_user: 1 },
      7,
    );
    expect(l.getRateLimits()).toEqual({
      signin_per_min_ip: 3,
      writes_per_min_user: 20,
      exports_per_hour_user: 1,
    });
    expect(l.getSessionMaxAgeSec()).toBe(7 * 86400);
  });

  it("defaults before any edit", async () => {
    const l = await limitsWith(undefined);
    expect(l.getRateLimits().writes_per_min_user).toBe(60);
    expect(l.getSessionMaxAgeSec()).toBe(14 * 86400);
  });

  it("a malformed stored row falls back per field, and the lifetime never exceeds 14 days", async () => {
    const l = await limitsWith({ signin_per_min_ip: 0, writes_per_min_user: "x" }, 30);
    expect(l.getRateLimits()).toEqual({
      signin_per_min_ip: 10,
      writes_per_min_user: 60,
      exports_per_hour_user: 5,
    });
    expect(l.getSessionMaxAgeSec()).toBe(14 * 86400);
  });

  it("stored rate limits can tighten but never loosen the SEC-014 maximums", async () => {
    const l = await limitsWith(
      { signin_per_min_ip: 1000, writes_per_min_user: 61, exports_per_hour_user: 6 },
      7,
    );
    expect(l.getRateLimits()).toEqual({
      signin_per_min_ip: 10,
      writes_per_min_user: 60,
      exports_per_hour_user: 5,
    });
  });

  it("a null stored rate_limits uses the defaults", async () => {
    const l = await limitsWith(null);
    expect(l.getRateLimits().signin_per_min_ip).toBe(10);
  });
});
