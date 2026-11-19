// @vitest-environment node
// AT-75 (label clause, M23 T1; CXA-008, DAT-247, D-1121, D-1636): the label evaluation refuses below 500 labelled items; the
// golden and classifier label stores stay append-only per market (the M20/M21 clauses kept); a market that is off is refused.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import { agreement } from "@/lib/labels/agreement";
import { evaluateClassifier, LabelsBelowMinimum } from "@/lib/labels/evaluate";
import { appendLabel, evaluationAllowed } from "@/lib/labels/store";
import { appendGolden } from "@/lib/labels/golden";
import { allowMarket, cleanupTempDbs, freshDb } from "../../db/helpers";

let db: Client;
beforeEach(async () => {
  db = await freshDb("main");
  await allowMarket(db, "IN");
});
afterEach(cleanupTempDbs);

const AT = "2030-01-02T03:04:05.000Z";

async function golden(from: number, to: number): Promise<void> {
  const stmts: { sql: string; args: (string | number)[] }[] = [];
  for (let i = from; i < to; i++) {
    stmts.push({
      sql: `INSERT INTO golden_label (market, source, ann_id, labelled_at, actor, answer, guidance, event_confirm, tone, span)
            VALUES ('AU', 'src', ?, ?, 'user:1', 'labelled', 'up', 'confirmed', 'positive', NULL)`,
      args: [`a${i}`, AT],
    });
  }
  await db.batch(stmts, "write");
}

describe("AT-75 label clause", () => {
  it("the agreement evaluation refuses at 499 labelled items and runs at 500", async () => {
    await golden(0, 499);
    await expect(agreement(db, "AU")).rejects.toThrow(LabelsBelowMinimum);
    await golden(499, 500);
    const r = await agreement(db, "AU");
    expect(r.items).toBe(500);
    expect(r.byLabel).toHaveLength(3);
  });

  it("the classifier evaluation also refuses below 500 (M20 clause kept)", async () => {
    expect(await evaluationAllowed(db, "AU")).toEqual({ allowed: false, count: 0, required: 500 });
    await expect(evaluateClassifier(db, "AU")).rejects.toThrow(LabelsBelowMinimum);
  });

  it("golden labels are append-only: an update or a delete is refused", async () => {
    await golden(0, 1);
    await expect(db.execute("UPDATE golden_label SET tone = 'negative'")).rejects.toThrow(
      /append-only/,
    );
    await expect(db.execute("DELETE FROM golden_label")).rejects.toThrow(/append-only/);
  });

  it("labels stay per market: a market that is off is refused by the guard, counts do not mix", async () => {
    await appendLabel(db, {
      market: "IN",
      source: "s",
      annId: "x",
      label: "results",
      actor: "o",
      at: AT,
    });
    await db.execute("UPDATE market SET enabled = 0 WHERE code = 'IN'");
    await expect(
      appendLabel(db, {
        market: "IN",
        source: "s",
        annId: "y",
        label: "results",
        actor: "o",
        at: AT,
      }),
    ).rejects.toThrow(/MarketNotEnabled/);
    await expect(
      appendGolden(db, { market: "IN", source: "s", annId: "z", actor: "o", answer: "skip" }),
    ).rejects.toThrow();
    expect((await evaluationAllowed(db, "AU")).count).toBe(0);
  });
});
