// @vitest-environment node
// Committee CLI (M22 C1; AGT-145, AGT-132; D-1417, D-504 pattern): refuses a replay flag and a date that is not the current
// session, runs only after a reviewed night with the switch on and a pre-registration, writes `skipped_models` rows while
// no role is live (rules-only production), exits 0 and says `degraded` on a failure, prints statuses and counts only.
import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { committeeMain, readKeys, routesLive } from "@/lib/committee/cli";
import { loadAgentParams } from "@/lib/agents/params";
import { loadMigrations, migrateUp } from "@/lib/db/migrate-core.mjs";
import { cleanupTempDbs, MIGRATIONS, tempDbUrl, track } from "../db/helpers";
import { committeeLlm, committeeProvider, count, D, seedNight, seedTrial } from "./harness";

afterEach(cleanupTempDbs);

const TODAY = Date.parse("2026-03-04T08:00:00.000Z"); // 19:00 in the market, before the 19:05 stop
const SECRET = "secret-token-do-not-print";

async function fullNight(
  over: { switchOn?: boolean; trial?: boolean; reviewed?: boolean; mode?: string } = {},
) {
  const url = tempDbUrl();
  const db = track(createClient({ url }));
  await migrateUp(db, await loadMigrations(MIGRATIONS("main")));
  await db.execute({
    sql: "UPDATE market SET mode = ? WHERE code = 'AU'",
    args: [over.mode ?? "full"],
  });
  await seedNight(db);
  if (over.reviewed !== false)
    await db.execute({
      sql: `INSERT INTO run_record (job, market, concurrency_key, scheduled_for, started_at, ended_at, status)
          VALUES ('arena-review', 'AU', ?, ?, ?, ?, 'success')`,
      args: [`arena-3:AU:${D}`, D, `${D}T08:00:00.000Z`, `${D}T08:05:00.000Z`],
    });
  if (over.switchOn !== false)
    await db.execute(
      `INSERT INTO config_version (key, scope, value_json, changed_at) VALUES ('committee_enabled', 'global', '"on"', '2026-03-01T00:00:00Z')`,
    );
  if (over.trial !== false) await seedTrial(db);
  return { url, db };
}

const run = async (
  url: string,
  args: string[] = [],
  deps: Parameters<typeof committeeMain>[2] = {},
) => {
  const lines: string[] = [];
  const code = await committeeMain(
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

describe("committee CLI", () => {
  it("rules-only production with the switch on: a skipped_models row per shortlisted signal, no model, exit 0", async () => {
    const { url, db } = await fullNight();
    const r = await run(url);
    expect(r.code).toBe(0);
    expect(r.lines).toEqual([
      "arena-committee AU 2026-03-04: done requested=3 rated=0 skipped_budget=0 skipped_time=0 skipped_models=3 failed=0 already_done=0",
    ]);
    expect(r.lines.join("\n")).not.toContain(SECRET);
    const rows = (await db.execute("SELECT rating FROM committee_rating")).rows;
    expect(rows.map((x) => x.rating)).toEqual([
      "skipped_models",
      "skipped_models",
      "skipped_models",
    ]);
    expect(await count(db, "committee_call")).toBe(0);
    expect(await count(db, "opinion_track")).toBe(0);
    // a re-run adds nothing
    expect((await run(url)).code).toBe(0);
    expect(await count(db, "committee_rating")).toBe(3);
  });

  it("the switch off (the default): says so and writes nothing", async () => {
    const { url, db } = await fullNight({ switchOn: false });
    const r = await run(url);
    expect(r.lines[0]).toContain(": off requested=0");
    expect(await count(db, "committee_rating")).toBe(0);
  });

  it("with both roles reported live and providers injected: rated, with the model calls stored", async () => {
    const { url, db } = await fullNight();
    const a = committeeProvider("alpha");
    const b = committeeProvider("beta");
    const r = await run(url, [], {
      routes: () => ({ R6: true, R7: true }),
      llm: (ctx) => committeeLlm([a, b], undefined, ctx.params.llm),
    });
    expect(r.lines[0]).toContain("done requested=3 rated=3");
    expect(await count(db, "committee_call")).toBe(12);
    expect(a.calls.length + b.calls.length).toBe(12);
  });

  it("refuses every replay flag without opening the database", async () => {
    for (const flag of ["--replay", "--recorded", "--recorded-day"]) {
      const lines: string[] = [];
      const code = await committeeMain(
        ["--date", D, flag],
        { TURSO_MAIN_URL: "file:never-opened.db" },
        {
          nowMs: () => TODAY,
          out: (s) => lines.push(s),
          openDb: () => {
            throw new Error("opened");
          },
        },
      );
      expect(code).toBe(0);
      expect(lines).toEqual([
        "arena-committee: refused (a replay or recorded-day run; the Committee is forward only)",
      ]);
    }
  });

  it("refuses a past date and writes nothing", async () => {
    const { url, db } = await fullNight();
    const r = await run(url, ["--date", "2026-03-03"]);
    expect(r).toEqual({
      code: 0,
      lines: ["arena-committee AU 2026-03-03: refused (not the current session; forward only)"],
    });
    expect(await count(db, "committee_rating")).toBe(0);
  });

  it("writes nothing without a reviewed night, a full-mode market or a pre-registration", async () => {
    const noTrial = await fullNight({ trial: false });
    expect((await run(noTrial.url)).lines[0]).toContain(": no_trial requested=0");
    expect(await count(noTrial.db, "committee_rating")).toBe(0);

    const shadow = await fullNight({ mode: "data_only" });
    expect(await run(shadow.url)).toEqual({ code: 0, lines: [] });
    expect(await count(shadow.db, "committee_rating")).toBe(0);

    const unreviewed = await fullNight({ reviewed: false });
    expect(await run(unreviewed.url)).toEqual({
      code: 0,
      lines: ["arena-committee AU 2026-03-04: skipped (no reviewed night)"],
    });
    expect(await count(unreviewed.db, "committee_rating")).toBe(0);
  });

  it("a failure in the stage exits 0 with `degraded`", async () => {
    const { url, db } = await fullNight();
    await db.execute("DROP TABLE committee_prereg");
    const r = await run(url);
    expect(r.code).toBe(0);
    expect(r.lines.join("\n")).toContain("degraded");
  });

  it("an unconfigured database exits 0 with `degraded`", async () => {
    const lines: string[] = [];
    const code = await committeeMain([], {}, { out: (s) => lines.push(s) });
    expect({ code, lines }).toEqual({
      code: 0,
      lines: ["arena-committee: degraded (database not configured)"],
    });
  });

  it("a database that cannot be opened exits 0 with `degraded`", async () => {
    const lines: string[] = [];
    const code = await committeeMain(
      [],
      { TURSO_MAIN_URL: "file:x" },
      {
        out: (s) => lines.push(s),
        openDb: () => {
          throw new Error("no");
        },
      },
    );
    expect({ code, lines }).toEqual({
      code: 0,
      lines: ["arena-committee: degraded (cannot open database)"],
    });
  });
});

describe("keys and the routes seam", () => {
  it("routesLive says neither role is live until tasks L1 and L4 wire the factory", () => {
    expect(routesLive()).toEqual({ R6: false, R7: false });
  });

  it("reads the registry defaults, then the stored values; an invalid stored value falls back to the default", async () => {
    const { db } = await fullNight({ switchOn: false });
    const params = await loadAgentParams(db as Client);
    expect(await readKeys(db, params)).toMatchObject({
      enabled: false,
      shortlist: 3,
      retentionMonths: 18,
    });
    await db.execute(
      `INSERT INTO config_version (key, scope, value_json, changed_at) VALUES ('committee_enabled', 'global', '"on"', '2026-03-01T00:00:00Z')`,
    );
    await db.execute(
      `INSERT INTO config_version (key, scope, value_json, changed_at) VALUES ('committee_shortlist', 'global', '2', '2026-03-01T00:00:00Z')`,
    );
    await db.execute(
      `INSERT INTO config_version (key, scope, value_json, changed_at) VALUES ('committee_call_record_retention_months', 'global', '9999', '2026-03-01T00:00:00Z')`,
    );
    expect(await readKeys(db, params)).toMatchObject({
      enabled: true,
      shortlist: 2,
      retentionMonths: 18,
    });
  });
});
