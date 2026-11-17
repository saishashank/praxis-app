// @vitest-environment node
// M23 T1 (CXA-008, D-1636, D-1661): agreement of the text labels with the Owner's golden labels. The Wilson bound is
// hand-checked; 499 labelled items are refused and 500 run; the floor is read through the config store with a typed default
// (the key label_golden_min is registered by M23 A1; until then the default 500 is used, which is the same value).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import { agreement, AGREEMENT_THRESHOLD, wilsonLower, Z_90 } from "@/lib/labels/agreement";
import { LabelsBelowMinimum } from "@/lib/labels/evaluate";
import { goldenMin } from "@/lib/labels/store";
import { allowMarket, cleanupTempDbs, freshDb } from "../db/helpers";

describe("wilsonLower (one-sided 90 %, hand-checked)", () => {
  it("uses the 0.90 normal quantile", () => {
    expect(Z_90).toBeCloseTo(1.2815515655, 9);
  });
  it("9 of 10 is 0.71756", () => {
    // z^2 = 1.64237; z^2/20 = 0.082119; sqrt(0.009 + 0.0041059) = 0.114477; z * that = 0.146706
    // numerator = 0.9 + 0.082119 - 0.146706 = 0.835413; denominator = 1 + 0.164237 = 1.164237; ratio = 0.71756
    expect(wilsonLower(9, 10)).toBeCloseTo(0.71756, 4);
  });
  it("all 100 of 100 is 1 / (1 + z^2/100) = 0.98384", () => {
    expect(wilsonLower(100, 100)).toBeCloseTo(0.98384, 5);
  });
  it("none agree gives 0, and no items gives 0", () => {
    expect(wilsonLower(0, 50)).toBeCloseTo(0, 12);
    expect(wilsonLower(0, 0)).toBe(0);
  });
  it("450 of 500 is 0.88147, 425 of 500 is 0.82839", () => {
    expect(wilsonLower(450, 500)).toBeCloseTo(0.88147, 5);
    expect(wilsonLower(425, 500)).toBeCloseTo(0.82839, 5);
  });
});

let db: Client;
beforeEach(async () => {
  db = await freshDb("main");
  await allowMarket(db, "IN");
});
afterEach(cleanupTempDbs);

const AT = "2030-01-02T03:04:05.000Z";
const id = (i: number) => `a${String(i).padStart(4, "0")}`;

/** Inserts `n` golden items (guidance up, event confirmed, tone positive), with a text label for the first `texts` of them. */
async function seed(
  n: number,
  opts: { texts?: number; wrongTone?: number; market?: string } = {},
): Promise<void> {
  const market = opts.market ?? "AU";
  const texts = opts.texts ?? n;
  const stmts: { sql: string; args: (string | number)[] }[] = [];
  for (let i = 0; i < n; i++) {
    stmts.push({
      sql: `INSERT INTO golden_label (market, source, ann_id, labelled_at, actor, answer, guidance, event_confirm, tone, span)
            VALUES (?, 'src', ?, ?, 'user:1', 'labelled', 'up', 'confirmed', 'positive', NULL)`,
      args: [market, id(i), AT],
    });
    if (i < texts) {
      const vid = `v-${market}-${i}`;
      stmts.push({
        sql: "INSERT INTO label_validation (validation_id, market, kind, result_json, created_at) VALUES (?, ?, 'paraphrase', '{}', ?)",
        args: [vid, market, AT],
      });
      const tone = i < (opts.wrongTone ?? 0) ? "negative" : "positive";
      for (const [kind, value] of [
        ["guidance", "up"],
        ["event_confirm", "confirmed"],
        ["tone", tone],
      ] as const) {
        stmts.push({
          sql: `INSERT INTO text_label (market, announcement_id, label_kind, model_id, produced_at, value, cited_span, manifest_id, validation_id)
                VALUES (?, ?, ?, 'mock/m', ?, ?, NULL, 'mf', ?)`,
          args: [market, `src|${id(i)}`, kind, AT, value, vid],
        });
      }
    }
  }
  await db.batch(stmts, "write");
}

describe("agreement", () => {
  it("the floor reads the key through the config store, defaulting to 500", async () => {
    expect(await goldenMin(db)).toBe(500);
  });

  it("refuses 499 labelled items", async () => {
    await seed(499);
    await expect(agreement(db, "AU")).rejects.toThrow(LabelsBelowMinimum);
    await expect(agreement(db, "AU")).rejects.toMatchObject({ count: 499, required: 500 });
  });

  it("runs at 500 items: per label agreement with its Wilson bound", async () => {
    await seed(500, { wrongTone: 50 });
    const r = await agreement(db, "AU");
    expect(r.items).toBe(500);
    expect(r.threshold).toBe(AGREEMENT_THRESHOLD);
    const by = Object.fromEntries(r.byLabel.map((x) => [x.kind, x]));
    expect(by.guidance).toMatchObject({ n: 500, agree: 500, missing: 0, clears: true });
    expect(by.guidance!.lower).toBeCloseTo(wilsonLower(500, 500), 12);
    expect(by.tone).toMatchObject({ n: 500, agree: 450, missing: 0, clears: true });
    expect(by.tone!.lower).toBeCloseTo(0.88147, 5);
  });

  it("an item with no text label counts as a disagreement and is reported as missing", async () => {
    await seed(500, { texts: 400 });
    const r = await agreement(db, "AU");
    const tone = r.byLabel.find((x) => x.kind === "tone")!;
    expect(tone).toMatchObject({ n: 500, agree: 400, missing: 100 });
    expect(tone.lower).toBeCloseTo(wilsonLower(400, 500), 12);
    expect(tone.clears).toBe(true);
    const strict = await agreement(db, "AU", { threshold: 0.9 });
    expect(strict.byLabel.every((x) => !x.clears)).toBe(true);
  });

  it("uses the Owner's latest labelled answer; a later skip does not replace it", async () => {
    await seed(500);
    await db.execute({
      sql: `INSERT INTO golden_label (market, source, ann_id, labelled_at, actor, answer, guidance, event_confirm, tone, span)
            VALUES ('AU', 'src', ?, '2030-02-01T00:00:00.000Z', 'user:1', 'labelled', 'down', 'confirmed', 'negative', NULL)`,
      args: [id(0)],
    });
    await db.execute({
      sql: `INSERT INTO golden_label (market, source, ann_id, labelled_at, actor, answer, guidance, event_confirm, tone, span)
            VALUES ('AU', 'src', ?, '2030-03-01T00:00:00.000Z', 'user:1', 'skip', NULL, NULL, NULL, NULL)`,
      args: [id(0)],
    });
    const r = await agreement(db, "AU");
    expect(r.items).toBe(500);
    expect(r.byLabel.find((x) => x.kind === "tone")!.agree).toBe(499);
    expect(r.byLabel.find((x) => x.kind === "guidance")!.agree).toBe(499);
  });

  it("counts per market: another market's items do not make up the floor", async () => {
    await seed(300);
    await seed(300, { market: "IN" });
    await expect(agreement(db, "AU")).rejects.toThrow(LabelsBelowMinimum);
  });
});
