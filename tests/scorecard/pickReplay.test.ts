// @vitest-environment node
// D-1060…D-1069 (Owner O-84): the night-by-night replay on a small synthetic snapshot (ZZ codes,
// invented numbers) and a migrated database.
//   * as-of guard: a bar dated d+1 (or any later one) cannot change the picks or the Cortex night of d;
//   * report only: after a run every table except the two scorecard tables and the trial ledger has the
//     same number of rows as before, and the ledger gains exactly ONE `report_look`;
//   * the CLI: argument parsing, a recorded run, an idempotent repeat.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { defaultAgentParams } from "@/lib/agents/params";
import { replayMain, SCORECARD_MODE } from "@/lib/replay/cli";
import { loadSnapshot } from "@/lib/replay/snapshot";
import { buildSnapshot } from "@/lib/replay/snapshot";
import { SnapshotWorld } from "@/lib/replay/snapshotWorld";
import {
  barsUpTo,
  featureNightOf,
  inputsAsOf,
  openReplay,
  passportsAsOf,
  replayNights,
} from "@/lib/scorecard/pickReplay";
import { angleById } from "@/lib/cortex/angles/registry";
import { insertPassport } from "@/lib/cortex/store";
import { createCortexReplay } from "@/lib/replay/cortexReplay";
import { parseSessions } from "@/lib/scorecard/pickScorecardRun";
import { loadLatestScorecard } from "@/lib/scorecard/pickScorecardStore";
import { trialCounts } from "@/lib/stats/splits";
import { cleanupTempDbs, freshDb, MIGRATIONS, tempDbUrl, track } from "../db/helpers";
import { weekdayCalendar } from "../fixtures/stats/t13";
import { loadMigrations, migrateUp } from "@/lib/db/migrate-core.mjs";

const params = defaultAgentParams();
const CODES = Array.from({ length: 24 }, (_, i) => `ZZ${String(i + 1).padStart(2, "0")}`);
const SESSIONS = 420;
const CAL = weekdayCalendar(SESSIONS, "2026-01-05");
/** The night the guard test replays; the sessions after it are the ones that get perturbed. */
const GUARD_D = CAL[SESSIONS - 6]!;

function snapshotBytes(perturbAfter: string | null): Uint8Array {
  let seed = 4242;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const bars: Record<string, unknown>[] = [];
  const universe: Record<string, unknown>[] = [];
  CODES.forEach((code, k) => {
    let c = 5 + rnd() * 5;
    universe.push({
      d: CAL[0],
      code,
      status: "active",
      tier: "U1",
      mcap_est: 1e9,
      adv: 5e7,
      halted: 0,
    });
    for (const d of CAL) {
      const o = c;
      // a gentle drift up with a code-specific slope, so the trend rule has setups to find
      c = Math.max(0.5, c * (1 + 0.0025 * (1 + (k % 5)) + (rnd() - 0.5) * 0.02));
      if (perturbAfter !== null && d > perturbAfter) c = o * (k % 2 === 0 ? 1.6 : 0.4);
      const h = Math.max(o, c) * 1.004;
      const l = Math.min(o, c) * 0.996;
      bars.push({
        code,
        d,
        o: Number(o.toFixed(3)),
        h: Number(h.toFixed(3)),
        l: Number(l.toFixed(3)),
        c: Number(c.toFixed(3)),
        volume: Math.round(5_000_000 * (0.5 + rnd())),
      });
    }
  });
  let idx = 7000;
  const index_bars = CAL.map((d) => {
    idx *= 1 + (rnd() - 0.48) * 0.01;
    const m = Math.round(idx * 1e6);
    return { index_code: "AXJO", d, o_micro: m, h_micro: m, l_micro: m, c_micro: m };
  });
  const calendar = CAL.map((d) => ({ d, kind: "session", close_time: null, confirmed: 1 }));
  return buildSnapshot({
    from: CAL[0]!,
    to: CAL[CAL.length - 1]!,
    inputs: { calendar, universe, bars, index_bars, corporate_actions: [], announcements: [] },
  }).bytes;
}

let bytes: Uint8Array;
let bytesPerturbed: Uint8Array;
beforeAll(() => {
  bytes = snapshotBytes(null);
  bytesPerturbed = snapshotBytes(GUARD_D);
}, 60_000);
afterAll(cleanupTempDbs);

const worldOf = (b: Uint8Array) =>
  new SnapshotWorld(loadSnapshot(b), { params, tierSource: "bars" });

/** Three scored angles the synthetic bars can compute, active since before every night. */
async function seedPassports(db: Client, frozenAt = "2026-01-01T00:00:00.000Z"): Promise<void> {
  for (const id of ["A-D1-02", "A-D2-01", "A-D1-06"]) {
    const a = angleById(id)!;
    await insertPassport(db, {
      market: "AU",
      angleId: id,
      version: 1,
      domain: a.domain,
      cluster: a.cluster as never,
      orientation: a.orientation,
      kind: "score",
      inputs: [...a.inputs],
      historyFields: {},
      status: "active",
      horizonSessions: a.horizonSessions,
      evidence: {},
      measured: null,
      frozenAt,
    });
  }
}

/** bigint-safe canonical text of a value. */
const text = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x instanceof Map ? [...x] : x));

describe("nights", () => {
  it("the last N sessions that have a following one; the newest session is never a night", () => {
    const s = ["a", "b", "c", "d", "e"];
    expect(replayNights(s, 2)).toEqual(["c", "d"]);
    expect(replayNights(s, 40)).toEqual(["a", "b", "c", "d"]);
  });

  it("barsUpTo stops at d", () => {
    const b = (d: string) => ({ d, open: 1n, high: 1n, low: 1n, close: 1n, volume: 1n });
    expect(barsUpTo([b("1"), b("2"), b("3")], "2").map((x) => x.d)).toEqual(["1", "2"]);
    expect(barsUpTo([b("1")], "0")).toEqual([]);
  });
});

describe("as-of guard", () => {
  it("a bar dated d+1 or later cannot change the inputs or the Cortex night of d", async () => {
    const db = await freshDb("main");
    await seedPassports(db);
    const a = worldOf(bytes);
    const b = worldOf(bytesPerturbed);
    // the two worlds really differ after the guard night, and only there
    expect(a.bar("ZZ01", GUARD_D)).toEqual(b.bar("ZZ01", GUARD_D));
    const next = CAL[CAL.indexOf(GUARD_D) + 1]!;
    expect(a.bar("ZZ01", next)).not.toEqual(b.bar("ZZ01", next));

    const openedA = await openReplay({ db, world: a, params });
    const openedB = await openReplay({ db, world: b, params });
    const ia = await inputsAsOf({ db, world: a, params }, openedA, GUARD_D);
    const ib = await inputsAsOf({ db, world: b, params }, openedB, GUARD_D);
    expect(ia.universe.length).toBeGreaterThan(10); // the night is not empty
    expect(ia.inputs.length).toBeGreaterThan(0); // and it has pick inputs, so equality is not vacuous
    expect(text(ib)).toEqual(text(ia));

    const passports = await passportsAsOf(db, "AU", GUARD_D);
    expect(passports.size).toBe(3);
    const cx = (world: SnapshotWorld, live: typeof params) =>
      createCortexReplay({ world, params: live, passports, schemaSha: "fixed" });
    const na = cx(a, openedA.live).hook.night(GUARD_D, []);
    const nb = cx(b, openedB.live).hook.night(GUARD_D, []);
    const fa = featureNightOf(na, GUARD_D);
    expect(fa).not.toBeNull();
    expect(Object.keys(fa!.rows[0]!.features).length).toBeGreaterThan(0); // the Cortex really scored
    expect(text(featureNightOf(nb, GUARD_D))).toEqual(text(fa));
  }, 120_000);
});

describe("pick-scorecard CLI", () => {
  it("parses --sessions: default 40, 1 to 60, anything else is refused", () => {
    expect(parseSessions(null)).toBe(40);
    expect(parseSessions("1")).toBe(1);
    expect(parseSessions("60")).toBe(60);
    for (const bad of ["0", "61", "4.5", "x", "-3"]) expect(parseSessions(bad)).toBeNull();
    expect(SCORECARD_MODE).toBe("pick-scorecard");
  });

  async function tables(db: Client): Promise<Map<string, number>> {
    const names = (
      await db.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
    ).rows.map((r) => String(r.name));
    const out = new Map<string, number>();
    for (const n of names) {
      const r = await db.execute(`SELECT COUNT(*) AS n FROM "${n}"`);
      out.set(n, Number(r.rows[0]!.n));
    }
    return out;
  }

  const EXPECT_CHANGED = new Set(["pick_scorecard_run", "pick_scorecard_day", "trial_ledger"]);

  it("a bad argument is a usage error; the mode is listed in the usage text", async () => {
    const lines: string[] = [];
    const out = (s: string) => lines.push(s);
    expect(await replayMain(["--mode", "nope"], {}, { out })).toBe(2);
    expect(lines[0]).toContain("pick-scorecard");
    expect(await replayMain(["--mode", "pick-scorecard", "--sessions", "99"], {}, { out })).toBe(2);
    expect(await replayMain(["--mode", "pick-scorecard", "--sessions"], {}, { out })).toBe(2);
    expect(lines.at(-1)).toBe("replay: failed (bad argument)");
    expect(await replayMain(["--mode", "pick-scorecard"], {}, { out })).toBe(1); // no database
  });

  it("records one run, writes nothing else but one report-only look, and a repeat is a no-op", async () => {
    const url = tempDbUrl();
    const seed = track(createClient({ url }));
    await migrateUp(seed, await loadMigrations(MIGRATIONS("main")));
    await seedPassports(seed);
    const before = await tables(seed);
    const lines: string[] = [];
    const deps = {
      out: (s: string) => lines.push(s),
      nowMs: () => Date.parse("2026-09-01T00:00:00Z"),
      prepareSnapshot: async () => bytes,
      params,
    };
    const env = { TURSO_MAIN_URL: url, COMMIT_SHA: "c".repeat(40) };
    expect(await replayMain(["--mode", "pick-scorecard", "--sessions", "8"], env, deps)).toBe(0);
    expect(lines.at(-1)).toMatch(
      /^replay pick-scorecard: complete sessions=8 nights=8 picks=\d+ gainers=\d+\/\d+ losers=\d+\/\d+ cortex_nights=\d+ minutes=[\d.]+ rows=\d+$/,
    );
    expect(lines.at(-1)).not.toMatch(/ZZ\d\d/); // statuses and counts only: no stock code

    const check = track(createClient({ url }));
    const after = await tables(check);
    for (const [name, n] of before) {
      if (EXPECT_CHANGED.has(name)) continue;
      expect([name, after.get(name)]).toEqual([name, n]); // nothing else was written
    }
    expect(after.get("pick_scorecard_run")).toBe(1);
    expect(after.get("pick_scorecard_day")).toBe(8);
    const ledger = await check.execute(
      "SELECT kind, lineage_id, variant, run_id FROM trial_ledger",
    );
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]).toMatchObject({ kind: "report_look", variant: "pick-scorecard" });
    // the look spends no budget and uses no holdout
    const rows = (await check.execute("SELECT * FROM trial_ledger")).rows.map((r) => ({
      id: String(r.id),
      market: String(r.market),
      lineage_id: String(r.lineage_id),
      split_version: Number(r.split_version),
      kind: String(r.kind) as "report_look",
      rule_version: null,
      variant: String(r.variant),
      run_id: String(r.run_id),
      d: String(r.d),
    }));
    const lineage = rows[0]!.lineage_id;
    expect(trialCounts(rows, lineage, 0)).toMatchObject({ total: 0, holdoutAccesses: 0 });

    const run = await loadLatestScorecard(check, "AU");
    expect(run).toMatchObject({ sessions: 8, status: "complete" });
    expect(run!.summary.days).toBe(8);
    expect(run!.summary.gainers.total).toBeGreaterThan(0);
    expect(run!.summary.cortex.days).toBeGreaterThan(0);

    lines.length = 0;
    expect(await replayMain(["--mode", "pick-scorecard", "--sessions", "8"], env, deps)).toBe(0);
    expect(lines.at(-1)).toBe("replay pick-scorecard: already recorded");
    const again = await tables(track(createClient({ url })));
    expect(again.get("pick_scorecard_run")).toBe(1);
    expect(again.get("trial_ledger")).toBe(1);
  }, 180_000);
});
