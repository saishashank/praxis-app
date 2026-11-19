// @vitest-environment node
// UXN-323 (M21 C4; D-1310, D-1311): a subject cut by the daily limit gets a zero-item pack, its card says so
// in plain words, and the health line counts the cut subjects. Steelman output moves no book, signal, rule,
// alert or pick.
import type { Client } from "@libsql/client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { Steelman } from "@/app/(app)/cards/[id]/Steelman";
import { loadSteelmanHealth, steelmanHealthOf } from "@/lib/health/steelman";
import { steelmanNight } from "@/lib/steelman/night";
import { readSteelmanForCard, type SteelmanView } from "@/lib/steelman/read";
import {
  insertNight,
  isLimitCutPack,
  limitCutPackId,
  listPacks,
  readNight,
  type NightRow,
} from "@/lib/steelman/store";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import {
  CALENDAR,
  criticAnswer,
  CUT,
  D,
  genericAuthor,
  KEYS,
  llmOf,
  MARKET,
  NOW,
  params,
  scripted,
  seedNight,
  SHA,
} from "./nightHarness";

afterEach(cleanupTempDbs);

/** seedNight has orders c2 (ZZB, 9.5), c1 (ZZA, 1.5) and pick ZZP; add c4 (ZZD, 8) and c5 (ZZE, 7): five subjects. */
async function seedFive(): Promise<Client> {
  const db = await seedNight();
  for (const [sid, cid, code, score] of [
    ["s4", "c4", "ZZD", "8.0"],
    ["s5", "c5", "ZZE", "7.0"],
  ] as const) {
    await db.execute({
      sql: `INSERT INTO signal (id, market, d, family, rule_version, variant, code, regime, rank_score, rules_json, evidence_json, schema_version, agent_version, inputs_ref, decided_at)
            VALUES (?, 'AU', ?, 'F3', 'v1', 'base', ?, 'NEUTRAL', ?, '[]', '{}', 1, 'a', 'r', ?)`,
      args: [sid, D, code, score, CUT],
    });
    await db.execute({
      sql: `INSERT INTO decision_card (id, signal_id, execution_id, taken, not_taken_reason, order_id, card_json, card_sha, schema_version, decided_at)
            VALUES (?, ?, 'x', 1, NULL, ?, '{}', ?, 1, ?)`,
      args: [cid, sid, `o-${cid}`, SHA, CUT],
    });
  }
  return db;
}

const run = (db: Client, dailyCards: number) =>
  steelmanNight(db, {
    market: MARKET,
    d: D,
    llmParams: params.llm,
    keys: { ...KEYS, dailyCards },
    llm: llmOf([scripted("alpha", genericAuthor())], [scripted("beta", criticAnswer())]),
    calendar: CALENDAR,
    now: NOW,
  });

const words = (v: SteelmanView | null) =>
  renderToStaticMarkup(createElement(Steelman, { data: v }))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");

const nightRow = (over: Partial<NightRow>): NightRow => ({
  market: "AU",
  d: "2026-03-01",
  requested: 5,
  written: 3,
  notWrittenLimit: 0,
  notWrittenBudget: 0,
  notWrittenNoModel: 0,
  notWrittenCritic: 0,
  notWrittenError: 0,
  claimsTotal: 12,
  claimsValid: 12,
  validityPpm: 1_000_000,
  criticHidden: 0,
  createdAt: NOW,
  ...over,
});

describe("cut subjects get a zero-item pack", () => {
  it("cap 2 of 5 writes two packs and stores three zero-item packs, each with the subject's card", async () => {
    const db = await seedFive();
    const r = await run(db, 2);
    expect(r).toMatchObject({ requested: 5, written: 2 });
    expect(r.notWritten.limit).toBe(3);
    const packs = await listPacks(db, MARKET, D);
    expect(packs).toHaveLength(5);
    const cut = packs.filter((p) => p.itemCount === 0);
    expect(cut.map((p) => p.code).sort()).toEqual(["ZZA", "ZZE", "ZZP"]);
    for (const p of cut) {
      expect(p.items).toEqual([]);
      expect(p.packId).toBe(limitCutPackId(MARKET, D, p.subjectKind, p.subjectId));
      expect(isLimitCutPack(p)).toBe(true);
      expect(p.packId).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(cut.find((p) => p.code === "ZZA")?.cardId).toBe("c1");
    expect(cut.find((p) => p.code === "ZZP")?.cardId).toBeNull();
    expect(packs.filter((p) => p.itemCount > 0).every((p) => !isLimitCutPack(p))).toBe(true);
    const points = await db.execute(
      "SELECT 1 FROM steelman_point WHERE pack_id IN (SELECT pack_id FROM steelman_pack WHERE item_count = 0)",
    );
    expect(points.rows).toHaveLength(0);
  });

  it("a re-run changes nothing", async () => {
    const db = await seedFive();
    await run(db, 2);
    const ids = async () =>
      (await db.execute("SELECT pack_id FROM steelman_pack ORDER BY pack_id")).rows.map(
        (x) => x.pack_id,
      );
    const before = await ids();
    expect((await run(db, 2)).status).toBe("already_done");
    expect(await ids()).toEqual(before);
  });

  it("cap 0 cuts every subject; a cap that covers all of them cuts none", async () => {
    const db = await seedNight();
    await run(db, 0);
    const packs = await listPacks(db, MARKET, D);
    expect(packs).toHaveLength(3);
    expect(packs.every((p) => isLimitCutPack(p))).toBe(true);
    const db2 = await seedNight();
    const r = await run(db2, 8);
    expect(r.notWritten.limit).toBe(0);
    expect((await listPacks(db2, MARKET, D)).some((p) => p.itemCount === 0)).toBe(false);
  });

  it("a night with no subjects stores no pack and still stores the night row", async () => {
    const db = await freshDb("main");
    const r = await run(db, 1);
    expect(r.requested).toBe(0);
    expect(await listPacks(db, MARKET, D)).toEqual([]);
    expect(await readNight(db, MARKET, D)).not.toBeNull();
  });

  it("moves no signal, card or pick", async () => {
    const db = await seedFive();
    const count = async () =>
      Promise.all(
        ["signal", "decision_card", "pick"].map(
          async (t) => (await db.execute(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0]!.n,
        ),
      );
    const before = await count();
    await run(db, 1);
    expect(await count()).toEqual(before);
  });
});

describe("the reader and the card say it in plain words", () => {
  it("a cut order card reads as not written for the daily limit", async () => {
    const db = await seedFive();
    await run(db, 2);
    const v = await readSteelmanForCard(db, "c1");
    expect(v).toEqual({
      state: "not_written",
      reason: "daily_limit",
      bull: [],
      bear: [],
      cited: [],
    });
    expect(words(v)).toContain("Not written tonight: daily limit reached");
    expect((await readSteelmanForCard(db, "c2"))?.state).toBe("written");
    expect((await readSteelmanForCard(db, "c4"))?.state).toBe("written");
    expect((await readSteelmanForCard(db, "c5"))?.reason).toBe("daily_limit");
  });

  it("keeps the other reasons' words and shows no internal code", () => {
    const view = (reason: "budget" | "no_model"): SteelmanView => ({
      state: "not_written",
      reason,
      bull: [],
      bear: [],
      cited: [],
    });
    expect(words(view("budget"))).toContain(
      "Not available tonight: the daily model allowance was used up",
    );
    expect(words(view("no_model"))).toContain("Not available tonight: no model was available");
    const cut: SteelmanView = {
      state: "not_written",
      reason: "daily_limit",
      bull: [],
      bear: [],
      cited: [],
    };
    expect(words(cut)).not.toMatch(/daily_limit|\bD-\d+|\bUXN|\bAT-\d+/);
  });
});

describe("the health line counts the cut subjects", () => {
  it("appends 'n not written (daily limit)' over the window", () => {
    const rows = [
      nightRow({ d: "2026-03-02", notWrittenLimit: 3 }),
      nightRow({ notWrittenLimit: 2 }),
    ];
    const h = steelmanHealthOf(rows);
    expect(h.notWrittenLimit).toBe(5);
    expect(h.text).toMatch(/; 5 not written \(daily limit\)\.$/);
  });

  it("is silent when none were cut, and only counts the last ten nights", () => {
    expect(steelmanHealthOf([nightRow({})]).text).not.toContain("daily limit");
    const rows = Array.from({ length: 12 }, (_, i) =>
      nightRow({ d: `2026-03-${String(20 - i).padStart(2, "0")}`, notWrittenLimit: 1 }),
    );
    const h = steelmanHealthOf(rows);
    expect(h.notWrittenLimit).toBe(10);
    expect(h.text).toContain("evidence complete; 10 not written (daily limit).");
  });

  it("reads the stored night rows, and an empty table has no count", async () => {
    const db = await seedNight();
    expect((await loadSteelmanHealth(db, "AU")).notWrittenLimit).toBe(0);
    await insertNight(db, nightRow({ notWrittenLimit: 4 }));
    const h = await loadSteelmanHealth(db, "AU");
    expect(h.notWrittenLimit).toBe(4);
    expect(h.text).toContain("4 not written (daily limit)");
  });
});
