// @vitest-environment node
// M20 A5 (DAT-247, D-1121; AT-75 label clause): the per-market append-only label store. A relabel is a new row and the
// newest wins; nothing is updated or deleted; a market that is off is refused by the database; markets do not mix.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import {
  appendLabel,
  evaluationAllowed,
  labelledCount,
  labelsFor,
  MIN_LABELS_FOR_EVALUATION,
} from "@/lib/labels/store";
import { allowMarket, cleanupTempDbs, freshDb } from "../db/helpers";

let db: Client;
beforeEach(async () => {
  db = await freshDb("main");
  await allowMarket(db, "IN");
  await allowMarket(db, "US");
});
afterEach(cleanupTempDbs);

const label = (market: string, annId: string, l: string, at: string, actor = "owner") =>
  appendLabel(db, { market, source: "src", annId, label: l, actor, at });

describe("appendLabel", () => {
  it("writes one row with the instant normalised to ISO", async () => {
    const r = await label("IN", "a1", "results", "2030-01-02T03:04:05Z");
    expect(r).toMatchObject({
      market: "IN",
      annId: "a1",
      label: "results",
      labelledAt: "2030-01-02T03:04:05.000Z",
    });
    expect((await db.execute("SELECT * FROM label_item")).rows).toHaveLength(1);
  });
  it("refuses a label outside the 11 categories", async () => {
    await expect(label("IN", "a1", "price_sensitive", "2030-01-02")).rejects.toThrow(RangeError);
  });
  it("is append-only: an update or a delete is refused by the table", async () => {
    await label("IN", "a1", "results", "2030-01-02");
    await expect(db.execute("UPDATE label_item SET label = 'other'")).rejects.toThrow(
      /append-only/,
    );
    await expect(db.execute("DELETE FROM label_item")).rejects.toThrow(/append-only/);
  });
  it("a market that is off is refused by the guard", async () => {
    await db.execute("UPDATE market SET enabled = 0 WHERE code = 'US'");
    await expect(label("US", "a1", "results", "2030-01-02")).rejects.toThrow(/MarketNotEnabled/);
  });
});

describe("labelsFor: the newest label per item, per market", () => {
  it("a relabel is a new row; the later one is current, the earlier stays in the table", async () => {
    await label("IN", "a1", "results", "2030-01-02T00:00:00Z");
    await label("IN", "a1", "guidance", "2030-01-03T00:00:00Z", "owner2");
    await label("IN", "a2", "dividend", "2030-01-02T00:00:00Z");
    const rows = await labelsFor(db, "IN");
    expect(rows.map((r) => [r.annId, r.label, r.actor])).toEqual([
      ["a1", "guidance", "owner2"],
      ["a2", "dividend", "owner"],
    ]);
    expect((await db.execute("SELECT * FROM label_item")).rows).toHaveLength(3);
    expect(await labelledCount(db, "IN")).toBe(2);
  });
  it("markets do not mix", async () => {
    await label("IN", "a1", "results", "2030-01-02");
    await label("US", "a1", "halt", "2030-01-02");
    expect((await labelsFor(db, "IN")).map((r) => r.label)).toEqual(["results"]);
    expect((await labelsFor(db, "US")).map((r) => r.label)).toEqual(["halt"]);
    expect(await labelsFor(db, "AU")).toEqual([]);
  });
  it("pages by key past 500 items without losing or repeating one", async () => {
    const stmts = [];
    for (let i = 0; i < 1203; i += 1) {
      stmts.push({
        sql: "INSERT INTO label_item (market, source, ann_id, label, labelled_at, actor) VALUES ('IN', ?, ?, 'other', '2030-01-02T00:00:00.000Z', 'o')",
        args: [i % 2 === 0 ? "s_a" : "s_b", `id${String(i).padStart(5, "0")}`],
      });
    }
    await db.batch(stmts, "write");
    const rows = await labelsFor(db, "IN");
    expect(rows).toHaveLength(1203);
    const keys = rows.map((r) => `${r.source}|${r.annId}`);
    expect(new Set(keys).size).toBe(1203);
    expect([...keys].sort()).toEqual(keys);
  });
});

describe("evaluationAllowed: the 500 threshold (D-1121)", () => {
  async function seed(market: string, n: number): Promise<void> {
    const stmts = [];
    for (let i = 0; i < n; i += 1) {
      stmts.push({
        sql: "INSERT INTO label_item (market, source, ann_id, label, labelled_at, actor) VALUES (?, 'src', ?, 'other', '2030-01-02T00:00:00.000Z', 'o')",
        args: [market, `id${i}`],
      });
    }
    await db.batch(stmts, "write");
  }
  it("is 500", () => {
    expect(MIN_LABELS_FOR_EVALUATION).toBe(500);
  });
  it("499 labelled items: refused; 500: allowed", async () => {
    await seed("IN", 499);
    expect(await evaluationAllowed(db, "IN")).toEqual({
      allowed: false,
      count: 499,
      required: 500,
    });
    await label("IN", "one-more", "results", "2030-01-03");
    expect(await evaluationAllowed(db, "IN")).toEqual({ allowed: true, count: 500, required: 500 });
  });
  it("relabels do not count twice, and the count is per market", async () => {
    await seed("IN", 499);
    await label("IN", "id0", "results", "2030-01-05");
    expect((await evaluationAllowed(db, "IN")).allowed).toBe(false);
    await seed("US", 600);
    expect((await evaluationAllowed(db, "US")).allowed).toBe(true);
    expect((await evaluationAllowed(db, "IN")).count).toBe(499);
  });
});
