// @vitest-environment node
// Reflection CLI (M22 C3; AGT-146; D-1424, D-504 pattern): refuses a replay flag and a date that is not the current session,
// runs only in full mode after a reviewed night, writes nothing when `pick_reflection_enabled` is off, writes not_written rows
// while the role is not live (rules-only production), exits 0 and says `degraded` on a failure, prints statuses and counts only.
import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateUp } from "@/lib/db/migrate-core.mjs";
import { readEnabled, reflectMain, routesLive } from "@/lib/steelman/reflectCli";
import { cleanupTempDbs, MIGRATIONS, tempDbUrl, track } from "../db/helpers";
import {
  goodAnswer,
  reflections,
  reflectLlm,
  RUN_NOW,
  scripted,
  seedNight,
  settlePick,
  SETTLED_D,
} from "./reflectHarness";

afterEach(cleanupTempDbs);

const TODAY = Date.parse(RUN_NOW);
const SECRET = "secret-token-do-not-print";

async function night(
  over: { switchOff?: boolean; reviewed?: boolean; mode?: string } = {},
): Promise<{ url: string; db: Client }> {
  const url = tempDbUrl();
  const db = track(createClient({ url }));
  await migrateUp(db, await loadMigrations(MIGRATIONS("main")));
  await db.execute({
    sql: "UPDATE market SET mode = ? WHERE code = 'AU'",
    args: [over.mode ?? "full"],
  });
  await seedNight(db);
  await settlePick(db);
  if (over.reviewed !== false)
    await db.execute({
      sql: `INSERT INTO run_record (job, market, concurrency_key, scheduled_for, started_at, ended_at, status)
            VALUES ('arena-review', 'AU', ?, ?, ?, ?, 'success')`,
      args: [
        `arena-3:AU:${SETTLED_D}`,
        SETTLED_D,
        `${SETTLED_D}T08:00:00.000Z`,
        `${SETTLED_D}T08:05:00.000Z`,
      ],
    });
  if (over.switchOff)
    await db.execute(
      `INSERT INTO config_version (key, scope, value_json, changed_at) VALUES ('pick_reflection_enabled', 'global', '"off"', '2026-03-01T00:00:00Z')`,
    );
  return { url, db };
}

const run = async (
  url: string,
  args: string[] = [],
  deps: Parameters<typeof reflectMain>[2] = {},
) => {
  const lines: string[] = [];
  const code = await reflectMain(
    args,
    { TURSO_MAIN_URL: url, TURSO_MAIN_TOKEN: SECRET },
    {
      nowMs: () => TODAY,
      out: (s) => lines.push(s),
      openDb: (u) => createClient({ url: u }),
      ...deps,
    },
  );
  return { code, lines };
};

describe("routesLive", () => {
  it("says the role is not live until the factory is wired (task L4)", () => {
    expect(routesLive()).toEqual({ R6: false });
  });
});

describe("reflectMain", () => {
  it("rules-only production: a not_written row per settled pick and no model call", async () => {
    const { url, db } = await night();
    const { code, lines } = await run(url);
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain(
      "arena-reflect AU 2026-03-12: done settled=1 written=0 not_written=1",
    );
    expect(await reflections(db)).toMatchObject([
      { state: "not_written", reason: "not available tonight" },
    ]);
  });

  it("with the role live and a router it writes the note", async () => {
    const { url, db } = await night();
    const w = scripted("alpha", goodAnswer);
    const { lines } = await run(url, [], {
      llm: () => reflectLlm([w]),
      routes: () => ({ R6: true }),
    });
    expect(lines.join("\n")).toContain("written=1");
    expect(await reflections(db)).toMatchObject([{ state: "written", provider: "alpha" }]);
    expect(w.calls).toHaveLength(1);
  });

  it("the switch off writes nothing and says off", async () => {
    const { url, db } = await night({ switchOff: true });
    const { code, lines } = await run(url);
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain(": off");
    expect(await reflections(db)).toEqual([]);
    expect(await readEnabled(db)).toBe(false);
  });

  it("the switch is on by default", async () => {
    const { db } = await night();
    expect(await readEnabled(db)).toBe(true);
  });

  it("refuses a replay flag and a date that is not the current session, and writes nothing", async () => {
    const { url, db } = await night();
    for (const flag of ["--replay", "--recorded", "--recorded-day"]) {
      const { code, lines } = await run(url, [flag]);
      expect(code).toBe(0);
      expect(lines.join("\n")).toContain("refused");
    }
    for (const d of ["2026-03-11", "2026-03-13"]) {
      const { code, lines } = await run(url, ["--date", d]);
      expect(code).toBe(0);
      expect(lines.join("\n")).toContain("refused");
    }
    expect(await reflections(db)).toEqual([]);
  });

  it("does nothing without a reviewed night or outside full mode", async () => {
    const a = await night({ reviewed: false });
    expect((await run(a.url)).lines.join("\n")).toContain("skipped (no reviewed night)");
    expect(await reflections(a.db)).toEqual([]);
    const b = await night({ mode: "data_only" });
    expect((await run(b.url)).lines).toEqual([]);
    expect(await reflections(b.db)).toEqual([]);
  });

  it("exits 0 and says degraded when the database is missing, cannot open, or a step throws", async () => {
    const lines: string[] = [];
    expect(await reflectMain([], {}, { out: (s) => lines.push(s) })).toBe(0);
    expect(lines.join("\n")).toContain("degraded (database not configured)");
    const { url } = await night();
    const bad = await run(url, [], {
      openDb: () => {
        throw new Error("no");
      },
    });
    expect(bad.code).toBe(0);
    expect(bad.lines.join("\n")).toContain("degraded (cannot open database)");
    const boom = await run(url, [], {
      llm: () => {
        throw new Error("boom");
      },
    });
    expect(boom.code).toBe(0);
    expect(boom.lines.join("\n")).toContain("degraded (unexpected error Error)");
  });

  it("prints statuses and counts only: no token, no text of a note", async () => {
    const { url } = await night();
    const { lines } = await run(url, [], {
      llm: () => reflectLlm([scripted("alpha", goodAnswer)]),
      routes: () => ({ R6: true }),
    });
    const out = lines.join("\n");
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("buy limit");
  });
});
