// @vitest-environment node
// Pick history (Owner 2026-11-10): one row per published pick with its buy, sale, status, days held and
// price change; status filter (Open by default), keyset paging, a repeated stock is its own row, and a
// masked viewer sees no code, name, price or exact date. Synthetic ZZ data (tests/loaders/world.ts).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTempDbs } from "../db/helpers";
import { findLeaks } from "@/lib/view/mask";
import {
  HISTORY_PAGE,
  historyFilterOf,
  loadPickHistory,
  loadPicks,
  parseHistoryCursor,
} from "@/lib/ui/loaders/picks";
import { CODES, D, envOf, fullWorld, NAMES, SHA, type World } from "./world";

afterAll(cleanupTempDbs);

let w: World;
beforeAll(async () => {
  w = await fullWorld();
  // rank 2 (ZZOTH) was bought at 2.00 the day before and is still open; last close 2.20
  await w.main.execute({
    sql: `INSERT INTO pick_outcome (market, d, profile, rank, kind, code, published_sha, state, updated_d)
          VALUES ('AU', ?, 'balanced', 2, 'pick', 'ZZOTH', ?, 'waiting', ?)`,
    args: [D, SHA, D],
  });
  await w.main.execute({
    sql: `UPDATE pick_outcome SET state = 'bought', entry_d = '2026-10-16', entry_micro = 2000000, updated_d = ?
          WHERE market = 'AU' AND d = ? AND profile = 'balanced' AND rank = 2 AND kind = 'pick'`,
    args: [D, D],
  });
});

const owner = () => envOf(w, "owner");

describe("loadPickHistory", () => {
  it("defaults to Open and shows the open trade against the latest price", async () => {
    expect(historyFilterOf(undefined)).toBe("open");
    expect(historyFilterOf("bogus")).toBe("open");
    const m = await loadPickHistory(owner(), { profile: "balanced", filter: "open", cursor: null });
    expect(m.rows).toHaveLength(1);
    expect(m.rows[0]).toMatchObject({
      stock: "Zed Other Group (ZZOTH)",
      status: "open",
      entryD: "2026-10-16",
      exit: null,
      now: { micro: "2200000" },
      daysHeld: 4, // 16 Oct to today (20 Oct in Sydney)
      changePpm: 100_000,
    });
  });

  it("a closed trade shows its sale, the change and the result after costs", async () => {
    const m = await loadPickHistory(owner(), {
      profile: "balanced",
      filter: "closed",
      cursor: null,
    });
    expect(m.rows[0]).toMatchObject({
      stock: "Zed Upward Holdings (ZZUP)",
      status: "closed",
      entry: { micro: "10000000" },
      exit: { micro: "10500000" },
      exitReason: "aim",
      daysHeld: 0,
      changePpm: 50_000,
      netPpm: 50_000,
    });
    expect(m.rows[0]!.plan?.buyUpTo).not.toBeNull();
  });

  it("All lists both, newest first; other filters can be empty", async () => {
    const all = await loadPickHistory(owner(), {
      profile: "balanced",
      filter: "all",
      cursor: null,
    });
    expect(all.rows.map((r) => r.status)).toEqual(["closed", "open"]);
    expect(all.next).toBeNull();
    const none = await loadPickHistory(owner(), {
      profile: "balanced",
      filter: "not_traded",
      cursor: null,
    });
    expect(none.state).toBe("empty");
  });

  it("In profit / In loss: closed by the result after costs, open by the last close", async () => {
    const env = owner();
    const win = await loadPickHistory(env, { profile: "balanced", filter: "profit", cursor: null });
    expect(win.rows.map((r) => r.status)).toEqual(["closed", "open"]); // newest first
    const lose = await loadPickHistory(env, { profile: "balanced", filter: "loss", cursor: null });
    expect(lose.state).toBe("empty");
    // the open trade turns into a loss when a newer close is under the buy price (bars are write-once)
    await w.main.execute({
      sql: `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
            VALUES ('AU', 'ZZOTH', '2026-10-20', 1.8, 1.8, 1.8, 1.8, 100, 'test',
              '2026-10-20T06:00:00.000Z', '2026-10-20T06:05:00.000Z')`,
      args: [],
    });
    const now = await loadPickHistory(env, { profile: "balanced", filter: "loss", cursor: null });
    expect(now.rows.map((r) => r.stock)).toEqual(["Zed Other Group (ZZOTH)"]);
    expect(now.rows[0]!.changePpm).toBe(-100_000);
  });

  it("pages by key: a cursor after rank 1 returns rank 2 only", async () => {
    expect(parseHistoryCursor(`${D}.1`)).toEqual({ d: D, rank: 1 });
    expect(parseHistoryCursor("x; DROP")).toBeNull();
    const m = await loadPickHistory(owner(), {
      profile: "balanced",
      filter: "all",
      cursor: `${D}.1`,
    });
    expect(m.paged).toBe(true);
    expect(m.rows.map((r) => r.status)).toEqual(["open"]);
    expect(HISTORY_PAGE).toBe(25);
  });

  it("a masked viewer sees no code, name, price or exact date, and no paging", async () => {
    const m = await loadPickHistory(envOf(w, "viewer"), {
      profile: "balanced",
      filter: "all",
      cursor: `${D}.1`,
    });
    expect(m.paged).toBe(false);
    expect(findLeaks(m, CODES, NAMES)).toEqual([]);
    const text = JSON.stringify(m);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(text).not.toMatch(/10500000|10000000|2200000|2000000/);
    expect(m.rows[0]!.changePpm).toBe(50_000); // percentages stay
  });
});

describe("D-984 candidate picks in the history and on the card", () => {
  it("the Candidate filter lists only candidate-measure picks, flagged, in every state; the card shows no cases", async () => {
    const add = async (rank: number, code: string, rule: string) => {
      await w.main.execute({
        sql: `INSERT INTO pick (market, d, profile, rank, code, family, tier, rule_version, signal_id, label,
                reference_micro, buy_max_micro, valid_until_d, stop_micro, aim_micro, n_similar, bad_ppm,
                typical_ppm, good_ppm, time_frame_sessions, size_micro, risk_micro, factors_json, based_on_json,
                pick_sha, created_at)
              VALUES ('AU', ?, 'zzcand', ?, ?, 'F1', 'U1', ?, ?, 'UNVALIDATED', 10000000, 10050000,
                '2026-10-23', 9500000, 11000000, 0, -50000, 0, 100000, 20, 1000000000, 100000000,
                '[]', '["From the candidate measure: heavy trading without news — being tested, not proven."]',
                ?, '2026-10-20T07:10:00.000Z')`,
        args: [D, rank, code, rule, `s-${rank}`, SHA],
      });
      await w.main.execute({
        sql: `INSERT INTO pick_outcome (market, d, profile, rank, kind, code, published_sha, state, updated_d)
              VALUES ('AU', ?, 'zzcand', ?, 'pick', ?, ?, 'waiting', ?)`,
        args: [D, rank, code, SHA, D],
      });
    };
    await add(1, "ZZUP", "F1.v1");
    await add(2, "ZZOTH", "CAND.v1:A-D2-07");
    const env = owner();
    expect(historyFilterOf("candidate")).toBe("candidate");
    const m = await loadPickHistory(env, { profile: "zzcand", filter: "candidate", cursor: null });
    expect(m.rows.map((r) => [r.stock, r.candidate, r.status])).toEqual([
      ["Zed Other Group (ZZOTH)", true, "waiting"],
    ]);
    const all = await loadPickHistory(env, { profile: "zzcand", filter: "all", cursor: null });
    expect(all.rows.map((r) => r.candidate)).toEqual([false, true]);
    const card = await loadPicks(env, { profile: "zzcand", d: D });
    const c = card.picks.find((p) => p.rank === 2)!;
    expect(c.candidate).toBe(true);
    expect(c.scenario).toBeNull();
    expect(c.expectedGainPpm).toBeNull();
    expect(c.basedOn[0]).toContain("From the candidate measure");
    expect(card.picks.find((p) => p.rank === 1)!.candidate).toBe(false);
  });
});
