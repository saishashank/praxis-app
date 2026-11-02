// CTX-041 opinion_track hook (M15 P5): pure builder, recorded with later settlement, never scored.
import { afterEach, describe, expect, it } from "vitest";
import { unsettledOpinions } from "@/lib/cortex/store/labels";
import { buildOpinion, recordOpinion, settleRecordedOpinion } from "@/lib/llm/textLabels";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const IN = {
  market: "AU",
  kind: "committee" as const,
  code: "ZZA",
  d: "2026-03-05",
  value: { view: "buy", n: 3 },
};

describe("opinion hook", () => {
  it("builds a deterministic row", () => {
    expect(buildOpinion(IN)).toEqual(buildOpinion({ ...IN, value: { n: 3, view: "buy" } }));
    expect(buildOpinion(IN).opinionId).toMatch(/^committee:ZZA:2026-03-05:[0-9a-f]{12}$/);
  });

  it("records, keeps the first on repeat, and settles once", async () => {
    const db = await freshDb("main");
    expect((await recordOpinion(db, IN)).inserted).toBe(true);
    expect((await recordOpinion(db, IN)).inserted).toBe(false);
    const open = await unsettledOpinions(db, "AU", "2026-03-31");
    expect(open).toHaveLength(1);
    const id = open[0]!.opinionId;
    expect(await settleRecordedOpinion(db, "AU", id, "2026-03-12", { ar: 0.01 })).toBe(true);
    expect(await settleRecordedOpinion(db, "AU", id, "2026-03-13", { ar: 0.5 })).toBe(false);
    expect(await unsettledOpinions(db, "AU", "2026-03-31")).toEqual([]);
  });
});
