// @vitest-environment node
// D-1020..D-1022 (Owner O-82): the live arena's second round starts with A$5,000 and up to 6
// positions. The switch happens once, at a fixed date, through the normal terminal and restart path;
// a night before the date replays exactly as before (A$600, no verdict).
import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildExecutionRegistry,
  parseCohortParams,
  planInitialStart,
  resolveCohortParams,
  roundOverridesFor,
  roundSwitchDue,
  ROUND2_FIRST_START_D,
  ROUND2_MAX_OPEN_POSITIONS,
  ROUND2_SEED_MICRO,
  SEED_MICRO,
} from "@/lib/arena/cohort";
import {
  loadCohort,
  runTerminalChecks,
  seedExecutions,
  startCohorts,
  type RestartConfig,
} from "@/lib/arena/cohortWriter";
import { planLegs, type Leg, type SizingContext } from "@/lib/agents/candidates";
import { loadMigrations, migrateUp } from "@/lib/db/migrate-core.mjs";
import { cleanupTempDbs, MIGRATIONS, tempDbUrl, track } from "../db/helpers";

afterEach(cleanupTempDbs);

const MASTER = 20_261_011n;
const registry = buildExecutionRegistry();
const exec = new Map(registry.map((e) => [e.id, e]));
const RESTART: RestartConfig = {
  executionFor: (id) => exec.get(id)!,
  paramsFor: (_e, startD) => resolveCohortParams(roundOverridesFor(startD)),
  masterSeed: MASTER,
};

describe("round constants", () => {
  it("round 1 keeps A$600 and the 2-position default; round 2 is A$5,000 and 6", () => {
    expect(SEED_MICRO).toBe(600_000_000n);
    expect(resolveCohortParams().seedMicro).toBe(600_000_000n);
    expect(resolveCohortParams().maxOpenPositions).toBe(2);
    expect(roundOverridesFor("2026-11-13")).toEqual({});
    expect(roundOverridesFor(ROUND2_FIRST_START_D)).toEqual({
      seedMicro: ROUND2_SEED_MICRO,
      maxOpenPositions: ROUND2_MAX_OPEN_POSITIONS,
    });
    const p = resolveCohortParams(roundOverridesFor("2026-12-01"));
    expect(p.seedMicro).toBe(5_000_000_000n);
    // the goal (twice the seed) and the loss limit (half) scale with it: A$10,000 and A$2,500
    expect(p.terminal.seedMicro).toBe(5_000_000_000n);
  });

  it("roundSwitchDue: only an A$600 cohort, only once its successor would start in round 2", () => {
    // Wed 11 Nov: liquidation Fri 13, successor Mon 16 is NOT before the date, so Wed is too early
    expect(roundSwitchDue("2026-11-02", "2026-11-11", [])).toBe(false);
    // Thu 12 Nov: liquidation Fri 13, successor Mon 16 = the first round-2 session
    expect(roundSwitchDue("2026-11-02", "2026-11-12", [])).toBe(true);
    expect(roundSwitchDue("2026-11-02", "2026-11-20", [])).toBe(true); // a late deploy still switches
    // a round-2 cohort never matches again (the switch is once)
    expect(roundSwitchDue("2026-11-16", "2026-11-20", [])).toBe(false);
  });
});

describe("the nightly switch through runTerminalChecks", () => {
  async function dbWith(startD: string): Promise<Client> {
    const db = track(createClient({ url: tempDbUrl(), intMode: "bigint" }));
    await migrateUp(db, await loadMigrations(MIGRATIONS("main")));
    await seedExecutions(db, registry);
    await startCohorts(
      db,
      planInitialStart({
        registry,
        startD,
        paramsFor: () => resolveCohortParams(),
        masterSeed: MASTER,
        controlsPerFamily: 1,
      }),
    );
    return db;
  }
  async function nav(db: Client, id: string, d: string): Promise<void> {
    await db.execute({
      sql: `INSERT INTO nav_daily (cohort_id, d, cash_settled_micro, recv_micro, pay_micro,
              positions_micro, div_recv_micro, sleeve_margin_micro, sleeve_unreal_micro,
              fin_accrued_micro, nav_micro, liq_nav_micro, open_positions, invariants_ok)
            VALUES (?, ?, 600000000, 0, 0, 0, 0, 0, 0, 0, 600000000, 600000000, 0, 1)`,
      args: [id, d],
    });
  }
  const E01 = "E01@2026-11-02";

  it("does nothing the night before the switch date (replay of an old night is unchanged)", async () => {
    const db = await dbWith("2026-11-02");
    await nav(db, E01, "2026-11-11");
    const r = await runTerminalChecks(db, [E01], {
      d: "2026-11-11",
      calendar: [],
      signalsThroughD: "2026-11-10",
      restart: RESTART,
    });
    expect(r.resolved).toHaveLength(0);
    expect(r.written).toBe(false);
  });

  it("ends the A$600 round once, restarts the group on 16 Nov with A$5,000 and 6 positions, writes the event", async () => {
    const db = await dbWith("2026-11-02");
    await nav(db, E01, "2026-11-12");
    const input = {
      d: "2026-11-12",
      calendar: [],
      signalsThroughD: "2026-11-11",
      restart: RESTART,
    };
    const r = await runTerminalChecks(db, [E01], input);
    expect(r.resolved.map((x) => [x.cohort.id, x.verdict.kind, x.verdict.rule])).toEqual([
      [E01, "timeout", "round_switch"],
    ]);
    expect(r.restarts[0]).toMatchObject({ group: "TW-F1", restartD: "2026-11-16" });
    expect(await loadCohort(db, E01)).toMatchObject({ terminalKind: "timeout", live: false });
    const fresh = await db.execute(
      "SELECT id, seed_micro, params_json FROM cohort WHERE start_d = '2026-11-16' ORDER BY id",
    );
    expect(fresh.rows.length).toBeGreaterThan(0);
    for (const row of fresh.rows) {
      expect(BigInt(row.seed_micro as bigint)).toBe(5_000_000_000n);
      const p = parseCohortParams(String(row.params_json));
      expect(p.seedMicro).toBe(5_000_000_000n);
      expect(p.maxOpenPositions).toBe(6);
    }
    // the old round keeps its own start of A$600 in its stored row
    const old = await db.execute({
      sql: "SELECT seed_micro FROM cohort WHERE id = ?",
      args: [E01],
    });
    expect(BigInt(old.rows[0]!.seed_micro as bigint)).toBe(600_000_000n);
    const ev = await db.execute({
      sql: "SELECT detail_json FROM cohort_event WHERE cohort_id = ? AND kind = 'terminal'",
      args: [E01],
    });
    expect(JSON.parse(String(ev.rows[0]!.detail_json))).toMatchObject({ rule: "round_switch" });
    // once: the same night again writes nothing
    const again = await runTerminalChecks(db, [E01], input);
    expect(again.written).toBe(false);
  });
});

describe("planLegs in a book with more than two slots (D-1021)", () => {
  const params = resolveCohortParams(roundOverridesFor("2026-11-16"));
  const ctx = (cash: bigint): SizingContext => ({
    params,
    cashMicro: cash,
    navMicro: cash,
    sleeveReserveMicro: 0n,
  });
  const leg = (key: string): Leg => ({
    key,
    halfSize: false,
    sleeve: false,
    env: {
      refPriceMicro: 10_000_000n,
      advValueMicro: 5_000_000_000_000n,
      adv20Shares: 100_000_000n,
      tier: "U1",
      code: key,
    },
  });

  it("one idea takes about a sixth of the cash, not all of it", () => {
    const out = planLegs(ctx(5_000_000_000n), [leg("AAA")], 6);
    expect(out).toHaveLength(1);
    expect(out[0]!.sizing.accepted).toBe(true);
    const value = out[0]!.sizing.orderValueMicro;
    expect(value).toBeGreaterThan(700_000_000n);
    expect(value).toBeLessThan(900_000_000n);
  });

  it("several ideas fill several slots, each its own size; more ideas than slots are cut", () => {
    const legs = ["A", "B", "C", "D", "E", "F", "G"].map(leg);
    const out = planLegs(ctx(5_000_000_000n), legs, 3);
    expect(out.map((r) => r.leg.key)).toEqual(["A", "B", "C"]);
    expect(out.every((r) => r.sizing.accepted)).toBe(true);
    expect(out[0]!.sizing.orderValueMicro).toBeGreaterThan(1_400_000_000n);
  });

  it("the last slot takes the rest of the cash", () => {
    const out = planLegs(ctx(900_000_000n), [leg("A")], 1);
    expect(out[0]!.sizing.orderValueMicro).toBeGreaterThan(800_000_000n);
  });
});
