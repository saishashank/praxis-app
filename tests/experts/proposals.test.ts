// @vitest-environment node
// Expert proposals (M13-lite WP5; D-515, D-526, D-536b): every createChallenger result is a row, the weekly cap,
// retry as a new row, same-week re-run, the new-lineage park row, claim moves.
import { afterAll, describe, expect, it } from "vitest";
import { parkedProposals, proposeChallengers } from "@/lib/experts/proposals";
import { currentClaimStatus } from "@/lib/experts/store";
import { cleanupTempDbs } from "../db/helpers";
import { addCluster } from "./zzScreen";
import { addDays, cid, paramsWith, plantedWorld, RUN_D, rows } from "./zzProposals";

afterAll(cleanupTempDbs);

const trials = async (db: Parameters<typeof rows>[0]): Promise<number> =>
  Number(
    (await rows(db, "SELECT COUNT(*) AS n FROM trial_ledger WHERE kind = 'challenger'"))[0]!.n,
  );

describe("proposeChallengers", () => {
  it("creates survivors in rank order up to the weekly cap, one row each, claims move to challenger", async () => {
    const w = await plantedWorld();
    const run = await w.screen(RUN_D);
    expect(run.ranked.length).toBeGreaterThanOrEqual(3);
    const before = await trials(w.db);
    const out = await proposeChallengers(w.ctxAt(RUN_D), run);
    expect(out.map((o) => o.status)).toEqual(["created", "created"]);
    expect(out.map((o) => o.clusterId)).toEqual(run.ranked.slice(0, 2).map((r) => r.clusterId));
    expect(await trials(w.db)).toBe(before + 2);
    const stored = await rows(
      w.db,
      "SELECT id, status, challenger_id, family FROM expert_proposal ORDER BY id",
    );
    expect(stored).toHaveLength(2);
    expect(stored.map((r) => String(r.id))).toEqual(
      out.map((o) => `expprop:AU:${RUN_D}:${o.clusterId}`).sort(),
    );
    for (const r of stored) {
      expect(String(r.challenger_id)).toMatch(/^C-AU-F1-/);
      expect(String(r.family)).toBe("F1");
    }
    expect(await currentClaimStatus(w.db, `C-${out[0]!.clusterId}`)).toBe("challenger");
    expect(await currentClaimStatus(w.db, `C-${run.ranked[2]!.clusterId}`)).toBe("screened");
    const ev = await rows(
      w.db,
      "SELECT actor, reason FROM challenger_event ORDER BY challenger_id, seq LIMIT 1",
    );
    expect(String(ev[0]!.actor)).toBe("A6");
    expect(String(ev[0]!.reason)).toContain("expert cluster");
  });

  it("a same-week re-run creates nothing and writes nothing", async () => {
    const w = await plantedWorld();
    const run = await w.screen(RUN_D);
    await proposeChallengers(w.ctxAt(RUN_D), run);
    const t = await trials(w.db);
    expect(await proposeChallengers(w.ctxAt(RUN_D), run)).toEqual([]);
    expect(await trials(w.db)).toBe(t);
    expect(await rows(w.db, "SELECT id FROM expert_proposal")).toHaveLength(2);
    // an earlier day of the same ISO week (a dispatch) is the same week: the cap counts the rows
    const mid = addDays(RUN_D, -2);
    const run2 = await w.screen(mid);
    expect(await proposeChallengers(w.ctxAt(mid), run2)).toEqual([]);
  });

  it("stores a refusal as a row, tries later survivors, and retries a refused cluster next week as a NEW row", async () => {
    const w = await plantedWorld(4);
    const tight = paramsWith({ maxChallengers: 1 });
    const run = await w.screen(RUN_D, tight);
    const out = await proposeChallengers(w.ctxAt(RUN_D, tight), run);
    expect(out.map((o) => o.status)).toEqual(["created", "refused", "refused", "refused"]);
    const refused = await rows(
      w.db,
      "SELECT reason, challenger_id FROM expert_proposal WHERE status = 'refused'",
    );
    expect(refused).toHaveLength(3);
    expect(String(refused[0]!.reason)).toContain("max_challengers");
    expect(refused[0]!.challenger_id).toBeNull();
    expect(await trials(w.db)).toBe(1);

    const d2 = addDays(RUN_D, 7);
    const run2 = await w.screen(d2);
    const out2 = await proposeChallengers(w.ctxAt(d2), run2);
    // the first cluster already has a challenger: skipped; two refused clusters are created now (cap 2)
    expect(out2.map((o) => o.status)).toEqual(["created", "created"]);
    expect(out2.some((o) => o.clusterId === run.ranked[0]!.clusterId)).toBe(false);
    const all = await rows(w.db, "SELECT id, status FROM expert_proposal ORDER BY id");
    expect(all).toHaveLength(6);
    expect(new Set(all.map((r) => String(r.id))).size).toBe(6);
    expect(all.filter((r) => String(r.status) === "refused")).toHaveLength(3); // old rows untouched
  });

  it("expert_challengers_per_week 0 turns proposals off", async () => {
    const w = await plantedWorld(3);
    const p = paramsWith({ expertChallengersPerWeek: 0 });
    const run = await w.screen(RUN_D, p);
    expect(await proposeChallengers(w.ctxAt(RUN_D, p), run)).toEqual([]);
    expect(await trials(w.db)).toBe(0);
  });

  it("nothing_eligible (no run row) proposes nothing", async () => {
    const w = await plantedWorld(0);
    expect(
      await proposeChallengers(w.ctxAt(RUN_D), { status: "nothing_eligible", ranked: [] }),
    ).toEqual([]);
  });

  it("a run read back as exists proposes from the stored survivors", async () => {
    const w = await plantedWorld(3);
    const first = await w.screen(RUN_D);
    const again = await w.screen(RUN_D);
    expect(again.status).toBe("exists");
    const out = await proposeChallengers(w.ctxAt(RUN_D), again);
    expect(out.map((o) => o.clusterId)).toEqual(first.ranked.slice(0, 2).map((r) => r.clusterId));
  });
});

describe("parkedProposals (D-515)", () => {
  it("writes one parked_build_change row per confirmed testable cluster that needs a new lineage, once", async () => {
    const w = await plantedWorld(1);
    await addCluster(w.db, cid(50), { fit: null }); // confirmed, testable, no fit, no closest family
    await addCluster(w.db, cid(51), { fit: null, state: "proposed" }); // not confirmed: nothing yet
    const out = await parkedProposals(w.ctxAt(RUN_D));
    expect(out.map((o) => o.clusterId)).toEqual([cid(50)]);
    const r = await rows(w.db, "SELECT kind, status, family, challenger_id FROM expert_proposal");
    expect(r).toHaveLength(1);
    expect(String(r[0]!.kind)).toBe("new_lineage");
    expect(String(r[0]!.status)).toBe("parked_build_change");
    expect(r[0]!.family).toBeNull();
    expect(await parkedProposals(w.ctxAt(addDays(RUN_D, 7)))).toEqual([]);
    expect(await rows(w.db, "SELECT id FROM expert_proposal")).toHaveLength(1);
    expect(await trials(w.db)).toBe(0); // parking never reaches createChallenger
  });
});
