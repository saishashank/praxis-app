// @vitest-environment node
import { createClient } from "@libsql/client";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDbs, ROOT, tempDbUrl, track } from "./helpers";

afterEach(cleanupTempDbs);

const CLI = path.join(ROOT, "scripts", "db", "migrate.mjs");

function run(args: string[], env: Record<string, string>) {
  const base: Record<string, string> = { PATH: process.env.PATH ?? "" };
  if (process.env.SystemRoot) base.SystemRoot = process.env.SystemRoot;
  const r = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...base, ...env } as NodeJS.ProcessEnv,
    encoding: "utf8",
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("migrate CLI", () => {
  it("--if-vercel skips outside Vercel", () => {
    const r = run(["--if-vercel"], {});
    expect(r.code).toBe(0);
    expect(r.out).toContain("skipped");
  });

  it("--if-vercel on Vercel with missing vars fails without leaking values", () => {
    const r = run(["--if-vercel"], {
      VERCEL: "1",
      TURSO_MAIN_URL: "libsql://secret-host-fake.example.invalid",
      TURSO_MAIN_TOKEN: "FAKE-TOKEN-VALUE-123",
    });
    expect(r.code).toBe(1);
    expect(r.out).not.toContain("FAKE-TOKEN-VALUE-123");
    expect(r.out).not.toContain("secret-host-fake");
  });

  it("driver failures print only a generic message", () => {
    const r = run(["--db", "main"], {
      TURSO_MAIN_URL: "libsql://secret-host-fake.example.invalid",
      TURSO_MAIN_TOKEN: "FAKE-TOKEN-VALUE-123",
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("migration failed");
    expect(r.out).not.toContain("FAKE-TOKEN-VALUE-123");
    expect(r.out).not.toContain("secret-host-fake");
  });

  it("--db requires a name", () => {
    expect(run([], {}).code).toBe(1);
  });

  it("--db main against a local file DB works", async () => {
    const url = tempDbUrl();
    const r = run(["--db", "main"], { TURSO_MAIN_URL: url });
    expect(r.code).toBe(0);
    expect(r.out).toContain("migrate main: applied 1 (now at v1)");
    const again = run(["--db", "main"], { TURSO_MAIN_URL: url });
    expect(again.out).toContain("applied 0 (now at v1)");
    const db = track(createClient({ url }));
    const t = await db.execute("SELECT name FROM sqlite_master WHERE name = 'run_record'");
    expect(t.rows.length).toBe(1);
  });

  it("--if-vercel on Vercel migrates main then auth", () => {
    const r = run(["--if-vercel"], {
      VERCEL: "1",
      TURSO_MAIN_URL: tempDbUrl(),
      TURSO_AUTH_URL: tempDbUrl(),
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("migrate main: applied 1");
    expect(r.out).toContain("migrate auth: applied 1");
  });
});
