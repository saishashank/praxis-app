// @vitest-environment node
// D-1068 (Owner O-84): the edges of `replay --mode pick-scorecard` and of the run behind it: bad
// arguments, missing database or snapshot source, a failing snapshot, a snapshot with nothing to score,
// a run where only some nights can be scored (partial), parameters read from the database, and an
// injected database opener. Synthetic ZZ data; the output carries counts and statuses only.
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { defaultAgentParams } from "@/lib/agents/params";
import { replayMain } from "@/lib/replay/cli";
import { buildSnapshot } from "@/lib/replay/snapshot";
import { runPickScorecard } from "@/lib/scorecard/pickScorecardRun";
import { loadLatestScorecard } from "@/lib/scorecard/pickScorecardStore";
import { cleanupTempDbs, freshDb, MIGRATIONS, tempDbUrl, track } from "../db/helpers";
import { weekdayCalendar } from "../fixtures/stats/t13";
import { loadMigrations, migrateUp } from "@/lib/db/migrate-core.mjs";

afterEach(cleanupTempDbs);

const params = defaultAgentParams();
const CAL = weekdayCalendar(4, "2026-01-05");

/** Four sessions; the codes have a bar on the first `barDays` of them only. */
function tinySnapshot(barDays: number): Uint8Array {
  const codes = ["ZZ01", "ZZ02", "ZZ03"];
  const bars: Record<string, unknown>[] = [];
  const universe = codes.map((code) => ({
    d: CAL[0],
    code,
    status: "active",
    tier: "U1",
    mcap_est: 1e9,
    adv: 5e7,
    halted: 0,
  }));
  codes.forEach((code, k) => {
    CAL.slice(0, barDays).forEach((d, i) => {
      const c = Number((5 + k + i * (k % 2 === 0 ? 0.1 : -0.1)).toFixed(3));
      bars.push({
        code,
        d,
        o: c,
        h: Number((c * 1.01).toFixed(3)),
        l: Number((c * 0.99).toFixed(3)),
        c,
        volume: 1_000_000,
      });
    });
  });
  const index_bars = CAL.map((d, i) => {
    const m = (7000 + i) * 1e6;
    return { index_code: "AXJO", d, o_micro: m, h_micro: m, l_micro: m, c_micro: m };
  });
  const calendar = CAL.map((d) => ({ d, kind: "session", close_time: null, confirmed: 1 }));
  return buildSnapshot({
    from: CAL[0]!,
    to: CAL[CAL.length - 1]!,
    inputs: { calendar, universe, bars, index_bars, corporate_actions: [], announcements: [] },
  }).bytes;
}

async function fileDb(): Promise<string> {
  const url = tempDbUrl();
  const seed = track(createClient({ url }));
  await migrateUp(seed, await loadMigrations(MIGRATIONS("main")));
  return url;
}

const collect = () => {
  const lines: string[] = [];
  return { lines, out: (s: string) => lines.push(s) };
};

describe("pick-scorecard CLI arguments and set-up", () => {
  it("a date that is not real, or --sessions without a value, is a bad argument", async () => {
    const { lines, out } = collect();
    expect(
      await replayMain(["--mode", "pick-scorecard", "--date", "2026-13-45"], {}, { out }),
    ).toBe(2);
    expect(await replayMain(["--mode", "pick-scorecard", "--date", "soon"], {}, { out })).toBe(2);
    expect(await replayMain(["--mode", "pick-scorecard", "--sessions"], {}, { out })).toBe(2);
    expect(lines).toEqual(Array(3).fill("replay: failed (bad argument)"));
  });

  it("a remote database without a token is not configured; no URL is not configured either", async () => {
    const { lines, out } = collect();
    const argv = ["--mode", "pick-scorecard", "--date", "2026-11-12"];
    expect(await replayMain(argv, { TURSO_MAIN_URL: "libsql://x.example.test" }, { out })).toBe(1);
    expect(await replayMain(argv, {}, { out })).toBe(1);
    expect(await replayMain(argv, { TURSO_MAIN_URL: "" }, { out })).toBe(1);
    expect(lines).toEqual(Array(3).fill("replay: failed (database not configured)"));
  });

  it("a local file database needs no token, but a snapshot source is required", async () => {
    const url = await fileDb();
    const { lines, out } = collect();
    const code = await replayMain(
      ["--mode", "pick-scorecard", "--date", "2026-11-12"],
      { TURSO_MAIN_URL: url },
      { out },
    );
    expect(code).toBe(1);
    expect(lines.at(-1)).toBe("replay: failed (no snapshot source)");
  });

  it("a failing snapshot names the stage and the error kind, never its message", async () => {
    const url = await fileDb();
    const { lines, out } = collect();
    const code = await replayMain(
      ["--mode", "pick-scorecard", "--date", "2026-11-12"],
      { TURSO_MAIN_URL: url },
      {
        out,
        params,
        prepareSnapshot: async () => {
          throw new TypeError("secret detail https://example.test/x");
        },
      },
    );
    expect(code).toBe(1);
    expect(lines.at(-1)).toMatch(/^replay pick-scorecard: failed \(TypeError\) stage=snapshot/);
    expect(lines.at(-1)).not.toContain("secret");
    expect(lines.at(-1)).not.toContain("example.test");
  });

  it("a snapshot with nothing to score is a failure with a plain reason", async () => {
    const url = await fileDb();
    const { lines, out } = collect();
    const code = await replayMain(
      ["--mode", "pick-scorecard", "--sessions", "3", "--date", "2026-11-12"],
      { TURSO_MAIN_URL: url, COMMIT_SHA: "d".repeat(40) },
      { out, params, prepareSnapshot: async () => tinySnapshot(1) },
    );
    expect(code).toBe(1);
    expect(lines.at(-1)).toBe("replay pick-scorecard: failed (no scorable nights)");
  });

  it("reads the parameters from the database when none are injected, and uses the opener it is given", async () => {
    const url = await fileDb();
    const { lines, out } = collect();
    let opened = 0;
    let asked: { from: string; to: string } | null = null;
    const code = await replayMain(
      ["--mode", "pick-scorecard", "--sessions", "2", "--date", "2026-11-12"],
      { TURSO_MAIN_URL: url },
      {
        out,
        openDb: (u) => {
          opened += 1;
          return track(createClient({ url: u }));
        },
        prepareSnapshot: async (range) => {
          asked = range;
          return tinySnapshot(3);
        },
        sleep: async () => {},
      },
    );
    expect(code).toBe(0);
    expect(opened).toBe(2); // one to read the parameters, a fresh one for the replay
    expect(asked!.to).toBe("2026-11-12");
    expect(asked!.from < "2026-11-12").toBe(true);
    // 4 sessions, bars on 3: of the 2 nights asked for only the first can be scored
    expect(lines.at(-1)).toMatch(
      /^replay pick-scorecard: partial sessions=2 nights=1 picks=\d+ gainers=\d+\/\d+ losers=\d+\/\d+ cortex_nights=0 minutes=[\d.]+ rows=\d+ passport_nights=\d+ cortex_abstain=\S+$/,
    );
    const check = track(createClient({ url }));
    const run = await loadLatestScorecard(check, "AU");
    expect(run).toMatchObject({ status: "partial", sessions: 2 });
    expect(run!.commitSha).toBe("0".repeat(40)); // no COMMIT_SHA given
  });
});

describe("runPickScorecard", () => {
  it("is empty when no night can be scored and writes nothing", async () => {
    const db = await freshDb("main");
    const r = await runPickScorecard({
      db,
      params,
      snapshotBytes: tinySnapshot(1),
      sessions: 3,
      commitSha: "e".repeat(40),
      nowMs: () => 0,
    });
    expect(r).toEqual({ kind: "empty" });
    expect(
      Number((await db.execute("SELECT COUNT(*) AS n FROM pick_scorecard_run")).rows[0]!.n),
    ).toBe(0);
  });

  it("a night whose next session has no bars leaves the run partial; a repeat is 'already'", async () => {
    const db = await freshDb("main");
    const o = {
      db,
      params,
      snapshotBytes: tinySnapshot(3),
      sessions: 2,
      commitSha: "e".repeat(40),
      nowMs: () => Date.parse("2026-11-16T00:00:00Z"),
    };
    const r = await runPickScorecard(o);
    expect(r.kind).toBe("recorded");
    if (r.kind !== "recorded") return;
    expect(r.run.status).toBe("partial");
    expect(r.run.summary.days).toBe(1);
    expect(r.run.createdAt).toBe("2026-11-16T00:00:00.000Z");
    expect((await runPickScorecard(o)).kind).toBe("already");
  });
});
