// @vitest-environment node
// M21 L1 (UXN-318, D-1227, AT-82): the golden-set store. Append-only; a label outside the enums is refused (by the code and by
// the table's CHECK); a span must be a piece of the headline; the count is distinct labelled items (skips, unclear answers
// and relabels do not add); nextUnlabelled walks the queue newest first and skips any item that already has a row.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import { appendGolden, goldenCount, nextUnlabelled, type GoldenInput } from "@/lib/labels/golden";
import { allowMarket, cleanupTempDbs, freshDb } from "../db/helpers";

let db: Client;
beforeEach(async () => {
  db = await freshDb("main");
  await allowMarket(db, "IN");
});
afterEach(cleanupTempDbs);

const ann = (
  annId: string,
  at: string,
  title = `Headline ${annId} lifts guidance`,
  market = "AU",
) =>
  db.execute({
    sql: `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, price_sensitive, title, url, source)
          VALUES (?, 'ZZA', ?, ?, ?, 'results', 1, ?, NULL, 'asx')`,
    args: [market, annId, at, at, title],
  });
const full = (annId: string, at: string, over: Partial<GoldenInput> = {}): GoldenInput => ({
  market: "AU",
  source: "asx",
  annId,
  actor: "user:1",
  answer: "labelled",
  guidance: "up",
  eventConfirm: "confirmed",
  tone: "positive",
  span: null,
  at,
  ...over,
});
const rows = async () => (await db.execute("SELECT * FROM golden_label")).rows;

describe("appendGolden", () => {
  it("writes one labelled row", async () => {
    await ann("a1", "2030-01-01T00:00:00Z");
    await appendGolden(db, full("a1", "2030-01-02T03:04:05Z", { span: "lifts guidance" }));
    const r = (await rows())[0]!;
    expect(r).toMatchObject({
      market: "AU",
      ann_id: "a1",
      answer: "labelled",
      guidance: "up",
      event_confirm: "confirmed",
      tone: "positive",
      span: "lifts guidance",
      labelled_at: "2030-01-02T03:04:05.000Z",
    });
  });
  it("a skip and an unclear answer carry no label", async () => {
    await ann("a1", "2030-01-01T00:00:00Z");
    await ann("a2", "2030-01-01T01:00:00Z");
    await appendGolden(db, {
      market: "AU",
      source: "asx",
      annId: "a1",
      actor: "u",
      answer: "skip",
    });
    await appendGolden(db, {
      market: "AU",
      source: "asx",
      annId: "a2",
      actor: "u",
      answer: "unclear",
    });
    const r = await rows();
    expect(r.map((x) => [x.answer, x.guidance, x.event_confirm, x.tone])).toEqual([
      ["skip", null, null, null],
      ["unclear", null, null, null],
    ]);
  });
  it("refuses a value outside the enums, a labelled answer with a gap, and a bad market", async () => {
    await ann("a1", "2030-01-01T00:00:00Z");
    await expect(
      appendGolden(db, full("a1", "2030-01-02", { guidance: "sideways" as never })),
    ).rejects.toThrow(RangeError);
    await expect(
      appendGolden(db, full("a1", "2030-01-02", { tone: null as never })),
    ).rejects.toThrow(RangeError);
    await expect(
      appendGolden(db, full("a1", "2030-01-02", { answer: "maybe" as never })),
    ).rejects.toThrow(RangeError);
    expect(await rows()).toHaveLength(0);
  });
  it("the table itself refuses a value outside the enums", async () => {
    await expect(
      db.execute(
        `INSERT INTO golden_label (market, source, ann_id, labelled_at, actor, answer, guidance, event_confirm, tone)
         VALUES ('AU','asx','x','2030-01-01T00:00:00Z','u','labelled','sideways','confirmed','positive')`,
      ),
    ).rejects.toThrow();
  });
  it("a span must be a piece of the headline", async () => {
    await ann("a1", "2030-01-01T00:00:00Z", "Alpha lifts guidance");
    await expect(
      appendGolden(db, full("a1", "2030-01-02", { span: "cuts guidance" })),
    ).rejects.toThrow(/span/);
    await expect(appendGolden(db, full("a1", "2030-01-02", { span: "" }))).rejects.toThrow(/span/);
    await expect(
      appendGolden(db, full("a1", "2030-01-02", { span: "x".repeat(301) })),
    ).rejects.toThrow(/span/);
    expect(await rows()).toHaveLength(0);
    await appendGolden(db, full("a1", "2030-01-02", { span: "lifts" }));
    expect(await rows()).toHaveLength(1);
  });
  it("an announcement that does not exist is refused", async () => {
    await expect(appendGolden(db, full("nope", "2030-01-02"))).rejects.toThrow(/announcement/);
  });
  it("is append-only: an update or a delete is refused, a relabel is a new row", async () => {
    await ann("a1", "2030-01-01T00:00:00Z");
    await appendGolden(db, full("a1", "2030-01-02T00:00:00Z"));
    await appendGolden(db, full("a1", "2030-01-03T00:00:00Z", { guidance: "down" }));
    expect(await rows()).toHaveLength(2);
    await expect(db.execute("UPDATE golden_label SET tone = 'neutral'")).rejects.toThrow(
      /append-only/,
    );
    await expect(db.execute("DELETE FROM golden_label")).rejects.toThrow(/append-only/);
  });
});

describe("goldenCount", () => {
  it("counts distinct labelled items: skips, unclear answers and relabels do not add", async () => {
    for (const [i, id] of ["a1", "a2", "a3", "a4"].entries())
      await ann(id, `2030-01-0${i + 1}T00:00:00Z`);
    await appendGolden(db, full("a1", "2030-02-01T00:00:00Z"));
    await appendGolden(db, full("a1", "2030-02-02T00:00:00Z", { guidance: "down" })); // relabel
    await appendGolden(db, full("a2", "2030-02-03T00:00:00Z"));
    await appendGolden(db, {
      market: "AU",
      source: "asx",
      annId: "a3",
      actor: "u",
      answer: "skip",
      at: "2030-02-04",
    });
    await appendGolden(db, {
      market: "AU",
      source: "asx",
      annId: "a4",
      actor: "u",
      answer: "unclear",
      at: "2030-02-05",
    });
    expect(await goldenCount(db, "AU")).toBe(2);
    expect(await goldenCount(db, "IN")).toBe(0);
  });
});

describe("nextUnlabelled", () => {
  it("returns the newest announcement of the market with no row, and skips every item that has one", async () => {
    await ann("old", "2030-01-01T00:00:00Z");
    await ann("mid", "2030-01-02T00:00:00Z");
    await ann("new", "2030-01-03T00:00:00Z");
    await ann("other", "2030-01-04T00:00:00Z", "Elsewhere", "IN");
    expect((await nextUnlabelled(db, "AU"))?.annId).toBe("new");
    await appendGolden(db, full("new", "2030-02-01T00:00:00Z"));
    expect((await nextUnlabelled(db, "AU"))?.annId).toBe("mid");
    await appendGolden(db, {
      market: "AU",
      source: "asx",
      annId: "mid",
      actor: "u",
      answer: "skip",
      at: "2030-02-02",
    });
    const n = await nextUnlabelled(db, "AU");
    expect(n).toMatchObject({ annId: "old", source: "asx", market: "AU" });
    await appendGolden(db, {
      market: "AU",
      source: "asx",
      annId: "old",
      actor: "u",
      answer: "unclear",
      at: "2030-02-03",
    });
    expect(await nextUnlabelled(db, "AU")).toBeNull();
  });
  it("never reads the model's labels", async () => {
    const seen: string[] = [];
    const spy = {
      execute: (q: string | { sql: string }) => {
        seen.push(typeof q === "string" ? q : q.sql);
        return db.execute(q as never);
      },
    };
    await ann("a1", "2030-01-01T00:00:00Z");
    await nextUnlabelled(spy as never, "AU");
    await goldenCount(spy as never, "AU");
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expect(s).not.toMatch(/text_label|label_item|label_validation/);
  });
});
