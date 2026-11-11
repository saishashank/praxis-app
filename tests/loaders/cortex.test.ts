// @vitest-environment node
// M15 P4 (CTX-071, CTX-073, ROL-107, D-277, D-295): the Cortex page loader. Empty world (every figure
// "Not measured", shadow only), a seeded world (numbers, luck figure, abstain reasons, placebo, NAV at
// risk), masking for Editor and Viewer, and the Melbourne time stamp with its offset.
import { afterAll, describe, expect, it } from "vitest";
import { cleanupTempDbs } from "../db/helpers";
import { LIVE_BOOKS_LABEL, loadCortex, melbourneStamp } from "@/lib/ui/loaders/cortex";
import { emptyWorld, NOW, type Who, type World } from "./world";

afterAll(cleanupTempDbs);

const deps = (w: World, who: Who) => ({
  mainDb: w.main,
  authDb: w.auth,
  user: { id: w.ids[who], role: who === "granted" ? "viewer" : who },
  now: NOW,
});

async function seeded(): Promise<World> {
  const w = await emptyWorld();
  const run = (sql: string, args: (string | number | null)[] = []) => w.main.execute({ sql, args });
  await run(
    `INSERT INTO input_manifest (manifest_id, market, d, sources_json, schema_sha, row_counts_json, created_at)
     VALUES ('m1','AU','2026-10-16','{}','s','{}','2026-10-16T09:00:00Z')`,
  );
  await run(
    `INSERT INTO cortex_night (market, d, status, reason, manifest_id, universe_n, bars_n, feature_rows,
       runtime_ms, active_set_hash, map_fitted_at) VALUES ('AU','2026-10-16','ran',NULL,'m1',10,10,10,5,'h','2026-10-01T00:00:00Z')`,
  );
  await run(
    `INSERT INTO cortex_map (market, family, rule_version, fitted_at, params_json, active_set_hash, n_eff, pool, fit_split)
     VALUES ('AU','F1','v1','2026-10-01T00:00:00Z','{}','h',1,'p','development')`,
  );
  await run(
    `INSERT INTO angle_passport (market, angle_id, version, domain, cluster, orientation, kind, inputs_json,
       history_fields_json, status, horizon_sessions, evidence_json, measured_json, frozen_at)
     VALUES ('AU','zz_secret_angle',1,1,'momentum',1,'score','[]','{}','active',10,'{}',NULL,'2026-10-01T00:00:00Z')`,
  );
  await run(
    `INSERT INTO family_status (market, family, since_d, status, evidence_json, statement_id, set_by)
     VALUES ('AU','F1','2026-10-01','allowed','{"n_eff":212,"mde":0.012}',NULL,'import')`,
  );
  for (const [id, kind, result] of [
    ["c1", "angle_ic", null],
    ["c2", "placebo", '{"passed":true,"null_pass_rate":0.04}'],
    ["c3", "nav_at_risk", '{"loss_95_pct":4.2,"loss_worst_pct":9.1}'],
  ] as const) {
    await run(
      `INSERT INTO cortex_ledger_cell (cell_id, market, family, angle_id, kind, spec_json, logged_at, result_at,
         result_json, split, lineage_id) VALUES (?, 'AU', 'all', NULL, ?, '{}', '2026-10-01T00:00:00Z', ?, ?, 'development', NULL)`,
      [id, kind, result === null ? null : "2026-10-02T00:00:00Z", result],
    );
  }
  for (const b of ["B1", "B2"]) {
    await run(
      `INSERT INTO cortex_abstain (market, d, book_id, gate_id, label, detail_json)
       VALUES ('AU','2026-10-16',?,'G04_economic','setups like this have not come out ahead after costs','{}')`,
      [b],
    );
  }
  return w;
}

describe("melbourneStamp (CTX-073)", () => {
  it("states the daylight offset in summer and the standard offset in winter", () => {
    expect(melbourneStamp("2026-10-31T09:15:00Z")).toBe("Sat, 31 Oct 2026, 8:15 pm AEDT (UTC+11)");
    expect(melbourneStamp("2026-07-01T09:15:00Z")).toContain("AEST (UTC+10)");
    expect(melbourneStamp("not a date")).toBeNull();
    expect(melbourneStamp(null)).toBeNull();
  });
});

describe("empty world", () => {
  it("is shadow only, every figure is not measured, the D-295 label is set", async () => {
    const w = await emptyWorld();
    const p = await loadCortex(deps(w, "owner"));
    const v = p.data;
    expect(p.state).toBe("empty");
    expect(v.liveBooksLabel).toBe(LIVE_BOOKS_LABEL);
    expect(v.shadowOnly).toBe(true);
    expect(v.shadowOnlyText).toMatch(/shadow only/);
    expect(v.passports.total).toBe(0);
    expect(v.ledger.luckText).toBe("Not measured yet");
    // the 5% (strategies) and the 0.1 (lesson pool) are named apart, with no internal ids
    expect(v.ledger.errorLevelsText).toContain("5% chance of a false win");
    expect(v.ledger.errorLevelsText).not.toMatch(/O-43|VAL-116/);
    expect(v.ledger.errorLevelsText).toContain("their own pool, which starts at 0.1");
    expect(v.families).toHaveLength(7);
    expect(
      v.families.every((f) => f.status === "shadow" && f.nEff === null && f.mde === null),
    ).toBe(true);
    expect(v.placebo).toBeNull();
    expect(v.navAtRisk).toBeNull();
    expect(v.abstains.total).toBe(0);
    expect(v.sectorTilt).toBeNull();
    expect(v.tickCost.length).toBeGreaterThan(5);
  });
});

describe("seeded world", () => {
  it("shows names and numbers to the Owner, with the luck figure computed", async () => {
    const w = await seeded();
    const v = (await loadCortex(deps(w, "owner"))).data;
    expect(v.shadowOnly).toBe(false);
    expect(v.passports.rows[0]!.angle).toBe("zz_secret_angle");
    expect(v.families[0]).toMatchObject({ status: "allowed", nEff: 212, mde: 0.012 });
    expect(v.families[0]!.name).toBe("Follow the trend");
    expect(v.ledger.cells).toBe(3);
    expect(v.ledger.luckExpected).toBe(0.3); // 3 cells x level 0.1
    expect(v.ledger.luckText).toBe("Of 3 ideas tried, about 0.3 would look good by luck alone.");
    expect(v.placebo).toMatchObject({ passed: true, nullPassRatePpm: 40_000 });
    expect(v.navAtRisk).toMatchObject({ loss95Pct: 4.2, lossWorstPct: 9.1 });
    expect(v.abstains.reasons).toEqual([
      { label: "setups like this have not come out ahead after costs", count: 2 },
    ]);
    expect(v.controls.canEdit).toBe(true);
    expect(v.asOfMelbourne).toMatch(/^[A-Z][a-z]{2} [0-9]{1,2} [A-Z][a-z]{2}$/);
  });

  it("masks angles and strategies for Editor and Viewer and offers no controls", async () => {
    const w = await seeded();
    for (const who of ["editor", "viewer"] as const) {
      const p = await loadCortex(deps(w, who));
      const text = JSON.stringify(p.data);
      expect(p.masked).toBe(true);
      expect(text).not.toContain("zz_secret_angle");
      expect(text).not.toMatch(/"F1/);
      expect(p.data.passports.rows[0]!.angle).toBe("Angle 1");
      expect(p.data.families[0]!.name).toBe("Strategy 1");
      expect(p.data.controls.canEdit).toBe(false);
    }
  });

  it("O-81 (D-944): no learner panel before the first generation; learner rows are not counted as maps", async () => {
    const w = await seeded();
    expect((await loadCortex(deps(w, "owner"))).data.learner).toBeNull();
    const run = (sql: string, args: (string | number | null)[] = []) =>
      w.main.execute({ sql, args });
    await run(
      `INSERT INTO cortex_map (market, family, rule_version, fitted_at, params_json, active_set_hash, n_eff, pool, fit_split)
       VALUES ('AU','F4','F4.learn','2026-10-02T07:10:02.000Z','{"learner":true,"generation":0}','h',1,'p','development')`,
    );
    for (const [d, seq, kind, words] of [
      ["2026-10-02", 100, "reweight", "Weekly re-weighting: more weight to 'x'."],
      ["2026-10-02", 101, "placebo", "hidden twin"],
      ["2026-10-14", 0, "scorecard", "hidden nightly"],
      ["2026-10-14", 1, "watch", "Review: 'x' has slipped."],
    ] as const) {
      await run(
        `INSERT INTO cortex_learn_event (market, d, seq, kind, family, angle_id, generation, evidence_json, words,
           reverses_seq, expires_d, created_at) VALUES ('AU', ?, ?, ?, 'F4', NULL, 0, '{}', ?, NULL, NULL, ?)`,
        [d, seq, kind, words, `${d}T09:00:00Z`],
      );
    }
    await run(
      `INSERT INTO cortex_learn_compare (market, decision_d, family, book_id, fixed_rule_version,
         learner_rule_version, learner_generation, fixed_code, learner_code, agree, fixed_ret1_ppm,
         learner_ret1_ppm, fixed_ret20_ppm, learner_ret20_ppm, matured_d, regime)
       VALUES ('AU','2026-10-05','F4','B1','v1','F4.learn',0,'ZZA','ZZB',0,0,0,1000,21000,'2026-10-16','RISK-ON')`,
    );
    await run(
      `INSERT INTO cortex_leader (market, family, since_d, leader, learner_rule_version, learner_generation,
         evidence_json, set_by) VALUES ('AU','F4','2026-10-10','learner','F4.learn',0,'{}','evaluator')`,
    );
    const v = (await loadCortex(deps(w, "owner"))).data;
    expect(v.mapsLoaded).toBe(1); // the fixed F1 map only
    expect(v.families.find((f) => f.mapFitted !== null)!.name).toBe("Follow the trend");
    const l = v.learner!;
    expect(l.on).toBe(true);
    expect(l.leaders).toHaveLength(1);
    expect(l.leaders[0]!.text).toMatch(/^The learning Cortex makes the decisions since /);
    expect(l.weekly).toEqual({
      day: expect.any(String),
      words: "Weekly re-weighting: more weight to 'x'.",
    });
    expect(l.duelText).toMatch(/same share on 0 of 1 nights; .* ahead by 2\.0 % over four weeks/);
    expect(l.events.map((e) => e.words)).toEqual([
      "Review: 'x' has slipped.",
      "Weekly re-weighting: more weight to 'x'.",
    ]);
    expect(JSON.stringify(l)).not.toMatch(/[0-9]{4}-[0-9]{2}-[0-9]{2}/);
    // the Owner kill; a masked viewer sees no words, no family code
    await run(
      `INSERT INTO config_version (key, scope, value_json, changed_at) VALUES ('learner_off','global','1',?)`,
      [NOW.toISOString()],
    );
    const off = (await loadCortex(deps(w, "owner"))).data.learner!;
    expect(off.on).toBe(false);
    expect(off.leaders[0]!.text).toMatch(/^The fixed Cortex makes the decisions/);
    const masked = (await loadCortex(deps(w, "viewer"))).data.learner!;
    expect(masked.events).toEqual([]);
    expect(masked.eventCount).toBe(2);
    expect(masked.weekly!.words).toBe("The weekly re-weighting ran.");
    expect(masked.leaders[0]!.name).toMatch(/^Strategy \d$/);
    expect(JSON.stringify(masked)).not.toMatch(/F4|'x'/);
  });

  it("O-81: a learner that has not run a night yet shows the fixed Cortex leading and nothing measured", async () => {
    const w = await emptyWorld();
    await w.main.execute(
      `INSERT INTO cortex_map (market, family, rule_version, fitted_at, params_json, active_set_hash, n_eff, pool, fit_split)
       VALUES ('AU','F1','F1.learn','2026-10-02T07:10:02.000Z','{"learner":true,"generation":0}','h',1,'p','development')`,
    );
    for (const who of ["owner", "viewer"] as const) {
      const l = (await loadCortex(deps(w, who))).data.learner!;
      expect(l.on).toBe(true);
      expect(l.weekly).toBeNull();
      expect(l.duelText).toBeNull();
      expect(l.events).toEqual([]);
      expect(l.eventCount).toBe(0);
      expect(l.leaders[0]!.text).toMatch(
        /^The fixed Cortex makes the decisions; the learning Cortex runs beside it/,
      );
    }
    expect((await loadCortex(deps(w, "owner"))).data.mapsLoaded).toBe(0);
  });

  it("shows Editor and Viewer ISO weeks, never an exact date (UX-009)", async () => {
    const w = await seeded();
    for (const who of ["editor", "viewer"] as const) {
      const p = await loadCortex(deps(w, who));
      const shown = JSON.stringify([
        p.text,
        p.data.asOfMelbourne,
        p.data.coldStart,
        p.data.placebo,
        p.data.navAtRisk,
      ]);
      expect(shown).not.toMatch(/[0-9]{4}-[0-9]{2}-[0-9]{2}/);
      expect(p.data.asOfMelbourne).toBe("week 2026-W42");
      expect(p.data.coldStart.firstD).toBe("week 2026-W42");
    }
    const owner = await loadCortex(deps(w, "owner"));
    expect(owner.data.coldStart.firstD).toBe("2026-10-16");
    expect(owner.data.asOfMelbourne).not.toMatch(/[0-9]{4}-[0-9]{2}-[0-9]{2}/);
  });
});
