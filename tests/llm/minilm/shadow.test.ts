// @vitest-environment node
// M22 L5 (LLM-079, D-1416): the shadow stage with a fake embedder: both answers stored side by side, agreement computed, bounded
// writes, idempotence, and every "not ready" case writes nothing. Synthetic ZZ announcements only (SEC-110).
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  agreementOf,
  isMaterialCategory,
  shadowNight,
  shadowSummary,
  textOf,
} from "@/lib/llm/minilm/shadow";
import { cleanupTempDbs, freshDb } from "../../db/helpers";
import { fakeEmbedder, headOf, lockOf, SHA_A } from "./helpers";

afterEach(cleanupTempDbs);

const D = "2030-01-02";
const NOW = "2030-01-02T10:00:00.000Z";

async function seed(
  db: Client,
  rows: Array<[string, string | null, string, string?]>,
): Promise<void> {
  let i = 0;
  for (const [annId, type, title, at] of rows) {
    await db.execute({
      sql: `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, title, source)
            VALUES ('AU', 'ZZAA', ?, ?, ?, ?, ?, 'zz')`,
      args: [annId, at ?? `${D}T0${(i++ % 9) + 1}:00:00.000Z`, NOW, type, title],
    });
  }
}

const base = (db: Client, over: Record<string, unknown> = {}) => ({
  market: "AU",
  d: D,
  enabled: true,
  cap: 40,
  head: headOf(),
  lock: lockOf(),
  embedder: fakeEmbedder(),
  now: NOW,
  db,
  ...over,
});
const run = (db: Client, over: Record<string, unknown> = {}) => {
  const { db: _d, ...x } = base(db, over);
  void _d;
  return shadowNight(db, x as never);
};
const count = async (db: Client): Promise<number> =>
  Number((await db.execute("SELECT COUNT(*) n FROM minilm_shadow")).rows[0]!.n);

describe("shadowNight", () => {
  it("stores the rule answer and the model answer side by side and counts agreement", async () => {
    const db = await freshDb("main");
    await seed(db, [
      ["1", "Trading Halt", "Trading Halt"], // rule: halt_suspension, model: halt_suspension
      ["2", null, "Quarterly update"], // rule: other, model: other
      ["3", null, "Chalton update"], // rule: other, model: halt_suspension (the fake reads the substring)
    ]);
    const r = await run(db);
    expect(r).toMatchObject({ status: "written", written: 3, reason: null });
    expect(r.agreement).toEqual({ rows: 3, agree: 2, materialAgree: 2 });
    const rows = (
      await db.execute(
        "SELECT ann_id, rule_category, model_category, rule_material, model_material, model_sha FROM minilm_shadow ORDER BY ann_id",
      )
    ).rows.map((x) => [
      x.ann_id,
      x.rule_category,
      x.model_category,
      x.rule_material,
      x.model_material,
      x.model_sha,
    ]);
    expect(rows).toEqual([
      ["1", "halt_suspension", "halt_suspension", 1, 1, SHA_A],
      ["2", "other", "other", 0, 0, SHA_A],
      ["3", "other", "halt_suspension", 0, 1, SHA_A],
    ]);
    expect(await agreementOf(db, "AU", D)).toEqual(r.agreement);
    expect(shadowSummary("AU", D, r)).toBe(
      "minilm-shadow AU 2030-01-02: written written=3 rows=3 agree=2 material_agree=2",
    );
  });

  it("reads only the night's day and the type words with the title", async () => {
    const db = await freshDb("main");
    await seed(db, [
      ["1", "Trading Halt", "x", `${D}T23:59:59.000Z`],
      ["2", null, "y", "2030-01-03T00:00:00.000Z"],
      ["3", null, "z", "2030-01-01T23:59:59.000Z"],
    ]);
    const e = fakeEmbedder();
    await run(db, { embedder: e });
    expect(e.calls).toEqual([[textOf("Trading Halt", "x")]]);
    expect(await count(db)).toBe(1);
  });

  it("writes at most the cap, and a re-run adds only the room that is left, never a duplicate", async () => {
    const db = await freshDb("main");
    await seed(
      db,
      Array.from({ length: 7 }, (_, i): [string, string | null, string] => [
        `a${i}`,
        null,
        `Item ${i}`,
      ]),
    );
    expect((await run(db, { cap: 3 })).written).toBe(3);
    expect(await count(db)).toBe(3);
    const again = await run(db, { cap: 3 });
    expect(again).toMatchObject({ status: "nothing", written: 0 });
    expect(await count(db)).toBe(3);
    expect((await run(db, { cap: 5 })).written).toBe(2);
    expect((await run(db, { cap: 500 })).written).toBe(2);
    expect(await count(db)).toBe(7);
    expect((await run(db, { cap: 500 })).status).toBe("nothing");
  });

  it("off writes nothing and does not call the model", async () => {
    const db = await freshDb("main");
    await seed(db, [["1", null, "Item"]]);
    const e = fakeEmbedder();
    expect(await run(db, { enabled: false, embedder: e })).toMatchObject({
      status: "off",
      written: 0,
    });
    expect(e.calls).toEqual([]);
    expect(await count(db)).toBe(0);
  });

  it("an untrained head, an unpinned lock and a different model all write nothing (fail closed)", async () => {
    const db = await freshDb("main");
    await seed(db, [["1", null, "Item"]]);
    expect(await run(db, { head: headOf({ trained: false }) })).toMatchObject({
      status: "not_ready",
      written: 0,
    });
    expect(await run(db, { lock: lockOf(null) })).toMatchObject({ status: "not_ready" });
    expect(await run(db, { embedder: fakeEmbedder({ modelSha: "f".repeat(64) }) })).toMatchObject({
      status: "unavailable",
    });
    expect(await run(db, { embedder: null })).toMatchObject({ status: "unavailable" });
    expect(await count(db)).toBe(0);
  });

  it("an embedder that throws or returns the wrong count writes nothing and does not throw", async () => {
    const db = await freshDb("main");
    await seed(db, [["1", null, "Item"]]);
    const boom = fakeEmbedder({ embed: () => Promise.reject(new Error("x")) });
    expect(await run(db, { embedder: boom })).toMatchObject({ status: "unavailable", written: 0 });
    const short = fakeEmbedder({ embed: () => Promise.resolve([]) });
    expect(await run(db, { embedder: short })).toMatchObject({ status: "unavailable", written: 0 });
    expect(await count(db)).toBe(0);
  });

  it("the table is append-only", async () => {
    const db = await freshDb("main");
    await seed(db, [["1", null, "Item"]]);
    await run(db);
    await expect(db.execute("UPDATE minilm_shadow SET model_category = 'x'")).rejects.toThrow(
      /append-only/,
    );
    await expect(db.execute("DELETE FROM minilm_shadow")).rejects.toThrow(/append-only/);
  });
});

describe("material", () => {
  it("every category but other is material", () => {
    expect(isMaterialCategory("other")).toBe(false);
    expect(isMaterialCategory("results")).toBe(true);
  });
});
