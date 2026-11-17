// M23 R2 (D-1628): the passport and cell import refuses a lineage ending _p5000 (a larger-parcel sensitivity variant is a
// simulation, never able to trade). Synthetic data only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SENSITIVITY_SUFFIX, validateCells } from "./import.mjs";

const cell = (over = {}) => ({
  cell_id: "zz-cell-1",
  family: "F1",
  angle_id: null,
  kind: "placebo",
  spec: {},
  logged_at: "2026-11-01T00:00:00Z",
  result_at: null,
  result: null,
  split: "development",
  lineage_id: "zz_lineage",
  ...over,
});

test("a cell of an ordinary lineage passes the shape check", () => {
  assert.deepEqual(validateCells({ cells: [cell()] }), []);
});

test("a cell whose lineage ends _p5000 is refused", () => {
  assert.equal(SENSITIVITY_SUFFIX, "_p5000");
  const bad = validateCells({ cells: [cell({ lineage_id: "cxa003_hi52_vol_p5000" })] });
  assert.equal(bad.length, 1);
  assert.match(bad[0], /never imported/);
});

test("a cell naming such a lineage as its angle is refused too", () => {
  const bad = validateCells({ cells: [cell({ angle_id: "zz_angle_p5000" })] });
  assert.equal(bad.length, 1);
});

test("a passport whose angle id ends _p5000 is refused", async () => {
  const { validatePassports } = await import("./import.mjs");
  const bad = validatePassports({ passports: [{ angle_id: "zz_angle_p5000" }] });
  assert.ok(bad.some((m) => /never imported/.test(m)));
});
