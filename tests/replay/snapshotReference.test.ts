// @vitest-environment node
// M14 WP6: reference data in the replay snapshot (DAT-234 index changes, FAM-006 industry) and the
// world's decision cut-off (GL-02). Empty tables write no manifest count, so older snapshots keep
// their bytes. Synthetic data only.
import { describe, expect, it } from "vitest";
import { decisionCutoffUtc } from "@/lib/agents/decisionView";
import { defaultAgentParams } from "@/lib/agents/params";
import { buildSnapshot, loadSnapshot, SnapshotError } from "@/lib/replay/snapshot";
import { SnapshotWorld } from "@/lib/replay/snapshotWorld";

const base = {
  bars: [],
  calendar: [],
  universe: [],
  index_bars: [],
  corporate_actions: [],
  announcements: [],
  cutoff_polls: [],
};
const range = { from: "2026-10-01", to: "2026-10-16" };

describe("snapshot reference tables", () => {
  it("empty tables leave the manifest and the sha as they were", () => {
    const a = buildSnapshot({ ...range, inputs: base });
    const b = buildSnapshot({ ...range, inputs: { ...base, index_changes: [], industry: [] } });
    expect(b.sha).toBe(a.sha);
    expect(Object.keys(b.counts)).not.toContain("index_changes");
  });

  it("round-trips index changes and industry rows known by the end of the range", () => {
    const s = buildSnapshot({
      ...range,
      inputs: {
        ...base,
        index_changes: [
          {
            code: "AAA",
            index_name: "ASX 200",
            kind: "add",
            announced: "2026-10-02",
            effective: "2026-10-19",
          },
          {
            code: "BBB",
            index_name: "ASX 200",
            kind: "delete",
            announced: "2026-10-20",
            effective: "2026-10-30",
          },
          {
            code: "CCC",
            index_name: "ASX 200",
            kind: "add",
            announced: null,
            effective: "2026-10-05",
          },
        ],
        industry: [
          { code: "AAA", industry: "Banks", source: "instrument", as_of: "2026-10-01" },
          { code: "AAA", industry: "Major Banks", source: "class", as_of: "2026-10-10" },
        ],
      },
    });
    expect(s.counts.index_changes).toBe(2); // BBB was announced after the range
    expect(s.counts.industry).toBe(2);
    const snap = loadSnapshot(s.bytes);
    expect((snap.tables.index_changes as { code: string }[]).map((r) => r.code)).toEqual([
      "AAA",
      "CCC",
    ]);
  });

  it("rejects a bad kind or source", () => {
    const bad = (inputs: object) => () =>
      buildSnapshot({ ...range, inputs: { ...base, ...inputs } });
    expect(
      bad({
        index_changes: [
          { code: "A", index_name: "x", kind: "move", announced: null, effective: "2026-10-05" },
        ],
      }),
    ).toThrow(SnapshotError);
    expect(
      bad({ industry: [{ code: "A", industry: "x", source: "csv", as_of: "2026-10-05" }] }),
    ).toThrow(SnapshotError);
  });
});

describe("SnapshotWorld", () => {
  const params = defaultAgentParams();
  const world = () =>
    new SnapshotWorld(
      loadSnapshot(
        buildSnapshot({
          ...range,
          inputs: {
            ...base,
            calendar: [{ d: "2026-10-15", kind: "session", close_time: null, confirmed: 1 }],
          },
        }).bytes,
      ),
      { params },
    );

  it("decisionCutoffOf is the batch 2b cut-off of the session", () => {
    expect(world().decisionCutoffOf("2026-10-15")).toBe(
      decisionCutoffUtc("2026-10-15", params.decisionCutoff),
    );
  });
});

describe("snapshotLoad reference queries", () => {
  it("reads index changes known by the end of the range and the two industry sources", async () => {
    const { freshDb, cleanupTempDbs } = await import("../db/helpers");
    const { loadInputs } = await import("@/lib/data/backfill/snapshotLoad.mjs");
    const db = await freshDb("main");
    try {
      await db.batch(
        [
          `INSERT INTO instrument (market, code, name, industry) VALUES ('AU', 'AAA', 'A', 'Banks')`,
          `INSERT INTO instrument_class (market, code, industry, source, as_of, loaded_at)
           VALUES ('AU', 'AAA', 'Major Banks', 'csv', '2026-10-10', '2026-10-11T00:00:00Z')`,
          `INSERT INTO index_change (market, code, index_name, kind, announced_d, effective_d, source, loaded_at)
           VALUES ('AU', 'AAA', 'ASX 200', 'add', '2026-10-02', '2026-10-19', 'csv', '2026-10-03T00:00:00Z'),
                  ('AU', 'BBB', 'ASX 200', 'add', '2026-10-20', '2026-10-30', 'csv', '2026-10-03T00:00:00Z')`,
        ],
        "write",
      );
      const inputs = await loadInputs({ db, readAsset: () => null, ...range });
      expect(inputs.index_changes).toEqual([
        {
          code: "AAA",
          index_name: "ASX 200",
          kind: "add",
          announced: "2026-10-02",
          effective: "2026-10-19",
        },
      ]);
      expect(inputs.industry).toEqual([
        { code: "AAA", industry: "Major Banks", source: "class", as_of: "2026-10-10" },
        { code: "AAA", industry: "Banks", source: "instrument", as_of: range.from },
      ]);
      // and the builder accepts them
      expect(buildSnapshot({ ...range, inputs }).counts.industry).toBe(2);
    } finally {
      await cleanupTempDbs();
    }
  }, 120_000);
});
