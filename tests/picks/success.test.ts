// @vitest-environment node
// ARN-095 success statistic and the pick_success_min_n gate (UXN-041): the strip reads "not measured
// yet" below n, then the share of closed picks that made money after costs, with n and the luck check.
import { afterAll, describe, expect, it } from "vitest";
import { modelSuccess, shortDate, successLine, wholePercent } from "@/lib/picks/success";
import { cleanupTempDbs } from "../db/helpers";
import { MARKET, SESSIONS, world, type Sql } from "./harness";

afterAll(cleanupTempDbs);

const sha = (i: number): string => i.toString(16).padStart(64, "0");

/** One published pick of `profile` on session i, with a pick outcome and a twin outcome. */
async function addPick(
  run: Sql,
  o: {
    i: number;
    profile: string;
    pick: "win" | "loss" | "missed" | "open";
    twin?: "win" | "loss" | "open";
    pickNetPpm?: number;
    closeD?: string;
  },
): Promise<void> {
  const d = SESSIONS[o.i]!;
  await run(
    `INSERT INTO pick (market, d, profile, rank, code, family, tier, rule_version, signal_id, label,
       reference_micro, buy_max_micro, valid_until_d, stop_micro, aim_micro, n_similar, bad_ppm,
       typical_ppm, good_ppm, time_frame_sessions, size_micro, risk_micro, factors_json, based_on_json,
       pick_sha, created_at)
     VALUES (?, ?, ?, 1, 'ZZA1', 'F1', 'U1', 'F1.v1', 'sig', 'UNVALIDATED', 10000000, 10050000, ?,
       9200000, 11000000, 50, -60000, 20000, 110000, 4, 1000000000, 100000000, '[]', '[]', ?, ?)`,
    [MARKET, d, o.profile, SESSIONS[o.i + 2]!, sha(o.i + 1), `${d}T07:00:00.000Z`],
  );
  const close = async (kind: "pick" | "luck", result: "win" | "loss" | "missed" | "open") => {
    const code = kind === "pick" ? "ZZA1" : "ZZB1";
    await run(
      `INSERT INTO pick_outcome (market, d, profile, rank, kind, code, published_sha, state, updated_d)
       VALUES (?, ?, ?, 1, ?, ?, ?, 'waiting', ?)`,
      [MARKET, d, o.profile, kind, code, sha(o.i + 1), d],
    );
    const where = [MARKET, d, o.profile, kind] as const;
    if (result === "missed") {
      await run(
        "UPDATE pick_outcome SET state = 'missed', updated_d = ? WHERE market = ? AND d = ? AND profile = ? AND rank = 1 AND kind = ?",
        [d, ...where],
      );
      return;
    }
    await run(
      "UPDATE pick_outcome SET state = 'bought', entry_d = ?, entry_micro = 10000000, updated_d = ? WHERE market = ? AND d = ? AND profile = ? AND rank = 1 AND kind = ?",
      [SESSIONS[o.i + 1]!, d, ...where],
    );
    if (result === "open") return;
    const net = result === "win" ? 50_000 : -20_000;
    await run(
      `UPDATE pick_outcome SET state = 'closed', exit_d = ?, exit_micro = 10500000, exit_reason = 'time_frame',
         net_micro = ?, net_ppm = ?, updated_d = ?
       WHERE market = ? AND d = ? AND profile = ? AND rank = 1 AND kind = ?`,
      [
        o.closeD ?? SESSIONS[o.i + 5]!,
        net * 1000,
        kind === "pick" && o.pickNetPpm !== undefined ? o.pickNetPpm : net,
        SESSIONS[o.i + 5]!,
        ...where,
      ],
    );
  };
  await close("pick", o.pick);
  await close("luck", o.twin ?? "open");
}

describe("pick_success_min_n gate", () => {
  it("reads 'not measured yet' below n and gives no percentage at all", async () => {
    const { db, run } = await world();
    for (let i = 0; i < 7; i += 1) {
      await addPick(run, { i, profile: "balanced", pick: i < 5 ? "win" : "loss", twin: "win" });
    }
    await addPick(run, { i: 8, profile: "balanced", pick: "open" });
    const s = await modelSuccess(db, {
      market: MARKET,
      profile: "balanced",
      d: SESSIONS[40]!,
      minN: 30,
      confidence: 0.9,
    });
    expect(s).toMatchObject({ measured: false, closed: 7, open: 1, winPct: null, lowerPct: null });
    expect(successLine(s)).toBe("Model success: not measured yet — 7 of 30 picks closed");
  });

  it("moves with the key: the same record is measured once n is lowered", async () => {
    const { db, run } = await world();
    for (let i = 0; i < 7; i += 1) {
      await addPick(run, { i, profile: "balanced", pick: i < 5 ? "win" : "loss", twin: "win" });
    }
    const s = await modelSuccess(db, {
      market: MARKET,
      profile: "balanced",
      d: SESSIONS[40]!,
      minN: 7,
      confidence: 0.9,
    });
    expect(s.measured).toBe(true);
    expect(s.winPct).toBe(71);
  });
});

describe("the success percentage", () => {
  it("is 59 % of 41 closed picks (24 made money) with the luck check beside it", async () => {
    const { db, run } = await world();
    for (let i = 0; i < 41; i += 1) {
      await addPick(run, {
        i,
        profile: "balanced",
        pick: i < 24 ? "win" : "loss",
        twin: i < 20 ? "win" : "loss", // luck check 20 of 41 = 49 %
      });
    }
    // three that were missed and two still open are not in the 41
    await addPick(run, { i: 41, profile: "balanced", pick: "missed" });
    await addPick(run, { i: 42, profile: "balanced", pick: "missed" });
    await addPick(run, { i: 43, profile: "balanced", pick: "missed" });
    await addPick(run, { i: 44, profile: "balanced", pick: "open" });
    await addPick(run, { i: 45, profile: "balanced", pick: "open" });
    const s = await modelSuccess(db, {
      market: MARKET,
      profile: "balanced",
      d: SESSIONS[80]!,
      minN: 30,
      confidence: 0.9,
    });
    expect(s).toMatchObject({
      measured: true,
      closed: 41,
      wins: 24,
      winPct: 59,
      luckClosed: 41,
      luckWins: 20,
      luckPct: 49,
      missed: 3,
      open: 2,
      since: SESSIONS[0],
    });
    expect(s.lowerPct!).toBeLessThan(59);
    expect(s.upperPct!).toBeGreaterThan(59);
    expect(successLine(s)).toBe(
      "Model success: 59% of 41 closed picks made money (90% range 46–70%, 2 still open) · luck check 49% · since 2 Jan",
    );
    // 59 % against a 49 % luck check is not enough at n = 41: the lower bound is below the twin rate
    expect(s.beatsLuck).toBe(false);
  });

  it("beats the luck check only when the interval clears the twin rate", async () => {
    const { db, run } = await world();
    for (let i = 0; i < 60; i += 1) {
      await addPick(run, {
        i,
        profile: "aggressive",
        pick: i < 50 ? "win" : "loss",
        twin: i < 20 ? "win" : "loss",
      });
    }
    const s = await modelSuccess(db, {
      market: MARKET,
      profile: "aggressive",
      d: SESSIONS[80]!,
      minN: 30,
      confidence: 0.9,
    });
    expect(s.beatsLuck).toBe(true);
  });

  it("counts only what had closed by D and only the profile's own picks", async () => {
    const { db, run } = await world();
    for (let i = 0; i < 40; i += 1) {
      await addPick(run, { i, profile: "balanced", pick: "win", twin: "loss" });
    }
    await addPick(run, { i: 41, profile: "conservative", pick: "loss" });
    // picks 0..34 had closed by session 39 (exit on session i + 5); later ones had not
    const s = await modelSuccess(db, {
      market: MARKET,
      profile: "balanced",
      d: SESSIONS[39]!,
      minN: 30,
      confidence: 0.9,
    });
    expect(s.closed).toBe(35);
    expect(s.open).toBe(5);
    const other = await modelSuccess(db, {
      market: MARKET,
      profile: "conservative",
      d: SESSIONS[80]!,
      minN: 30,
      confidence: 0.9,
    });
    expect(other.closed).toBe(1);
  });

  it("counts the share inside the published bad-good range", async () => {
    const { db, run } = await world();
    for (let i = 0; i < 4; i += 1) {
      // published range -60,000 to +110,000 ppm; two inside, one above, one below
      await addPick(run, {
        i,
        profile: "balanced",
        pick: "win",
        pickNetPpm: [10_000, 50_000, 200_000, -90_000][i]!,
      });
    }
    const s = await modelSuccess(db, {
      market: MARKET,
      profile: "balanced",
      d: SESSIONS[40]!,
      minN: 4,
      confidence: 0.9,
    });
    expect(s.insidePct).toBe(50);
  });
});

describe("helpers", () => {
  it("rounds half up with integers and writes short dates", () => {
    expect(wholePercent(24, 41)).toBe(59);
    expect(wholePercent(1, 2)).toBe(50);
    expect(wholePercent(1, 3)).toBe(33);
    expect(wholePercent(2, 3)).toBe(67);
    expect(shortDate("2030-10-01")).toBe("1 Oct");
  });
});
