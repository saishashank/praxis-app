// @vitest-environment node
// Batch 2b writes Decision Cards inside its transactions (M4 T9; AGT-110, AT-16; decision 20;
// D-084, D-087). Runs the golden synthetic nights end to end (2a + 2b, real migrations).
import type { Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { signalsDay, signalsKey } from "@/lib/agents/batch2b";
import { checkCard, rulesNoteText, type DecisionCard } from "@/lib/agents/cards";
import { cleanupTempDbs } from "../db/helpers";
import { makeRouter, mockProvider } from "../llm/helpers";
import {
  DATES,
  MARKET,
  NOW,
  dump,
  freshReplayDb,
  runNights,
  setMode,
  startCohortsAt,
  testParams,
} from "./batch2bHarness";
import { buildGolden, D } from "./batch2bScenario";

vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });

const params = testParams();
const d = (i: number): string => DATES[i]!;

type Row = Record<string, unknown>;
const rows = async (db: Client, sql: string, args: (string | number)[] = []): Promise<Row[]> =>
  (await db.execute({ sql, args })).rows.map((r) => ({ ...r }));

afterAll(cleanupTempDbs);

describe("cards in the nightly run", () => {
  let db: Client;
  let ids: string[];
  const cohort = (prefix: string): string =>
    ids.find((x) => x.startsWith(`${prefix}@`) || x.startsWith(`${prefix}#`))!;

  beforeAll(async () => {
    db = await freshReplayDb();
    await buildGolden(db);
    await setMode(db, "full");
    ids = await startCohortsAt(db, 295, ["E01", "E07", "E08", "C2-F1", "C2-F4", "C3-F4"]);
    await runNights(db, params, 295, 322);
  });

  it("AT-16: every entry order of an E cohort has a card, taken or rejected, linked both ways", async () => {
    const orders = await rows(
      db,
      `SELECT o.id, o.cohort_id, o.status, o.card_id, o.signal_id, c.execution_id
       FROM arena_order o JOIN cohort c ON c.id = o.cohort_id
       WHERE o.kind = 'entry' AND c.execution_id IN ('E01', 'E07', 'E08')`,
    );
    expect(orders.length).toBeGreaterThan(3);
    for (const o of orders) {
      expect(o.card_id, String(o.id)).not.toBeNull();
      expect(o.card_id).toBe(`card:${o.signal_id}:${o.execution_id}`);
      const [card] = await rows(
        db,
        "SELECT taken, order_id, not_taken_reason, cohort_id FROM decision_card WHERE id = ?",
        [String(o.card_id)],
      );
      expect(card, String(o.id)).toBeDefined();
      expect(card!.cohort_id).toBe(o.cohort_id);
      if (o.status === "rejected") {
        expect(card!.taken).toBe(0n);
        expect(card!.order_id).toBeNull();
      } else {
        expect(card!.taken).toBe(1n);
        expect(card!.order_id).toBe(o.id);
      }
    }
  });

  it("the decision night: one card per signal and E execution, taken or not (decision 20)", async () => {
    const cards = await rows(
      db,
      `SELECT c.execution_id, s.family, s.code, c.taken, c.not_taken_reason, c.decided_at
       FROM decision_card c JOIN signal s ON s.id = c.signal_id
       WHERE s.d = ? ORDER BY c.execution_id, s.code`,
      [d(D)],
    );
    expect(
      cards.map((c) => `${c.execution_id}:${c.code}:${c.taken}:${c.not_taken_reason}`),
    ).toEqual([
      "E01:ZZUP:1:null",
      "E07:ZZD1:1:null",
      "E07:ZZD2:0:rank",
      "E08:ZZD1:1:null",
      "E08:ZZD2:0:rank",
    ]);
    for (const c of cards) expect(String(c.decided_at)).toBe("2031-02-26T07:10:00.000Z");
  });

  it("each stored card passes the AT-16 validator and carries thesis-breakers and a scenario", async () => {
    const all = await rows(db, "SELECT id, card_json, card_sha, schema_version FROM decision_card");
    expect(all.length).toBeGreaterThan(5);
    for (const r of all) {
      const card = JSON.parse(String(r.card_json)) as DecisionCard;
      expect(checkCard(card, params), String(r.id)).toEqual([]);
      expect(card.thesis_breakers.length).toBeGreaterThanOrEqual(3);
      expect(card.scenario.insufficient_history).toBe(true);
      expect(card.scenario.reason).toBe("no development replay yet");
      expect(card.footnote).toContain("n 0");
      expect(String(r.card_sha)).toMatch(/^[0-9a-f]{64}$/);
      expect(r.schema_version).toBe(1n);
    }
  });

  it("the taken card matches the order: sizing, cost with break-even, exit plan from the stored plan", async () => {
    const e07 = cohort("E07");
    const [row] = await rows(db, "SELECT card_json FROM decision_card WHERE id = ?", [
      `card:sig:AU:${d(D)}:F4:F4.v1:F4:ZZD1:E07`,
    ]);
    const card = JSON.parse(String(row!.card_json)) as DecisionCard;
    const [order] = await rows(db, "SELECT qty, stop_spec FROM arena_order WHERE id = ?", [
      `EN:${e07}:${d(D)}:ZZD1`,
    ]);
    expect(card.sizing).toMatchObject({ available: true, accepted: true, qty: String(order!.qty) });
    expect(card.cost.available).toBe(true);
    expect(BigInt(card.cost.break_even_ppm!)).toBeGreaterThan(0n);
    expect(card.regime).toBe("RISK-ON");
    expect(card.execution).toBe("E07");
    expect(card.exit_plan.map((e) => e.tag)).toEqual(["IS", "CS", "CS"]);
    const spec = JSON.parse(String(order!.stop_spec)) as { stops: unknown[]; cs: unknown[] };
    expect(card.exit_plan.length).toBe(spec.stops.length + spec.cs.length);
    const [notTaken] = await rows(db, "SELECT card_json FROM decision_card WHERE id = ?", [
      `card:sig:AU:${d(D)}:F4:F4.v1:F4:ZZD2:E07`,
    ]);
    const nt = JSON.parse(String(notTaken!.card_json)) as DecisionCard;
    expect(nt.taken).toBe(false);
    expect(nt.sizing.available).toBe(false);
    expect(nt.cost).toMatchObject({ available: false, reason: "not_sized" });
  });

  it("every card has a rules-only note that is grounded in the card", async () => {
    const all = await rows(
      db,
      `SELECT c.id, c.card_json, n.text, n.provider, n.fallback_depth, n.kind
       FROM decision_card c LEFT JOIN card_note n ON n.card_id = c.id`,
    );
    for (const r of all) {
      expect(r.kind, String(r.id)).toBe("summary");
      expect(r.provider).toBeNull();
      expect(r.fallback_depth).toBe("rules-only");
      expect(String(r.text)).toBe(rulesNoteText(JSON.parse(String(r.card_json)) as DecisionCard));
    }
  });

  it("controls and exit orders link to the matched signal's / entry's card (decision 20)", async () => {
    const controls = await rows(
      db,
      `SELECT o.id, o.card_id, o.signal_id, c.execution_id FROM arena_order o
       JOIN cohort c ON c.id = o.cohort_id
       WHERE o.kind = 'entry' AND c.execution_id IN ('C2-F1', 'C2-F4', 'C3-F4') AND o.status <> 'rejected'`,
    );
    expect(controls.length).toBeGreaterThan(0);
    for (const o of controls) {
      expect(String(o.card_id)).toMatch(new RegExp(`^card:${String(o.signal_id)}:E`));
      const [card] = await rows(db, "SELECT taken FROM decision_card WHERE id = ?", [
        String(o.card_id),
      ]);
      expect(card!.taken).toBe(1n);
    }
    const exits = await rows(
      db,
      `SELECT o.id, o.card_id, o.cohort_id, o.code, o.decided_d FROM arena_order o WHERE o.kind = 'exit_cs'`,
    );
    expect(exits.length).toBeGreaterThan(0);
    for (const x of exits) {
      const [entry] = await rows(
        db,
        `SELECT card_id FROM arena_order WHERE cohort_id = ? AND code = ? AND kind = 'entry'
           AND status = 'filled' AND decided_d < ? ORDER BY decided_d DESC LIMIT 1`,
        [String(x.cohort_id), String(x.code), String(x.decided_d)],
      );
      expect(x.card_id).toBe(entry!.card_id);
    }
  });

  it("the run record counts the cards", async () => {
    const [rec] = await rows(db, "SELECT details_json FROM run_record WHERE concurrency_key = ?", [
      signalsKey(MARKET, d(D)),
    ]);
    const stats = JSON.parse(String(rec!.details_json)) as { cards: number };
    expect(stats.cards).toBe(5);
  });
});

describe("idempotency", () => {
  let idb: Client;
  beforeAll(async () => {
    idb = await freshReplayDb();
    await buildGolden(idb);
    await setMode(idb, "full");
    await startCohortsAt(idb, 295, ["E01", "E07"]);
    await runNights(idb, params, 295, D);
  });
  const tables = ["decision_card", "card_note", "arena_order"];
  const snapshot = (): Promise<string[]> =>
    Promise.all(tables.map((t) => dump(idb, `SELECT * FROM ${t} ORDER BY 1, 2, 3`)));

  it("a killed run resumes: re-running writes no new card or note and changes none", async () => {
    const before = await snapshot();
    expect(before[0]).not.toBe("[]");
    await idb.execute({
      sql: "UPDATE run_record SET status = 'failed' WHERE concurrency_key = ? AND status = 'success'",
      args: [signalsKey(MARKET, d(D))],
    });
    const again = await signalsDay(idb, {
      withLeverage: true, // D-191: the full engine, sleeve included

      market: MARKET,
      d: d(D),
      replay: true,
      now: NOW,
      params,
    });
    expect(again.status).toBe("success");
    expect(again.stats.cards).toBe(0);
    expect(again.stats.orders).toBe(0);
    expect(await snapshot()).toEqual(before);
  });

  it("a stored card that would differ raises and nothing is overwritten", async () => {
    const before = await snapshot();
    await idb.execute({
      sql: "UPDATE run_record SET status = 'failed' WHERE concurrency_key = ? AND status = 'success'",
      args: [signalsKey(MARKET, d(D))],
    });
    const bad = await signalsDay(idb, {
      withLeverage: true, // D-191: the full engine, sleeve included

      market: MARKET,
      d: d(D),
      replay: true,
      now: NOW,
      params: testParams({ f4_stop_atr: 3, f1_initial_stop_atr: 3 }),
    });
    expect(bad.status).toBe("failed");
    expect(bad.reason).toBe("row_conflict");
    expect(await snapshot()).toEqual(before);
  });
});

describe("LLM router wired in (mock mode)", () => {
  it("cards work with the LLM mock: no recorded answer means the rules-only note, same cards", async () => {
    const plain = await freshReplayDb();
    const withLlm = await freshReplayDb();
    for (const db of [plain, withLlm]) {
      await buildGolden(db);
      await setMode(db, "full");
      await startCohortsAt(db, 295, ["E01", "E07"]);
    }
    await runNights(plain, params, 295, D);
    const { router } = makeRouter("mock", [mockProvider({})]);
    await runNights(withLlm, params, 295, D, undefined, { llm: router });
    const q = "SELECT * FROM decision_card ORDER BY 1";
    expect(await dump(withLlm, q)).toBe(await dump(plain, q));
    const n = "SELECT * FROM card_note ORDER BY 1";
    expect(await dump(withLlm, n)).toBe(await dump(plain, n));
  });
});
