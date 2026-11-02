// @vitest-environment node
// Steelman opinion tracking (M11-lite WP4; CTX-041, D-488, D-485): recorded at write, settled read-after
// from the closed trade (orders) or pick_outcome (picks), once, never by a hook in those writers.
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { opinionValue, settleDue } from "@/lib/steelman/opinion";
import { steelmanNight } from "@/lib/steelman/night";
import { cleanupTempDbs } from "../db/helpers";
import {
  CALENDAR,
  criticAnswer,
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

const LATER = "2026-03-10";

async function night(db: Client) {
  return steelmanNight(db, {
    market: MARKET,
    d: D,
    llmParams: params.llm,
    keys: KEYS,
    llm: llmOf([scripted("alpha", genericAuthor())], [scripted("beta", criticAnswer())]),
    calendar: CALENDAR,
    now: NOW,
  });
}

const opinions = async (db: Client) =>
  (
    await db.execute(
      "SELECT code, settled_d, outcome_json FROM opinion_track WHERE kind = 'steelman' ORDER BY code",
    )
  ).rows.map((r) => ({
    code: String(r.code),
    settledD: r.settled_d === null ? null : String(r.settled_d),
    outcome: r.outcome_json === null ? null : (JSON.parse(String(r.outcome_json)) as unknown),
  }));

/** An entry fill and an open trade for order `o-<card>`; `closeTrade` adds the sell fill and the exit. */
async function openTrade(db: Client, card: string, code: string) {
  const bar = [0, 0, 0, 0];
  const fill = (id: string, order: string, side: string, value: number, fee: number) =>
    db.execute({
      sql: `INSERT INTO fill (id, order_id, cohort_id, d, code, side, qty, rule, ref_price_micro, slip_micro,
              fill_price_micro, value_micro, brokerage_micro, cost_profile, bar_o_micro, bar_h_micro, bar_l_micro, bar_c_micro)
            VALUES (?, ?, 'k1', ?, ?, ?, 100, 'open', 10000000, 0, 10000000, ?, ?, 'p', ?, ?, ?, ?)`,
      args: [id, order, LATER, code, side, value, fee, ...bar],
    });
  const order = (id: string, side: string, kind: string) =>
    db.execute({
      sql: `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty, status)
            VALUES (?, 'k1', ?, ?, ?, ?, 100, 'pending')`,
      args: [id, D, code, side, kind],
    });
  await order(`o-${card}`, "buy", "entry");
  await fill(`f-${card}`, `o-${card}`, "buy", 1_000_000_000, 1_000_000);
  await db.execute({
    sql: "UPDATE arena_order SET status = 'filled', fill_d = ? WHERE id = ?",
    args: [LATER, `o-${card}`],
  });
  await db.execute({
    sql: "INSERT INTO trade (id, cohort_id, code, entry_fill_id, stop_micro) VALUES (?, 'k1', ?, ?, 9000000)",
    args: [`t-${card}`, code, `f-${card}`],
  });
  return async (sellValue: number) => {
    await order(`x-${card}`, "sell", "exit_is");
    await fill(`fx-${card}`, `x-${card}`, "sell", sellValue, 1_000_000);
    await db.execute({
      sql: "UPDATE trade SET exit_type = 'IS', exit_fill_id = ? WHERE id = ?",
      args: [`fx-${card}`, `t-${card}`],
    });
  };
}

async function pickState(db: Client, to: "bought" | "closed" | "missed") {
  await db.execute({
    sql: `INSERT INTO pick_outcome (market, d, profile, rank, kind, code, published_sha, state, updated_d)
          VALUES ('AU', ?, 'balanced', 1, 'pick', 'ZZP', ?, 'waiting', ?)
          ON CONFLICT DO NOTHING`,
    args: [D, SHA, D],
  });
  if (to === "missed") {
    await db.execute({
      sql: "UPDATE pick_outcome SET state = 'missed', updated_d = ? WHERE kind = 'pick'",
      args: [LATER],
    });
    return;
  }
  await db.execute({
    sql: "UPDATE pick_outcome SET state = 'bought', entry_d = ?, entry_micro = 10000000, updated_d = ? WHERE kind = 'pick'",
    args: [LATER, LATER],
  });
  if (to === "closed")
    await db.execute({
      sql: `UPDATE pick_outcome SET state = 'closed', exit_d = ?, exit_micro = 11000000, exit_reason = 'aim',
              net_micro = 900000, net_ppm = 90000, updated_d = ? WHERE kind = 'pick'`,
      args: [LATER, LATER],
    });
}

describe("opinionValue", () => {
  it("counts shown points per side and the monitorable bear points", () => {
    expect(
      opinionValue([
        { side: "bull", monitorable: false },
        { side: "bull", monitorable: false },
        { side: "bear", monitorable: true },
        { side: "bear", monitorable: false },
      ]),
    ).toEqual({ bull: 2, bear: 2, monitorable: 1 });
  });
});

describe("recorded at write, settled read-after", () => {
  it("one unsettled opinion per written subject after the night", async () => {
    const db = await seedNight();
    await night(db);
    expect(await opinions(db)).toEqual([
      { code: "ZZA", settledD: null, outcome: null },
      { code: "ZZB", settledD: null, outcome: null },
      { code: "ZZP", settledD: null, outcome: null },
    ]);
  });

  it("an open trade and an open pick stay unsettled", async () => {
    const db = await seedNight();
    await night(db);
    await openTrade(db, "c1", "ZZA");
    await pickState(db, "bought");
    expect(await settleDue(db, MARKET, LATER)).toBe(0);
    expect((await opinions(db)).every((o) => o.settledD === null)).toBe(true);
  });

  it("a closed order settles with its net ppm after costs; a closed pick with net_ppm; once only", async () => {
    const db = await seedNight();
    await night(db);
    const close = await openTrade(db, "c1", "ZZA");
    await close(1_100_000_000);
    await pickState(db, "closed");
    expect(await settleDue(db, MARKET, LATER)).toBe(2);
    const o = await opinions(db);
    // (1_100_000_000 - 1_000_000 - 1_000_000_000 - 1_000_000) * 1e6 / 1_001_000_000 = 97 902 ppm
    expect(o.find((x) => x.code === "ZZA")).toEqual({
      code: "ZZA",
      settledD: LATER,
      outcome: { kind: "order", netPpm: 97_902, exit: "IS" },
    });
    expect(o.find((x) => x.code === "ZZP")).toEqual({
      code: "ZZP",
      settledD: LATER,
      outcome: { kind: "pick", netPpm: 90_000 },
    });
    expect(o.find((x) => x.code === "ZZB")?.settledD).toBeNull(); // no trade yet
    expect(await settleDue(db, MARKET, "2026-03-11")).toBe(0); // settled once, never changed
    expect((await opinions(db)).find((x) => x.code === "ZZA")?.settledD).toBe(LATER);
  });

  it("a losing order settles with a negative ppm", async () => {
    const db = await seedNight();
    await night(db);
    const close = await openTrade(db, "c2", "ZZB");
    await close(900_000_000);
    await settleDue(db, MARKET, LATER);
    const z = (await opinions(db)).find((x) => x.code === "ZZB");
    expect((z?.outcome as { netPpm: number }).netPpm).toBeLessThan(0);
  });

  it("a missed pick settles as missed", async () => {
    const db = await seedNight();
    await night(db);
    await pickState(db, "missed");
    expect(await settleDue(db, MARKET, LATER)).toBe(1);
    expect((await opinions(db)).find((x) => x.code === "ZZP")?.outcome).toEqual({
      kind: "pick",
      missed: true,
    });
  });

  it("the next night's run settles what has closed since (read-after, no writer hook)", async () => {
    const db = await seedNight();
    await night(db);
    const close = await openTrade(db, "c1", "ZZA");
    await close(1_100_000_000);
    const r = await steelmanNight(db, {
      market: MARKET,
      d: "2026-03-11",
      llmParams: params.llm,
      keys: KEYS,
      llm: llmOf([scripted("alpha", genericAuthor())], [scripted("beta", criticAnswer())]),
      calendar: CALENDAR,
      now: "2026-03-11T08:00:00.000Z",
    });
    expect(r.settled).toBe(1);
  });

  it("never throws on a database failure", async () => {
    const broken = { execute: () => Promise.reject(new Error("down")) } as unknown as Client;
    expect(await settleDue(broken, MARKET, LATER)).toBe(0);
  });
});
