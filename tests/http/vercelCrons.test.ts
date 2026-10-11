// PLT-074, ch.15 `heartbeat_crons`, PLT-011: vercel.json cron entries. Hobby plan: daily crons only
// (one run a day, fired anywhere in the hour). Morning in the 00:xx UTC hour, evening in the 11:xx
// UTC hour; the watchdog stays as it was. `framework` and `git.deploymentEnabled` are untouched.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const config = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "../../vercel.json"), "utf8"),
);
const crons = config.crons as Array<{ path: string; schedule: string }>;
const byPath = (p: string) => crons.find((c) => c.path === p);

describe("vercel.json", () => {
  it("keeps framework and git.deploymentEnabled unchanged", () => {
    expect(config.framework).toBe("nextjs");
    expect(config.git).toEqual({ deploymentEnabled: false });
  });

  it("has the two heartbeats and the watchdog, each once a day", () => {
    expect(crons.map((c) => c.path).sort()).toEqual([
      "/api/cron/heartbeat-evening",
      "/api/cron/heartbeat-morning",
      "/api/cron/watchdog",
    ]);
    for (const c of crons) {
      // minute hour * * *  (a plain daily schedule: Hobby allows nothing more frequent)
      expect(c.schedule).toMatch(/^\d{1,2} \d{1,2} \* \* \*$/);
    }
  });

  it("morning fires in the 00:xx UTC hour and evening in the 11:xx UTC hour", () => {
    const hour = (p: string) => Number(byPath(p)?.schedule.split(" ")[1]);
    const minute = (p: string) => Number(byPath(p)?.schedule.split(" ")[0]);
    expect(hour("/api/cron/heartbeat-morning")).toBe(0);
    expect(hour("/api/cron/heartbeat-evening")).toBe(11);
    expect(minute("/api/cron/heartbeat-morning")).toBeLessThan(60);
    expect(minute("/api/cron/heartbeat-evening")).toBeLessThan(60);
    expect(byPath("/api/cron/watchdog")?.schedule).toBe("40 11 * * *");
  });

  it("every cron path has a route file that exports GET only", () => {
    for (const c of crons) {
      const file = path.resolve(import.meta.dirname, "../../src/app", `.${c.path}`, "route.ts");
      expect(existsSync(file)).toBe(true);
      const src = readFileSync(file, "utf8");
      expect(src).toContain("export async function GET(");
      for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
        expect(src).not.toContain(`export async function ${m}(`);
      }
    }
  });
});
