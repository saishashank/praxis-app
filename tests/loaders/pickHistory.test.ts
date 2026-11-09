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
