// @vitest-environment node
// AT-53 (M15 P6; CTX-030, CTX-031, CTX-033, CTX-034): passport NOT NULLs through the 0019 schema,
// distinctness on correlated features, the logged-before-result CHECK and the once-only result, and
// Benjamini-Hochberg under positive dependence. Synthetic ZZ data only (SEC-110).
import { afterEach, describe, expect, it } from "vitest";
import {
  insertPassport,
  latestPassports,
  logCell,
  setCellResult,
  getCell,
} from "@/lib/cortex/store";
import { distinctnessReport, MAX_RANK_CORRELATION } from "@/lib/stats/distinctness";
import { benjaminiHochberg, measuredCells } from "@/lib/stats/multiplicity";
import { cleanupTempDbs, freshDb } from "../../db/helpers";
import { normal, prngFor } from "../../stats/m15/helpers";

afterEach(cleanupTempDbs);

describe("AT-53 passport NOT NULLs", () => {
  const base: Record<string, string | number | null> = {
    market: "AU",
    angle_id: "A-D1-01",
    version: 1,
    domain: 1,
    cluster: "momentum",
    orientation: 1,
    kind: "score",
    inputs_json: "[]",
    history_fields_json: "{}",
    status: "candidate",
    horizon_sessions: 20,
    evidence_json: "{}",
    measured_json: null,
    frozen_at: "2030-01-01T00:00:00Z",
  };

  it("every NOT NULL column of angle_passport refuses a NULL, and measured_json alone may be NULL", async () => {
    const db = await freshDb("main");
    const info = await db.execute("PRAGMA table_info(angle_passport)");
    const notNull = info.rows.filter((r) => Number(r.notnull) === 1).map((r) => String(r.name));
    expect(notNull.sort()).toEqual(
      Object.keys(base)
        .filter((k) => k !== "measured_json")
        .sort(),
    );
    for (const col of notNull) {
      const row = { ...base, [col]: null };
      const cols = Object.keys(row);
      await expect(
        db.execute({
          sql: `INSERT INTO angle_passport (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
          args: cols.map((k) => row[k] ?? null),
        }),
        col,
      ).rejects.toThrow();
    }
    await insertPassport(db, {
      market: "AU",
      angleId: "A-D1-01",
      version: 1,
      domain: 1,
      cluster: "momentum",
      orientation: 1,
      kind: "score",
      inputs: [],
      historyFields: {},
      status: "candidate",
      horizonSessions: 20,
      evidence: {},
      measured: null,
      frozenAt: "2030-01-01T00:00:00Z",
    });
    expect((await latestPassports(db, "AU")).map((p) => p.angleId)).toEqual(["A-D1-01"]);
  });
});

describe("AT-53 distinctness on correlated features", () => {
  const n = 300;
  const prng = prngFor("at53:distinct");
  const col = () => Array.from({ length: n }, () => normal(prng));
  const a = col();
  const b = a.map((v) => v + 0.1 * normal(prng)); // near copy of a
  const c = col();
  const factors = {
    sector: Array.from({ length: n }, (_, i) => (i % 2 === 0 ? "mining" : "banks")),
    beta: col(),
    size: col(),
  };
  const forward = col();

  it("a near-duplicate angle breaks the rank-correlation limit and the whole check; an independent set passes", () => {
    const dup = distinctnessReport({
      angleIds: ["A1", "A2", "A3"],
      clusters: ["momentum", "liquidity", "event"],
      features: [a, b, c],
      factors,
      forward,
    });
    expect(dup.maxRankCorrelation).toBeGreaterThan(MAX_RANK_CORRELATION);
    expect(dup.checks.rankCorrelation).toBe(false);
    expect(dup.pass).toBe(false);

    const indep = distinctnessReport({
      angleIds: ["A1", "A3", "A4"],
      clusters: ["momentum", "liquidity", "event"],
      features: [a, c, col()],
      factors,
      forward,
    });
    expect(indep.maxRankCorrelation).toBeLessThan(MAX_RANK_CORRELATION);
    expect(indep.checks.rankCorrelation).toBe(true);
  });
});

describe("AT-53 the ledger logs a cell before its result, and the result goes in once", () => {
  it("logged_at must be earlier than result_at (CHECK) and a second result is refused", async () => {
    const db = await freshDb("main");
    await logCell(db, {
      cellId: "c1",
      market: "AU",
      family: "F1",
      angleId: "A-D1-01",
      kind: "angle_ic",
      spec: {},
      loggedAt: "2030-03-05T10:00:00Z",
      split: "development",
      lineageId: null,
    });
    await expect(setCellResult(db, "c1", "2030-03-05T10:00:00Z", { ic: 0.02 })).rejects.toThrow();
    await expect(setCellResult(db, "c1", "2030-03-04T10:00:00Z", { ic: 0.02 })).rejects.toThrow();
    expect(await setCellResult(db, "c1", "2030-03-06T10:00:00Z", { ic: 0.02 })).toBe(true);
    expect(await setCellResult(db, "c1", "2030-03-07T10:00:00Z", { ic: 0.99 })).toBe(false);
    expect((await getCell(db, "c1"))!.result).toEqual({ ic: 0.02 });
    await expect(
      db.execute({
        sql: `INSERT INTO cortex_ledger_cell (cell_id, market, family, kind, spec_json, logged_at, result_at,
                result_json, split) VALUES ('c2','AU','F1','x','{}','2030-03-06','2030-03-05','{}','development')`,
        args: [],
      }),
    ).rejects.toThrow();
  });
});

describe("AT-53 Benjamini-Hochberg under positive dependence (PRDS)", () => {
  it("the step-up rule at q = 0.1 on a known list", () => {
    // m = 5, thresholds q*k/m = 0.02, 0.04, 0.06, 0.08, 0.1: the largest k with p(k) <= threshold is 3.
    const p = [0.01, 0.2, 0.03, 0.055, 0.5];
    const bh = benjaminiHochberg(p, 0.1, "prds");
    expect(bh.rejected).toEqual([true, false, true, true, false]);
    expect(bh.dependence).toBe("prds");
    expect(bh.adjusted[0]).toBeCloseTo(0.05, 12);
    // Arbitrary dependence divides q by the harmonic sum, so it rejects no more than PRDS.
    const by = benjaminiHochberg(p, 0.1, "arbitrary");
    expect(by.rejected.filter(Boolean).length).toBeLessThanOrEqual(
      bh.rejected.filter(Boolean).length,
    );
  });

  it("a cell is measured only when BH rejects it and both halves agree in sign", () => {
    const { cells } = measuredCells([
      { id: "a", p: 0.001, firstHalf: 0.02, secondHalf: 0.03 },
      { id: "b", p: 0.001, firstHalf: 0.02, secondHalf: -0.01 },
      { id: "c", p: 0.9, firstHalf: 0.02, secondHalf: 0.03 },
    ]);
    expect(cells.map((x) => x.measured)).toEqual([true, false, false]);
  });
});
