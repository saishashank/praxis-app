// @vitest-environment node
// M20 A5 (DAT-247, D-1121; AT-75 500-refusal clause): the evaluation of the announcement classifier against a market's
// hand labels refuses below 500 labelled items and, at 500 or more, scores the stored categories against the labels.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import {
  assertEvaluationAllowed,
  evaluateClassifier,
  LabelsBelowMinimum,
} from "@/lib/labels/evaluate";
import { allowMarket, cleanupTempDbs, freshDb } from "../db/helpers";

let db: Client;
beforeEach(async () => {
  db = await freshDb("main");
  await allowMarket(db, "IN");
});
afterEach(cleanupTempDbs);

/** n labelled items, `missing` of which the classifier never classified and the next `wrong` it got wrong. */
async function seed(n: number, wrong: number, missing: number): Promise<void> {
  const stmts = [];
  for (let i = 0; i < n; i += 1) {
    const id = `id${String(i).padStart(4, "0")}`;
    const label = i % 2 === 0 ? "results" : "dividend";
    stmts.push({
      sql: "INSERT INTO label_item (market, source, ann_id, label, labelled_at, actor) VALUES ('IN', 's', ?, ?, '2030-01-02T00:00:00.000Z', 'o')",
      args: [id, label],
    });
    if (i < missing) continue;
    // a wrong answer is a category that differs from the label (never 'other' for a label that is 'other')
    const stored = i < missing + wrong ? "other" : label;
    stmts.push({
      sql: "INSERT INTO announcement_category (market, source, ann_id, category, materiality, verifiable, map_version) VALUES ('IN', 's', ?, ?, 1, 0, 'v1')",
      args: [id, stored],
    });
  }
  await db.batch(stmts, "write");
}

describe("the 500 refusal", () => {
  it("fewer than 500 labelled items: evaluateClassifier throws LabelsBelowMinimum and says how many", async () => {
    await seed(499, 0, 0);
    const err = await evaluateClassifier(db, "IN").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LabelsBelowMinimum);
    expect(err).toMatchObject({ market: "IN", count: 499, required: 500 });
    expect((err as Error).message).toMatch(/499 labelled items, 500 are needed/);
    await expect(assertEvaluationAllowed(db, "IN")).rejects.toThrow(LabelsBelowMinimum);
  });
  it("another market's labels do not open the gate", async () => {
    await allowMarket(db, "US");
    await seed(499, 0, 0);
    await db.execute({
      sql: "INSERT INTO label_item (market, source, ann_id, label, labelled_at, actor) VALUES ('US', 's', ?, 'other', '2030-01-02T00:00:00.000Z', 'o')",
      args: ["x"],
    });
    await expect(evaluateClassifier(db, "IN")).rejects.toThrow(LabelsBelowMinimum);
  });
});

describe("evaluation at 500 or more", () => {
  it("scores the stored categories against the labels: overall and per labelled category", async () => {
    await seed(600, 40, 10);
    const e = await evaluateClassifier(db, "IN");
    expect(e).toMatchObject({
      market: "IN",
      labelled: 600,
      correct: 550,
      unclassified: 10,
      accuracy: "550/600",
    });
    expect(Object.values(e.byCategory).reduce((a, c) => a + c.labelled, 0)).toBe(600);
    expect(Object.values(e.byCategory).reduce((a, c) => a + c.correct, 0)).toBe(550);
    expect(Object.keys(e.byCategory).sort()).toEqual(["dividend", "results"]);
  });
  it("exactly 500 is enough, and the newest relabel is what is scored", async () => {
    await seed(500, 0, 0);
    await db.execute(
      "INSERT INTO label_item (market, source, ann_id, label, labelled_at, actor) VALUES ('IN', 's', 'id0000', 'other', '2030-02-01T00:00:00.000Z', 'o2')",
    );
    const e = await evaluateClassifier(db, "IN");
    expect(e.labelled).toBe(500);
    expect(e.correct).toBe(499); // id0000 was relabelled to 'other', the stored category is 'results'
  });
});
