// @vitest-environment node
// AT-50 (M15; docs/M15_requirements.md AT-50; CTX-040/041, CTX-050, TST-109; D-278, D-279, D-307):
// (1) a recorded night replays to identical bytes on two runs (decisions, orders, cards); (2) switching
// the LLM organs (text labels, opinions) on changes no order; (3) every text label carries produced_at,
// a manifest and a validation record (schema level, 0019); (4) as-of truncation equality for every
// registry angle with a compute and for the night's feature step on a synthetic ZZ world.
// Synthetic ZZ data only (SEC-110).
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { defaultAgentParams } from "@/lib/agents/params";
import { ANGLES, defaultGrid, evaluateAngle } from "@/lib/cortex/angles/registry";
import { cutWorld } from "@/lib/cortex/pit/asOfView";
import { truncationMismatches } from "@/lib/cortex/pit/truncation";
import { featuresAt, nightOutputJson, runNight, type NightOutput } from "@/lib/cortex/night";
import { getManifest, insertLabelWithValidation, insertManifest } from "@/lib/cortex/store";
import { replayCohorts, type CohortReplayResult } from "@/lib/replay/cohortReplay";
import { createCortexReplay, type CortexReplayConfig } from "@/lib/replay/cortexReplay";
import { plain } from "@/lib/replay/scorecards";
import { shortWorld } from "../../cortex/angles/d3to8World";
import {
  NIGHT_ANGLES,
  PASSPORTS,
  cellsFor,
  mapFor,
  nightInputs,
  nightView,
  nightWorld,
  ruleFor,
} from "../../cortex/night/zzNight";
import { replayWorld } from "../../fixtures/m15/replayWorld";
import { cleanupTempDbs, freshDb } from "../../db/helpers";

afterEach(cleanupTempDbs);

const params = defaultAgentParams();
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const jsonOf = (v: unknown): string =>
  JSON.stringify(plain(v), (_k, x) => (typeof x === "bigint" ? `${x}n` : x));

// ---- the recorded night, replayed ------------------------------------------------------------------------------

type Run = {
  readonly nights: string; // canonical JSON of every night's output
  readonly decisions: string;
  readonly cards: string;
  readonly orders: string; // the Cortex entry fills (cohort, code, rule) in fill order
  readonly cohorts: string; // the cohort outcomes
  readonly hash: string;
  readonly liveDecisions: number;
  readonly fills: number;
};

function replayRun(over: Partial<CortexReplayConfig> = {}, withHook = true): Run {
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
    ...over,
  });
  const res: CohortReplayResult = replayCohorts(world, {
    params,
    step: 10,
    ...(withHook ? { cortex: cr.hook } : {}),
  });
  const nights = cr.nights();
  const nightsJson = nights.map((n) => `${n.d}:${nightOutputJson(n.out)}`).join("\n");
  const decisions = nights.flatMap((n) => n.out.decisions);
  const decisionsJson = nights
    .map((n) => nightOutputJson({ decisions: n.out.decisions } as unknown as NightOutput))
    .join("\n");
  const cardsJson = nights
    .map((n) =>
      nightOutputJson({
        decisions: n.out.decisions.map((d) => d.card),
        shadow: n.out.shadow.map((d) => d.card),
      } as unknown as NightOutput),
    )
    .join("\n");
  const orders = jsonOf(cr.fillRules());
  const cohorts = jsonOf(res);
  return {
    nights: nightsJson,
    decisions: decisionsJson,
    cards: cardsJson,
    orders,
    cohorts,
    hash: sha([nightsJson, decisionsJson, cardsJson, orders, cohorts].join("\n--\n")),
    liveDecisions: decisions.length,
    fills: cr.fillRules().length,
  };
}

describe("AT-50 clause 1: identical orders on two runs of a recorded night", () => {
  const a = replayRun();
  const b = replayRun();

  it("is not vacuous: the allowed family takes live decisions and its entries fill", () => {
    expect(a.liveDecisions).toBeGreaterThan(0);
    expect(a.fills).toBeGreaterThan(0);
  });

  it("the cortex decisions, orders and cards are byte-identical on two runs (hash)", () => {
    expect(b.nights).toBe(a.nights);
    expect(b.decisions).toBe(a.decisions);
    expect(b.cards).toBe(a.cards);
    expect(b.orders).toBe(a.orders);
    expect(b.cohorts).toBe(a.cohorts);
    expect(b.hash).toBe(a.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("runNight alone: twice on the same recorded inputs gives the same bytes", () => {
    const x = nightOutputJson(runNight(nightInputs()));
    const y = nightOutputJson(runNight(nightInputs()));
    expect(y).toBe(x);
    expect(sha(y)).toBe(sha(x));
  });

  it("a hook with every family in shadow changes no cohort result: the v1 path is untouched", () => {
    const v1 = replayRun({ status: {} }, false);
    const shadow = replayRun({ status: {} }, true);
    expect(shadow.cohorts).toBe(v1.cohorts);
    expect(shadow.fills).toBe(0);
    // the cortex arm differs: the allowed run is not the v1 run
    expect(a.cohorts).not.toBe(v1.cohorts);
  });
});

// ---- organs off versus on ----------------------------------------------------------------------------------------

describe("AT-50 clause 2: disabling every LLM organ changes no order", () => {
  const labels = new Map<string, unknown>([
    ["ann:ZZA:1", { kind: "tone", value: "positive", producedAt: "2026-02-10T08:00:00Z" }],
    ["ann:ZZB:1", { kind: "guidance", value: "up", producedAt: "2026-02-11T08:00:00Z" }],
    ["opinion:ZZC", { stance: "bullish", note: "recorded steelman response" }],
  ]);

  it("runNight: text labels and opinion tables present or absent give identical bytes", () => {
    const off = runNight(nightInputs());
    const on = runNight(nightInputs(undefined, { labels }));
    expect(nightOutputJson(on)).toBe(nightOutputJson(off));
    expect(on.decisions.length).toBeGreaterThan(0);
  });

  it("the replay with labels supplied produces the same orders and outcomes", () => {
    const off = replayRun();
    const on = replayRun({ labels });
    expect(on.orders).toBe(off.orders);
    expect(on.cohorts).toBe(off.cohorts);
    expect(on.hash).toBe(off.hash);
  });

  it("the view the night reads has no label input kind (labels cannot reach a score)", () => {
    const view = nightView(nightWorld());
    const m = view.manifest(view.sessions.length - 1);
    expect(m.sources.map((s) => s.kind as string)).not.toContain("text_label");
  });
});

// ---- label NOT NULLs ---------------------------------------------------------------------------------------------

describe("AT-50 clause 3: every text label has produced_at, a manifest and a validation record", () => {
  const M = "AU";
  const validation = (id: string) => ({
    validationId: id,
    market: M,
    kind: "paraphrase" as const,
    result: { agree: true },
    createdAt: "2030-03-05T00:00:00Z",
  });
  const label = {
    market: M,
    announcementId: "ZZA-a1",
    labelKind: "tone" as const,
    modelId: "zz-model",
    producedAt: "2030-03-05T00:00:00Z",
    value: "positive",
    citedSpan: "we raise guidance",
    manifestId: "m1",
    validationId: "v1",
  };
  const insertRaw = (db: Awaited<ReturnType<typeof freshDb>>, over: Record<string, unknown>) => {
    const row = {
      market: M,
      announcement_id: "ZZA-a2",
      label_kind: "tone",
      model_id: "zz-model",
      produced_at: "2030-03-05T00:00:00Z",
      value: "positive",
      cited_span: null,
      manifest_id: "m1",
      validation_id: "v1",
      ...over,
    };
    return db.execute({
      sql: `INSERT INTO text_label (market, announcement_id, label_kind, model_id, produced_at, value,
              cited_span, manifest_id, validation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        row.market,
        row.announcement_id,
        row.label_kind,
        row.model_id,
        row.produced_at,
        row.value,
        row.cited_span,
        row.manifest_id,
        row.validation_id,
      ] as never,
    });
  };

  it("a label without produced_at, without a manifest or without a validation record is refused", async () => {
    const db = await freshDb("main");
    const mf = await insertManifest(
      db,
      { market: M, d: "2030-03-05", sources: [], schemaSha: "s", rowCounts: {} },
      "2030-03-05T08:00:00Z",
    );
    await insertLabelWithValidation(db, { ...label, manifestId: mf.manifestId }, validation("v1"));
    // NOT NULL: produced_at, manifest_id, validation_id
    await expect(insertRaw(db, { produced_at: null })).rejects.toThrow();
    await expect(insertRaw(db, { manifest_id: null })).rejects.toThrow();
    await expect(insertRaw(db, { validation_id: null })).rejects.toThrow();
    // the insert guard: a label whose validation record does not exist is refused
    await expect(insertRaw(db, { validation_id: "no-such-validation" })).rejects.toThrow();
    // nothing partial was written
    const rows = await db.execute(
      "SELECT announcement_id, produced_at, manifest_id, validation_id FROM text_label",
    );
    expect(rows.rows).toHaveLength(1);
  });

  it("every stored label joins to a manifest and a validation row", async () => {
    const db = await freshDb("main");
    const mf = await insertManifest(
      db,
      { market: M, d: "2030-03-05", sources: [], schemaSha: "s", rowCounts: {} },
      "2030-03-05T08:00:00Z",
    );
    await insertLabelWithValidation(db, { ...label, manifestId: mf.manifestId }, validation("v1"));
    await insertLabelWithValidation(
      db,
      { ...label, announcementId: "ZZB-a1", validationId: "v2", manifestId: mf.manifestId },
      validation("v2"),
    );
    const orphans = await db.execute(
      `SELECT l.announcement_id FROM text_label l
        LEFT JOIN label_validation v ON v.validation_id = l.validation_id
       WHERE l.produced_at IS NULL OR l.manifest_id IS NULL OR v.validation_id IS NULL`,
    );
    expect(orphans.rows).toHaveLength(0);
    expect((await getManifest(db, mf.manifestId))?.manifestId).toBe(mf.manifestId);
  });
});

// ---- TST-109 -------------------------------------------------------------------------------------------------------

describe("AT-50 clause 4: as-of truncation equality (TST-109) for every registry angle", () => {
  const world = shortWorld(); // 300 sessions, five ZZ codes, every input kind present
  const withCompute = ANGLES.filter((a) => a.compute !== undefined);
  // sampled cut-offs: after the longest warm-up, around a dividend ex-date, an index change window and the end
  const SAMPLE = [150, 199, 230, 262, 285, 299];

  it("the registry has angles with a compute to check", () => {
    expect(ANGLES.length).toBe(100);
    expect(withCompute.length).toBeGreaterThan(40);
  });

  it("recomputing every angle on the view cut at t equals the full view, at every sampled cut-off", () => {
    const mismatches = truncationMismatches(
      world,
      (view, code, t) =>
        withCompute.map((a) => [a.id, evaluateAngle(a, "active", view, code, t, defaultGrid(a))]),
      { ts: SAMPLE },
    );
    expect(mismatches.slice(0, 5)).toEqual([]);
    expect(mismatches).toHaveLength(0);
  });

  it("the night's feature step (rank standardisation across the universe) is identical on the cut world", () => {
    const scored = withCompute.filter((a) => a.kind === "score");
    expect(scored.length).toBeGreaterThan(20);
    for (const t of SAMPLE) {
      const full = nightView(world);
      const cut = nightView(cutWorld(world, t));
      const a = featuresAt(full, t, scored);
      const b = featuresAt(cut, t, scored);
      expect(nightOutputJson({ features: b } as unknown as NightOutput)).toBe(
        nightOutputJson({ features: a } as unknown as NightOutput),
      );
    }
  });
});
