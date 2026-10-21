// M7 T3: the E2E seed scenarios are deterministic, synthetic (ZZ only) and apply to the real schema.
import { createClient } from "@libsql/client";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ES module without types
import { JOB_INTERVAL_HOURS, buildScenario, zzCode } from "../../e2e/seed/data.mjs";
// @ts-expect-error plain ES module without types
import { applyScenario } from "../../e2e/seed/index.mjs";

const NOW = "2026-10-20T03:00:00.000Z";
const root = path.resolve(import.meta.dirname, "..", "..");

describe("seed scenarios", () => {
  it("are deterministic", () => {
    expect(buildScenario("populated", NOW)).toEqual(buildScenario("populated", NOW));
  });

  it("empty has nothing; populated and stale share data", () => {
    const e = buildScenario("empty", NOW);
    expect(e.instruments.length + e.bars.length + e.runs.length).toBe(0);
    const p = buildScenario("populated", NOW);
    const s = buildScenario("stale", NOW);
    expect(s.bars).toEqual(p.bars);
    expect(p.instruments.length).toBeGreaterThan(10);
  });

  it("uses synthetic ZZ codes only, and no weekend bars", () => {
    const p = buildScenario("populated", NOW);
    for (const i of p.instruments) expect(i.code).toMatch(/^ZZ[A-Z]{2}$/);
    expect(zzCode(0)).toBe("ZZAA");
    for (const b of p.bars) expect([0, 6]).not.toContain(new Date(b.d).getUTCDay());
  });

  it("stale runs are older than twice their interval; fresh ones are not", () => {
    const age = (r: { job: string; ended_at: string }) =>
      (Date.parse(NOW) - Date.parse(r.ended_at)) / 3_600_000 / JOB_INTERVAL_HOURS[r.job];
    for (const r of buildScenario("stale", NOW).runs) expect(age(r)).toBeGreaterThan(2);
    for (const r of buildScenario("populated", NOW).runs) expect(age(r)).toBeLessThan(1);
  });

  it("rejects an unknown scenario", () => {
    expect(() => buildScenario("nope", NOW)).toThrow(/unknown scenario/);
  });

  it("applies to the real migrated schema", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-"));
    const url = pathToFileURL(path.join(dir, "main.db")).href;
    const r = spawnSync(process.execPath, ["scripts/db/migrate.mjs", "--db", "main"], {
      cwd: root,
      env: { ...process.env, TURSO_MAIN_URL: url, TURSO_AUTH_URL: url },
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    const client = createClient({ url });
    try {
      const out = await applyScenario(client, "populated", NOW);
      const n = await client.execute("SELECT COUNT(*) AS n FROM price_bar");
      expect(Number(n.rows[0].n)).toBe(out.bars);
      const rr = await client.execute("SELECT COUNT(*) AS n FROM run_record");
      expect(Number(rr.rows[0].n)).toBe(out.runs);
    } finally {
      client.close();
    }
  });
});
