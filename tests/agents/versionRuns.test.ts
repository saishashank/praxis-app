// @vitest-environment node
// Rule versions in the money path (M6 T8; D-110 #32 and #44; D-115): batch 2b evaluates every active
// rule version, live parameters come from the rule_version rows, v1 changes nothing.
import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import { runFamilies, familyOutputJson } from "@/lib/agents/families";
import { defaultAgentParams, paramsWithVersion } from "@/lib/agents/params";
import { loadVersionSet, runVersions, versionIdOf } from "@/lib/agents/versionRuns";
import { CONFIG_KEYS, type ConfigKey } from "@/lib/config/keys";
import {
  canonicalParams,
  paramsJson,
  paramsSha,
  seedRuleVersions,
} from "@/lib/learning/ruleVersions";
import { ruleSpecJson, RULE_SCHEMA_VERSION } from "@/lib/agents/families/ruleSchema";
import { cleanupTempDbs } from "../db/helpers";
import {
  CENT,
  factsOf,
  inputsOf,
  makeBars,
  peers,
  rising,
  volumes,
} from "../fixtures/agents/families/builders";
import {
  MARKET,
  dump,
  freshReplayDb,
  runNights,
  setMode,
  startCohortsAt,
  testParams,
} from "./batch2bHarness";
import { buildGolden } from "./batch2bScenario";

vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });
afterAll(cleanupTempDbs);

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const V2_TRAIL = 4; // F1 trail ATR multiple, inside its ch.15 bounds [2, 4]

/** F1 v2: the v1 values except a wider trail (a parameter-only version, D-110 #32). */
function f1v2Params(): Record<string, unknown> {
  const v = canonicalParams("F1", (k: ConfigKey) => CONFIG_KEYS[k].default);
  v.f1_trail_atr = V2_TRAIL;
  return v;
}

async function addVersion(
  db: Client,
  id: string,
  params: Record<string, unknown>,
  status: "shadow" | "registered",
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO rule_version (id, market, family, n, parent, origin, params_json, params_sha,
            spec_json, schema_version, registered_d, created_by)
          VALUES (?, ?, 'F1', 2, 'F1.v1', 'challenger', ?, ?, ?, ?, '2030-01-02', 'A6')`,
    args: [
      id,
      MARKET,
      paramsJson(params),
      paramsSha(params),
      ruleSpecJson("F1"),
      RULE_SCHEMA_VERSION,
    ],
  });
  const steps = status === "shadow" ? ["registered", "shadow"] : ["registered"];
  for (const [i, s] of steps.entries()) {
    await db.execute({
      sql: `INSERT INTO rule_version_status (rule_version_id, seq, status, d, reason)
            VALUES (?, ?, ?, '2030-01-02', 'test')`,
      args: [id, i + 1, s],
    });
  }
}

const KEEP = ["E01", "E07", "E08", "C2-F1", "C2-F4", "C3-F4"];

async function night(
  prepare: (db: Client) => Promise<void>,
  after: (db: Client) => Promise<void> = async () => {},
): Promise<Client> {
  const db = await freshReplayDb();
  await buildGolden(db);
  await setMode(db, "full");
  await prepare(db);
  await startCohortsAt(db, 295, KEEP);
  await after(db);
  return db;
}

const base = testParams();
const snapshot = async (db: Client): Promise<string> =>
  sha(
    [
      await dump(db, "SELECT * FROM signal ORDER BY id"),
      await dump(db, "SELECT * FROM arena_order ORDER BY id"),
      await dump(db, "SELECT * FROM decision_card ORDER BY id"),
      await dump(db, "SELECT * FROM stop_level ORDER BY trade_id, d, rule"),
    ].join("\n"),
  );

describe("pure: one run per version", () => {
  const p = defaultAgentParams();
  const world = () => [
    factsOf(
      "ZZA",
      "U1",
      makeBars({ close: rising(CENT), volume: volumes(1_000_000n, 2_000_000n) }),
      p,
    ),
    ...peers("ZZP", "U1", 9, p),
  ];
  const v1 = canonicalParams("F1", (k: ConfigKey) => CONFIG_KEYS[k].default);
  const ref = (
    id: string,
    params: Record<string, unknown>,
    n: number,
    role: "live" | "shadow",
  ) => ({
    id,
    family: "F1" as const,
    n,
    params,
    role,
  });

  it("a v1-only set is byte-identical to the plain run", () => {
    const set = { live: new Map([["F1" as const, ref("F1.v1", v1, 1, "live")]]), extra: [] };
    const plain = runFamilies(inputsOf(world()), p);
    const run = runVersions(inputsOf(world()), p, set);
    expect(familyOutputJson(run.out)).toBe(familyOutputJson(plain));
    expect(familyOutputJson(runVersions(inputsOf(world()), p, null).out)).toBe(
      familyOutputJson(plain),
    );
  });

  it("a second version has its own tagged candidates and its own parameters (replay parity)", () => {
    const v2 = f1v2Params();
    const set = {
      live: new Map([["F1" as const, ref("F1.v1", v1, 1, "live")]]),
      extra: [ref("F1.v2", v2, 2, "shadow")],
    };
    const run = runVersions(inputsOf(world()), p, set);
    const f1 = run.out.candidates.filter((c) => c.family === "F1");
    expect(f1.map((c) => c.ruleVersion)).toEqual(["F1.v1", "F1.v2"]);
    // the replay path: the same function with the version's parameters gives the same candidate
    const direct = runFamilies(inputsOf(world()), paramsWithVersion(p, "F1", v2), {
      families: ["F1"],
      ruleVersions: { F1: "F1.v2" },
    });
    expect(familyOutputJson(f1[1])).toBe(familyOutputJson(direct.candidates[0]));
    expect(run.paramsOf.get("F1.v2")!.f1.trailAtr).not.toEqual(
      run.paramsOf.get("F1.v1")!.f1.trailAtr,
    );
    expect(
      run.out.candidates.every((c) => c.family === "F1" || c.ruleVersion.endsWith(".v1")),
    ).toBe(true);
    // the live candidates equal the plain run
    const plain = runFamilies(inputsOf(world()), p).candidates.filter((c) => c.family === "F1");
    expect(familyOutputJson(f1[0])).toBe(familyOutputJson(plain[0]));
  });

  it("the same input twice gives the same bytes (determinism)", () => {
    const set = {
      live: new Map([["F1" as const, ref("F1.v1", v1, 1, "live")]]),
      extra: [ref("F1.v2", f1v2Params(), 2, "shadow")],
    };
    const a = familyOutputJson(runVersions(inputsOf(world()), p, set).out);
    const b = familyOutputJson(runVersions(inputsOf(world()), p, set).out);
    expect(a).toBe(b);
  });

  it("maps an execution's registry value to a version id", () => {
    expect(versionIdOf("F1", "v1")).toBe("F1.v1");
    expect(versionIdOf("F1", "F1.v3")).toBe("F1.v3");
  });
});

describe("batch 2b nights", () => {
  it("seeding v1 changes nothing: signals, orders, cards and stop levels are byte-identical", async () => {
    const plain = await night(async () => {});
    await runNights(plain, base, 295, 302);
    const seeded = await night(async (db) => {
      await seedRuleVersions(db, { market: MARKET, d: "2030-01-02" });
    });
    await runNights(seeded, base, 295, 302);
    const a = await snapshot(plain);
    expect(await snapshot(seeded)).toBe(a);
    const orders = JSON.parse(await dump(plain, "SELECT id FROM arena_order WHERE kind = 'entry'"));
    expect(orders.length).toBeGreaterThan(0);
  });

  it("a shadow version stores its own candidates and places no orders unless assigned", async () => {
    const plain = await night(async (db) => {
      await seedRuleVersions(db, { market: MARKET, d: "2030-01-02" });
    });
    await runNights(plain, base, 295, 302);
    const two = await night(async (db) => {
      await seedRuleVersions(db, { market: MARKET, d: "2030-01-02" });
      await addVersion(db, "F1.v2", f1v2Params(), "shadow");
    });
    await runNights(two, base, 295, 302);

    const sigs = async (db: Client, v: string): Promise<number> =>
      Number(
        JSON.parse(
          await dump(db, `SELECT COUNT(*) AS n FROM signal WHERE rule_version = '${v}'`),
        )[0].n,
      );
    expect(await sigs(plain, "F1.v2")).toBe(0);
    expect(await sigs(two, "F1.v2")).toBeGreaterThan(0);
    expect(await sigs(two, "F1.v2")).toBe(await sigs(two, "F1.v1"));
    // v1 signals unchanged, no extra orders or cards
    const v1Rows = "SELECT * FROM signal WHERE rule_version = 'F1.v1' ORDER BY id";
    expect(await dump(two, v1Rows)).toBe(await dump(plain, v1Rows));
    for (const t of ["arena_order", "decision_card", "stop_level"]) {
      const q = `SELECT * FROM ${t} ORDER BY 1, 2`;
      expect(await dump(two, q)).toBe(await dump(plain, q));
    }
    // every card is tagged with the version of its signal
    const cards = JSON.parse(
      await dump(
        two,
        "SELECT s.rule_version AS sv, c.card_json AS j FROM decision_card c JOIN signal s ON s.id = c.signal_id",
      ),
    ) as { sv: string; j: string }[];
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) expect(JSON.parse(c.j).rule_version).toBe(c.sv);
  });

  it("an execution assigned to the second version trades its candidates with its parameters", async () => {
    const db = await night(
      async (db) => {
        await seedRuleVersions(db, { market: MARKET, d: "2030-01-02" });
        await addVersion(db, "F1.v2", f1v2Params(), "shadow");
      },
      async (db) => {
        await db.execute("UPDATE execution SET rule_version = 'F1.v2' WHERE id = 'E01'");
      },
    );
    await runNights(db, base, 295, 302);
    const orders = JSON.parse(
      await dump(
        db,
        `SELECT o.signal_id AS sid, o.stop_spec AS spec FROM arena_order o
         JOIN cohort c ON c.id = o.cohort_id WHERE o.kind = 'entry' AND c.execution_id = 'E01'`,
      ),
    ) as { sid: string; spec: string }[];
    expect(orders.length).toBeGreaterThan(0);
    for (const o of orders) {
      expect(o.sid).toContain(":F1:F1.v2:");
      expect(o.spec).toContain(String(V2_TRAIL));
    }
    const set = await loadVersionSet(db, MARKET, [
      { market: MARKET, family: "F1", rule_version: "F1.v2" },
    ]);
    expect(set!.live.get("F1")!.id).toBe("F1.v1");
    expect(set!.extra.map((v) => v.id)).toEqual(["F1.v2"]);
  });
});
