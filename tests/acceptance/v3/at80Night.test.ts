// @vitest-environment node
// AT-80 (nightly wiring part, M22 L4; LLM-077, D-1412, D-1460, D-1466, D-1492): the three night stages that may call a model
// (steelman, reflections, Committee) run through their real entries with the three model keys present and `llm_live_roles`
// empty (or unreadable): not one provider request is made, and the stages say the models are not available tonight.
import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { committeeMain, nightCommitteeLlm, routesLive } from "@/lib/committee/cli";
import { defaultAgentParams } from "@/lib/agents/params";
import { loadMigrations, migrateUp } from "@/lib/db/migrate-core.mjs";
import { reflectMain, routesLive as reflectRoutesLive } from "@/lib/steelman/reflectCli";
import { steelmanMain } from "@/lib/steelman/cli";
import { cleanupTempDbs, MIGRATIONS, tempDbUrl, track } from "../../db/helpers";
import { D as COMMITTEE_D, seedNight as seedCommittee, seedTrial } from "../../committee/harness";
import {
  RUN_NOW as REFLECT_NOW,
  seedNight as seedReflect,
  settlePick,
  SETTLED_D,
} from "../../steelman/reflectHarness";

const net = vi.fn();
const KEYS = {
  GROQ_API_KEY: "test-key",
  GOOGLE_AI_API_KEY: "test-key",
  OPENROUTER_API_KEY: "test-key",
};
beforeEach(() => {
  net.mockReset();
  vi.stubGlobal("fetch", net);
  for (const [k, v] of Object.entries(KEYS)) vi.stubEnv(k, v);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  cleanupTempDbs();
});

async function freshFull(): Promise<{ url: string; db: Client }> {
  const url = tempDbUrl();
  const db = track(createClient({ url }));
  await migrateUp(db, await loadMigrations(MIGRATIONS("main")));
  await db.execute("UPDATE market SET mode = 'full' WHERE code = 'AU'");
  return { url, db };
}

const reviewed = (db: Client, d: string) =>
  db.execute({
    sql: `INSERT INTO run_record (job, market, concurrency_key, scheduled_for, started_at, ended_at, status)
          VALUES ('arena-review', 'AU', ?, ?, ?, ?, 'success')`,
    args: [`arena-3:AU:${d}`, d, `${d}T08:00:00.000Z`, `${d}T08:05:00.000Z`],
  });

const setList = (db: Client, json: string) =>
  db.execute({
    sql: `INSERT INTO config_version (key, scope, value_json, changed_at) VALUES ('llm_live_roles', 'global', ?, '2026-03-01T00:00:00Z')`,
    args: [json],
  });

const env = (url: string) => ({ TURSO_MAIN_URL: url, TURSO_MAIN_TOKEN: "x", ...KEYS });
const openDb = (u: string): Client => createClient({ url: u });

describe("AT-80 night: keys present, nothing listed, no provider request", () => {
  for (const [label, list] of [
    ["an empty list", "[]"],
    ["a list that is not a list of names", '{"R6":true}'],
    ["roles listed without a passing test run", '["R6","R7"]'],
  ] as const) {
    it(`Committee, reflections and steelman with ${label}`, async () => {
      const { url, db } = await freshFull();
      await seedCommittee(db);
      await seedTrial(db);
      await reviewed(db, COMMITTEE_D);
      await db.execute(
        `INSERT INTO config_version (key, scope, value_json, changed_at) VALUES ('committee_enabled', 'global', '"on"', '2026-03-01T00:00:00Z')`,
      );
      await setList(db, list);
      const lines: string[] = [];
      const nowMs = () => Date.parse("2026-03-04T08:00:00.000Z");
      const out = (s: string) => lines.push(s);
      expect(await committeeMain([], env(url), { nowMs, out, openDb })).toBe(0);
      expect(lines.join("\n")).toMatch(/skipped_models=3/);
      expect(await steelmanMain([], env(url), { nowMs, out, openDb })).toBe(0);
      expect(net).not.toHaveBeenCalled();
    });
  }

  it("the reflection stage writes not_written rows and makes no request", async () => {
    const { url, db } = await freshFull();
    await seedReflect(db);
    await settlePick(db);
    await reviewed(db, SETTLED_D);
    await setList(db, "[]");
    const lines: string[] = [];
    const code = await reflectMain([], env(url), {
      nowMs: () => Date.parse(REFLECT_NOW),
      out: (s) => lines.push(s),
      openDb,
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/written=0/);
    expect(net).not.toHaveBeenCalled();
  });

  it("an unreadable list: both Committee roles and the reflection role are not live", () => {
    expect(routesLive({ liveRoles: null })).toEqual({ R6: false, R7: false });
    expect(routesLive({ liveRoles: undefined })).toEqual({ R6: false, R7: false });
    expect(reflectRoutesLive({ liveRoles: null })).toEqual({ R6: false });
    expect(routesLive({ liveRoles: ["R6", "R7"], env: KEYS })).toEqual({ R6: false, R7: false });
  });

  it("a selection of a provider that does not exist gives no router (rules-only night)", async () => {
    const { db } = await freshFull();
    const llm = nightCommitteeLlm({
      db,
      params: defaultAgentParams(),
      kbVersion: "kb1",
      liveRoles: [],
      env: KEYS,
    });
    expect(llm.providers).toEqual([]);
    expect(llm.routerFor("R6")).not.toBeNull();
    expect(llm.routerFor("R6", { only: "groq" })).toBeNull();
    expect(llm.routerFor("R7", { avoid: ["groq"] })).toBeNull();
    expect(net).not.toHaveBeenCalled();
  });
});
