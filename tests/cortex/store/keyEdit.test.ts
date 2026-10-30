// @vitest-environment node
// CTX-072: an Owner edit of a Cortex key is a charged trial and marks the map for a refit
// (src/lib/cortex/store/keyEdit.ts). Also the end-to-end call-site shape with setConfig.
import { afterEach, describe, expect, it } from "vitest";
import {
  insertMap,
  isCortexRefitKey,
  KEY_EDIT_CELL_KIND,
  recordCortexKeyEdit,
  refitPending,
  cellsOfKind,
} from "@/lib/cortex/store";
import { setConfig } from "@/lib/config/store";
import { cleanupTempDbs, freshDb } from "../../db/helpers";

afterEach(cleanupTempDbs);

const M = "AU";

const trials = async (db: Awaited<ReturnType<typeof freshDb>>) =>
  (
    await db.execute(
      "SELECT id, lineage_id, split_version, kind, rule_version, variant, d FROM trial_ledger ORDER BY id",
    )
  ).rows.map((r) => ({ ...r }));

const edit = (versionId: number, at = "2030-03-05T10:00:00.000Z") => ({
  market: M,
  key: "max_loss_pct",
  before: 18,
  after: 20,
  versionId,
  at,
  d: "2030-03-05",
});

describe("isCortexRefitKey", () => {
  it("is true for the editable Cortex keys only", () => {
    expect(isCortexRefitKey("cell_min_setups")).toBe(true);
    expect(isCortexRefitKey("cortex_slope_hide_ub")).toBe(true);
    expect(isCortexRefitKey("survivorship_haircut_pp")).toBe(false); // fixed
    expect(isCortexRefitKey("suspension_mark_policy")).toBe(false); // fixed
    expect(isCortexRefitKey("cost_gate_k")).toBe(false); // an M14 key, not a refit key
    expect(isCortexRefitKey("not_a_key")).toBe(false);
  });
});

describe("recordCortexKeyEdit", () => {
  it("writes a counted trial per lineage with a split and the refit marker, once", async () => {
    const db = await freshDb("main");
    // two lineages with a split row (the split table has its own checks; use the simplest valid row)
    for (const f of ["F1", "F3"]) {
      await db.execute({
        sql: "INSERT INTO lineage (id, created_d, parent) VALUES (?, '2030-01-01', NULL)",
        args: [`${M}:${f}`],
      });
      await db.execute({
        sql: `INSERT INTO lineage_split (lineage_id, version, block_sessions, holdout_len, validation_len,
                purge, data_end_d, deferred_until_d, reason)
              VALUES (?, 1, 20, 60, 60, 5, '2030-01-01', '2031-01-01', 'create')`,
        args: [`${M}:${f}`],
      });
    }
    const r = await recordCortexKeyEdit(db, edit(7));
    expect(r.cellId).toBe("keyedit:AU:7");
    expect(r.chargedLineages).toEqual(["AU:F1", "AU:F3"]);
    expect(await trials(db)).toEqual([
      {
        id: "cortex-keyedit:7:F1",
        lineage_id: "AU:F1",
        split_version: 1,
        kind: "challenger",
        rule_version: "cortex:F1.keyedit",
        variant: "key:max_loss_pct",
        d: "2030-03-05",
      },
      {
        id: "cortex-keyedit:7:F3",
        lineage_id: "AU:F3",
        split_version: 1,
        kind: "challenger",
        rule_version: "cortex:F3.keyedit",
        variant: "key:max_loss_pct",
        d: "2030-03-05",
      },
    ]);
    const cells = await cellsOfKind(db, M, "all", KEY_EDIT_CELL_KIND);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.spec).toEqual({
      key: "max_loss_pct",
      before: 18,
      after: 20,
      config_version: 7,
    });
    expect(cells[0]!.result).toBeNull();

    // a retry of the same edit is not charged twice
    await recordCortexKeyEdit(db, edit(7));
    expect(await trials(db)).toHaveLength(2);
    expect(await cellsOfKind(db, M, "all", KEY_EDIT_CELL_KIND)).toHaveLength(1);
    // a second edit is a second charge
    await recordCortexKeyEdit(db, edit(8, "2030-03-06T10:00:00.000Z"));
    expect(await trials(db)).toHaveLength(4);
  });

  it("with no lineage yet it still marks the refit and charges nothing", async () => {
    const db = await freshDb("main");
    const r = await recordCortexKeyEdit(db, edit(1));
    expect(r.chargedLineages).toEqual([]);
    expect(await trials(db)).toEqual([]);
    expect(await cellsOfKind(db, M, "all", KEY_EDIT_CELL_KIND)).toHaveLength(1);
  });

  it("refuses a key that is not an editable Cortex key", async () => {
    const db = await freshDb("main");
    await expect(
      recordCortexKeyEdit(db, { ...edit(1), key: "survivorship_haircut_pp" }),
    ).rejects.toThrow(/not a Cortex key/);
    await expect(recordCortexKeyEdit(db, { ...edit(1), key: "cost_gate_k" })).rejects.toThrow(
      /not a Cortex key/,
    );
  });
});

describe("refitPending", () => {
  const fit = (fittedAt: string) => ({
    market: M,
    family: "F1" as const,
    ruleVersion: "v1",
    fittedAt,
    params: { a: 0, b: 1, s_mean: 0, s_sd: 1, K: 3, clusters: [] },
    activeSetHash: "h",
    nEff: 250,
    pool: "all",
    fitSplit: "development",
  });

  it("is true only when an edit is newer than the newest fit", async () => {
    const db = await freshDb("main");
    expect(await refitPending(db, M)).toBe(false); // no edit
    await recordCortexKeyEdit(db, edit(1, "2030-03-05T10:00:00.000Z"));
    expect(await refitPending(db, M)).toBe(false); // no map yet: nothing to refit
    await insertMap(db, fit("2030-03-01T00:00:00.000Z"));
    expect(await refitPending(db, M)).toBe(true); // the edit is newer than the fit
    await insertMap(db, fit("2030-03-06T00:00:00.000Z"));
    expect(await refitPending(db, M)).toBe(false); // the refit cleared it
    await recordCortexKeyEdit(db, edit(2, "2030-03-07T00:00:00.000Z"));
    expect(await refitPending(db, M)).toBe(true);
  });
});

describe("call site shape with the config store", () => {
  it("an edit through setConfig followed by recordCortexKeyEdit (the one line in updateConfig)", async () => {
    const db = await freshDb("main");
    const res = await setConfig(db, {
      key: "max_loss_pct",
      value: 20,
      userId: 1,
      reason: "test",
      now: "2030-03-05T10:00:00.000Z",
    });
    expect(isCortexRefitKey("max_loss_pct")).toBe(true);
    const r = await recordCortexKeyEdit(db, {
      market: M,
      key: "max_loss_pct",
      before: res.before,
      after: res.after,
      versionId: res.versionId,
      at: "2030-03-05T10:00:00.000Z",
      d: "2030-03-05",
    });
    expect(r.cellId).toBe(`keyedit:AU:${res.versionId}`);
    expect((await cellsOfKind(db, M, "all", KEY_EDIT_CELL_KIND))[0]!.spec).toEqual({
      key: "max_loss_pct",
      before: 18,
      after: 20,
      config_version: res.versionId,
    });
  });
});
