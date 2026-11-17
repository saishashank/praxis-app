// @vitest-environment node
// LRN-AT-1 (learning loop → Cortex, design C.12 1; D-923, D-926): with no learner map rows and no
// weights, `scoreOf`, `runNight` and every cortex_* row `persistNight` writes are byte-identical to the
// code before the learner was added. The golden hashes below were recorded on that code (commit
// 63d6868, the parent of this change) from the recorded ZZ fixture nights the Cortex tests already use
// (zzNight, the F1.v2-mom rule of f1mom.test.ts, the AT-50 replay world). Synthetic ZZ data only.
import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import { afterAll, describe, expect, it } from "vitest";
import type { Family } from "@/lib/agents/families/types";
import { defaultAgentParams } from "@/lib/agents/params";
import type { AngleDef } from "@/lib/cortex/angles/types";
import {
  nightOutputJson,
  runNight,
  type FamilyNightRule,
  type NightInputs,
} from "@/lib/cortex/night";
import { scoreOf } from "@/lib/cortex/score";
import { activeSetHash } from "@/lib/cortex/score/map";
import type { AngleValue, CortexMap } from "@/lib/cortex/score/types";
import { persistNight } from "@/lib/cortex/stage";
import { replayCohorts } from "@/lib/replay/cohortReplay";
import { createCortexReplay } from "@/lib/replay/cortexReplay";
import { plain } from "@/lib/replay/scorecards";
import { cleanupTempDbs, freshDb } from "../../db/helpers";
import { replayWorld } from "../../fixtures/m15/replayWorld";
import {
  cellsFor,
  CLUSTERS,
  mapFor,
  NIGHT_ANGLES,
  nightInputs,
  PASSPORTS,
  ruleFor,
  SCORED,
  SESSIONS,
} from "./zzNight";

afterAll(cleanupTempDbs);

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const T = SESSIONS.length - 1;

/** The exclusive long-momentum angle and the F1.v2-mom rule of f1mom.test.ts (D-888..D-891). */
const EXCL: AngleDef = {
  id: "A-D1-11",
  version: 1,
  domain: 1,
  title: "ZZ long momentum",
  definition: "close over the close ten sessions back, minus one",
  kind: "score",
  cluster: "momentum",
  orientation: 1,
  horizonSessions: 120,
  warmupSessions: 11,
  inputs: ["bar_au"],
  grid: {},
  exclusive: true,
  compute: (view, code, t) => {
    const s = view.adj(code, t, 11);
    if (s.adjClose.length < 11) return undefined;
    return Number(s.adjClose[10]! - s.adjClose[0]!) / Number(s.adjClose[0]!);
  },
};
const MOM_HASH = activeSetHash([{ id: "A-D1-11", version: 1, cluster: "momentum" }]);
function momInputs(t: number): NightInputs {
  const base = nightInputs(t);
  const rule: FamilyNightRule = ruleFor("F1", {
    ruleVersion: "F1.v2-mom",
    clusters: ["momentum"],
    angles: ["A-D1-11"],
    top3MinS: -1,
    plan: "time_hold",
    hold: 120,
  });
  const map: CortexMap = {
    ...mapFor("F1"),
    ruleVersion: "F1.v2-mom",
    K: 1,
    clusters: ["momentum"],
    activeSetHash: MOM_HASH,
  };
  return nightInputs(t, {
    angles: [...NIGHT_ANGLES, EXCL],
    passports: new Map([...PASSPORTS, ["A-D1-11", "active" as const]]),
    rules: new Map<Family, FamilyNightRule>([...base.rules, ["F1", rule]]),
    maps: new Map([...base.maps, ["F1", map]]),
  });
}

/** Every night of the AT-50 replay world through the replay driver (the recorded nights). */
function replayNights(): string {
  const params = defaultAgentParams();
  const world = replayWorld({ provenance: "notice", withShort: true, withMacro: true });
  const cr = createCortexReplay({
    world,
    params,
    status: { F1: "allowed" },
    maps: new Map([["F1", mapFor("F1")]]),
    cells: cellsFor(["F1"]),
    rules: new Map([["F1", ruleFor("F1")]]),
    passports: PASSPORTS,
    angles: NIGHT_ANGLES,
    indexChangesLoaded: true,
    regimeOverride: "NEUTRAL",
  });
  const res = replayCohorts(world, { params, step: 10, cortex: cr.hook });
  const nights = cr.nights().map((n) => `${n.d}:${nightOutputJson(n.out)}`);
  const cohorts = JSON.stringify(plain(res), (_k, x) => (typeof x === "bigint" ? `${x}n` : x));
  return [...nights, cohorts].join("\n");
}

async function persistedRows(inputs: NightInputs): Promise<string> {
  const db: Client = await freshDb("main");
  const out = runNight(inputs);
  await persistNight(db, {
    market: inputs.market,
    d: inputs.d,
    inputs,
    out,
    runtimeMs: 7,
    createdAt: "2026-03-28T08:00:00.000Z",
  });
  const parts: string[] = [];
  for (const table of [
    "cortex_night",
    "cortex_feature_daily",
    "cortex_decision",
    "cortex_abstain",
    "input_manifest",
  ]) {
    const r = await db.execute(`SELECT * FROM ${table} ORDER BY 1, 2, 3, 4`);
    parts.push(`${table}:${JSON.stringify(r.rows.map((x) => ({ ...x })))}`);
  }
  db.close();
  return parts.join("\n");
}

const scoreBytes = (): string => {
  const feats: AngleValue[][] = [
    [0.5, -0.25, 1],
    [-1, 1, 0.3333333333333333],
    [0.1, { flag: "x" }, -0.7],
    [0, 0, 0],
  ];
  return feats
    .map((v) => {
      const f = new Map<string, AngleValue>(SCORED.map((a, i) => [a.id, v[i]]));
      return JSON.stringify(scoreOf(f, SCORED, [...CLUSTERS]));
    })
    .join("\n");
};

/** Recorded on the code before the learner (63d6868); a change here is a byte change of the night. */
const GOLDEN = {
  score: "ae583c3eb5e97d448b0609b41102fb3ffe575722028940b20298b9d065fb8d02",
  nightLast: "7b267edb9a85b87d5d55d439b10e933252c84734cbad7a54d13afd7ac56a25b4",
  nightMid: "94c772e5506366f5ee2f05e07ae5935fb791205e93a44d4e3368fa98ea9ae1b6",
  nightEarly: "0982dea93808a1b505c7264702957363228dcb09b023e906cb1989703c92c3b2",
  nightF1Shadow: "5d107a25a1c83ea97edc0c7c45fdb2c737f71bafea17591cb066fff10a5ba4fa",
  nightMom: "96b0b658d4e2d44e18f66b1413296e1a4b0647731c81317e253f902910cb7d0b",
  replay: "9a7e040f7d51116cc8f401d986e735c509e4e030697f0ab882f767f7b346da34",
  persisted: "1db787475ff7ff56aa103d1dd3fb059eff9fc86b77f38bb273a11ae6bcaf64f3",
  persistedMom: "3ed3046bdc115cf706bf19a4d33fd2b05f4ab3209c16c22640c5c27f04ddc7c0",
};

describe("LRN-AT-1: no learner rows, no weights → the bytes of the code before the learner", () => {
  const got = {
    score: sha(scoreBytes()),
    nightLast: sha(nightOutputJson(runNight(nightInputs(T)))),
    nightMid: sha(nightOutputJson(runNight(nightInputs(T - 7)))),
    nightEarly: sha(nightOutputJson(runNight(nightInputs(12)))),
    nightF1Shadow: sha(
      nightOutputJson(runNight(nightInputs(T, { status: { F1: "shadow", F4: "shadow" } }))),
    ),
    nightMom: sha(nightOutputJson(runNight(momInputs(T)))),
    replay: sha(replayNights()),
  };

  it("is not vacuous: the fixture nights take decisions and block candidates", () => {
    const out = runNight(nightInputs(T));
    expect(out.decisions.length).toBeGreaterThan(0);
    expect(out.blocked.length).toBeGreaterThan(0);
    expect(runNight(momInputs(T)).shadow.length).toBeGreaterThan(0);
  });

  it("scoreOf without weights: the recorded bytes", () => {
    expect(got.score).toBe(GOLDEN.score);
  });

  it("runNight without challengers: the recorded bytes on every fixture night", () => {
    expect(got.nightLast).toBe(GOLDEN.nightLast);
    expect(got.nightMid).toBe(GOLDEN.nightMid);
    expect(got.nightEarly).toBe(GOLDEN.nightEarly);
    expect(got.nightF1Shadow).toBe(GOLDEN.nightF1Shadow);
    expect(got.nightMom).toBe(GOLDEN.nightMom);
  });

  it("an empty challengers map is the same as none", () => {
    const none = nightOutputJson(runNight(nightInputs(T)));
    expect(nightOutputJson(runNight(nightInputs(T, { challengers: new Map() })))).toBe(none);
  });

  it("the replay driver over the recorded nights: the recorded bytes (nights and cohorts)", () => {
    expect(got.replay).toBe(GOLDEN.replay);
  });

  it("persistNight: every cortex_* row is the recorded bytes", async () => {
    expect(sha(await persistedRows(nightInputs(T)))).toBe(GOLDEN.persisted);
    expect(sha(await persistedRows(momInputs(T)))).toBe(GOLDEN.persistedMom);
  });
});
