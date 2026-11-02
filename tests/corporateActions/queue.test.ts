// @vitest-environment node
// The review queue read model (UX-114) against a real local libSQL file. Synthetic ZZ* data only.
import { afterEach, describe, expect, it } from "vitest";
import { setConfig } from "@/lib/config/store";
import { loadReviewQueue } from "@/lib/data/corporateActions/queue";
import { runCorporateActions } from "@/lib/data/corporateActions/engine.mjs";
import { cleanupTempDbs } from "../db/helpers";
import { announced, caDb, D0, D1, io, nowOf, putBar, vendor } from "./helpers";

afterEach(cleanupTempDbs);

const run = (db: Awaited<ReturnType<typeof caDb>>, d: string, o: Record<string, unknown> = {}) =>
  runCorporateActions({ db, market: "AU", d, io: io(), now: nowOf(d), ...o });

describe("loadReviewQueue", () => {
  it("lists Owner-queue conflicts with plain-language evidence and the date it is applied", async () => {
    const db = await caDb();
    await putBar(db, "ZZA", D0, 10);
    await putBar(db, "ZZA", D1, 5);
    await run(db, D1, {
      candidates: [
        announced("ZZA", "split", D1, { new: 2, old: 1 }),
        vendor("ZZA", "split", D1, { new: 3, old: 1 }),
      ],
    });
    const q = await loadReviewQueue(db);
    expect(q.blockedOnly).toBe(0);
    expect(q.cards).toHaveLength(2);
    expect(q.cards[0]).toMatchObject({
      id: 1,
      code: "ZZA",
      typeLabel: "share split",
      exDate: D1,
      terms: "1 old share(s) become 2 new share(s)",
      sources: ["announcement"],
      queuedOn: D1,
      applyOn: "2026-10-20", // 5 sessions after Tue 13 Oct
      neverAuto: false,
    });
    expect(q.cards[0].observed).toBeCloseTo(0.5, 10);
    expect(q.cards[0].reasons).toEqual(["the sources disagree about the terms"]);
    expect(q.cards[0].alternatives).toEqual(["share split: 1 old share(s) become 3 new share(s)"]);
    expect(q.cards[1].reasons).toContain("the price move does not match the terms");
  });

  it("follows the configured number of sessions", async () => {
    const db = await caDb();
    await putBar(db, "ZZA", D0, 10);
    await putBar(db, "ZZA", D1, 5);
    await setConfig(db, {
      key: "corporate_action_auto_apply_sessions",
      value: 2,
      userId: null,
      now: nowOf(D0),
    });
    await run(db, D1);
    const card = (await loadReviewQueue(db)).cards[0];
    expect(card.applyOn).toBe("2026-10-15");
    // a price-only jump (GL-01) is never applied automatically
    expect(card.neverAuto).toBe(true);
  });

  it("is empty when nothing is queued; blocked-only conflicts are only counted", async () => {
    const db = await caDb();
    expect(await loadReviewQueue(db)).toEqual({ cards: [], blockedOnly: 0 });
    await putBar(db, "ZZA", D0, 10);
    await putBar(db, "ZZA", D1, 10);
    await run(db, D1, {
      candidates: [announced("ZZA", "split", D1, { new: 2, old: 1 })],
      relevant: () => false,
    });
    expect(await loadReviewQueue(db)).toEqual({ cards: [], blockedOnly: 1 });
  });

  it("resolved items leave the queue", async () => {
    const db = await caDb();
    await putBar(db, "ZZA", D0, 10);
    await putBar(db, "ZZA", D1, 5);
    await run(db, D1);
    expect((await loadReviewQueue(db)).cards).toHaveLength(1);
    await db.execute({
      sql: "INSERT INTO corporate_action_event (action_id, at, status, by, note) VALUES (1, ?, 'resolved', 'owner:1', ?)",
      args: ["2026-10-13T09:00:00.000Z", JSON.stringify({ d: D1, resolution: "rejected" })],
    });
    expect((await loadReviewQueue(db)).cards).toEqual([]);
  });
});
