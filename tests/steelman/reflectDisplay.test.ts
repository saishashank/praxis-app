// @vitest-environment node
// Looking back (AI-written) on the Picks track record (M22 C3; UXN-288, D-1425, O-54): the loader attaches a written
// reflection to its settled pick row, shows nothing for a `not_written` row, and a masked viewer gets the note with codes
// as letters, dates as weeks and no price figure. Synthetic ZZ data only (SEC-110).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadTrackRecord } from "@/lib/ui/loaders/picks";
import { findLeaks } from "@/lib/view/mask";
import { cleanupTempDbs } from "../db/helpers";
import { CODES, D, envOf, fullWorld, NAMES, type World } from "../loaders/world";

afterAll(cleanupTempDbs);

const NOTE =
  "ZZUP was published on 2026-10-19 with a buy limit of 10.05 and reached its aim at 10.50, ahead of the market by 3.2%.";

let w: World;
beforeAll(async () => {
  w = await fullWorld();
});

const insert = (state: "written" | "not_written", text: string, reason: string | null) =>
  w.main.execute({
    sql: `INSERT INTO pick_reflection (market, d, profile, rank, text, agreed_point_ids_json, provider, model, state, reason, created_at)
          VALUES ('AU', ?, 'balanced', 1, ?, '[]', 'alpha', 'alpha-model', ?, ?, '2026-10-19T09:00:00.000Z')`,
    args: [D, text, state, reason],
  });

describe("track record: Looking back (AI-written)", () => {
  it("a pick with no reflection shows no note", async () => {
    const t = await loadTrackRecord(envOf(w, "owner"), { profile: "balanced" });
    expect(t.rows.every((r) => r.lookingBack === null)).toBe(true);
  });

  it("a not_written row shows nothing", async () => {
    await insert("not_written", "", "not available tonight");
    const t = await loadTrackRecord(envOf(w, "owner"), { profile: "balanced" });
    expect(t.rows.every((r) => r.lookingBack === null)).toBe(true);
    await w.main.execute("DROP TRIGGER pick_reflection_no_delete");
    await w.main.execute("DELETE FROM pick_reflection");
  });

  it("the Owner sees the written note on its pick, as stored", async () => {
    await insert("written", NOTE, null);
    const t = await loadTrackRecord(envOf(w, "owner"), { profile: "balanced" });
    const row = t.rows.find((r) => r.stock === "ZZUP");
    expect(row?.lookingBack).toBe(NOTE);
    expect(t.rows.filter((r) => r.lookingBack !== null)).toHaveLength(1);
  });

  it("a masked viewer gets the note with letters, weeks and no price, and no code leaks", async () => {
    for (const who of ["editor", "viewer"] as const) {
      const t = await loadTrackRecord(envOf(w, who), { profile: "balanced" });
      const row = t.rows.find((r) => r.lookingBack !== null);
      expect(row, who).toBeDefined();
      const text = row!.lookingBack!;
      expect(text).toMatch(/^Stock [A-Z]+ was published on 2026-W43/);
      expect(text).not.toMatch(/10\.05|10\.50/);
      expect(text).toContain("3.2%"); // a percentage is not a price
      expect(findLeaks(text, CODES, NAMES)).toEqual([]);
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    }
  });

  it("an unmasked, granted viewer sees what the Owner sees", async () => {
    const t = await loadTrackRecord(envOf(w, "granted"), { profile: "balanced" });
    expect(t.rows.find((r) => r.stock === "ZZUP")?.lookingBack).toBe(NOTE);
  });
});
