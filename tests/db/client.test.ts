// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { authDb, mainDb } from "@/lib/db/client";
import { nowIso } from "@/lib/db/time";

afterEach(() => vi.unstubAllEnvs());

describe("db client", () => {
  it("throws a generic error when not configured", () => {
    vi.stubEnv("TURSO_MAIN_URL", "libsql://leaky-host.invalid");
    vi.stubEnv("TURSO_MAIN_TOKEN", "");
    vi.stubEnv("TURSO_AUTH_URL", "");
    expect(() => mainDb()).toThrow("database not configured");
    expect(() => authDb()).toThrow("database not configured");
    try {
      mainDb();
    } catch (e) {
      expect(String(e)).not.toContain("leaky-host");
    }
  });

  it("creates clients from env (file URLs need no token)", async () => {
    vi.stubEnv("TURSO_MAIN_URL", ":memory:");
    vi.stubEnv("TURSO_AUTH_URL", "libsql://x.invalid");
    vi.stubEnv("TURSO_AUTH_TOKEN", "t");
    expect((await mainDb().execute("SELECT 1 AS n")).rows[0].n).toBe(1);
    expect(authDb()).toBeDefined();
  });

  it("nowIso is ISO UTC with milliseconds", () => {
    expect(nowIso()).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });
});
