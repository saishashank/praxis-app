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
    expect(v.families[0]!.name).toContain("F1");
    expect(v.ledger.cells).toBe(3);
    expect(v.ledger.luckExpected).toBe(0.3); // 3 cells x level 0.1
    expect(v.ledger.luckText).toBe("Of 3 ideas tried, about 0.3 would look good by luck alone.");
    expect(v.placebo).toMatchObject({ passed: true, nullPassRatePpm: 40_000 });
    expect(v.navAtRisk).toMatchObject({ loss95Pct: 4.2, lossWorstPct: 9.1 });
    expect(v.abstains.reasons).toEqual([
      { label: "setups like this have not come out ahead after costs", count: 2 },
    ]);
    expect(v.controls.canEdit).toBe(true);
    expect(v.asOfMelbourne).toContain("(UTC+11)");
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
      expect(shown).not.toMatch(/d{4}-d{2}-d{2}/);
      expect(p.data.asOfMelbourne).toBe("week 2026-W42");
      expect(p.data.coldStart.firstD).toBe("week 2026-W42");
    }
    const owner = await loadCortex(deps(w, "owner"));
    expect(owner.data.coldStart.firstD).toBe("2026-10-16");
  });
});
