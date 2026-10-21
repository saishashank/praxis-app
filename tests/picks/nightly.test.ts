// @vitest-environment node
// The nightly picks phase end to end on a real migrated database: publish, store, track to closed
// and missed, the luck-check twin, idempotence, append-only rows, and section 7a from stored rows.
import type { Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runPicksNight } from "@/lib/picks/nightly";
import { writePicks } from "@/lib/picks/store";
import { trackPicks } from "@/lib/picks/track";
import { PicksError } from "@/lib/picks/types";
import { loadCtx, readPicksSection } from "@/lib/review/sections";
import { cleanupTempDbs } from "../db/helpers";
import {
  D,
  MARKET,
  NOW,
  SESSIONS,
  addBars,
  addCard,
  addExecutionAndLabel,
  addHistory,
  addSignal,
  addUniverse,
  params,
  world,
  type CodeSpec,
  type Sql,
} from "./harness";

const specs: CodeSpec[] = [
  { code: "ZZA1", tier: "U1", base: 10_000_000n, step: 0n },
  { code: "ZZB1", tier: "U1", base: 10_000_000n, step: 0n },
  { code: "ZZC2", tier: "U2", base: 10_000_000n, step: 0n },
  { code: "ZZD3", tier: "U3", base: 10_000_000n, step: 0n },
  { code: "ZZE1", tier: "U1", base: 10_000_000n, step: 0n },
];

let db: Client;
let run: Sql;
const rows = async (sql: string, args: (string | number)[] = []) =>
  (await db.execute({ sql, args })).rows.map((r) => ({ ...r }));

beforeAll(async () => {
  ({ db, run } = await world());
  for (const s of specs) await addBars(run, s, 0, 60);
  await addUniverse(run, D, specs);
  await addHistory(run);
  await addExecutionAndLabel(run, "F1", "F1.v1", "PASSED-BACKTEST");
  const rank: Record<string, string> = { ZZA1: "9/1", ZZB1: "8/1", ZZC2: "7/1", ZZD3: "6/1" };
  for (const s of specs.filter((x) => x.code !== "ZZE1")) {
    const id = await addSignal(run, {
      d: D,
      family: "F1",
      rv: "F1.v1",
      code: s.code,
      tier: s.tier,
      closeMicro: 10_000_000n,
      rank: rank[s.code]!,
    });
    await addCard(run, id, 9_200_000n);
  }
  // ZZE1 has an F4 signal, but F4 has no development history: it must not become a pick
  const f4 = await addSignal(run, {
    d: D,
    family: "F4",
    rv: "F4.v1",
    code: "ZZE1",
    tier: "U1",
    closeMicro: 10_000_000n,
    rank: "99/1",
  });
  await addCard(run, f4, 9_200_000n);
});

afterAll(cleanupTempDbs);

const night = (d = D) => runPicksNight(db, { market: MARKET, d, params, calendar: [], now: NOW });

describe("AGT-113 publication", () => {
  it("publishes tonight's picks with every stored number and starts pick and twin tracking", async () => {
    // ranking and trading state before the run (picks must leave all of it byte-identical)
    const tradingTables = [
      "signal",
      "decision_card",
      "arena_order",
      "trade",
      "fill",
      "ledger_row",
      "nav_daily",
    ];
    const snap = async () =>
      JSON.stringify(await Promise.all(tradingTables.map((t) => rows(`SELECT * FROM ${t}`))));
    const trading = await snap();
    const res = await night();
    expect(await snap()).toBe(trading);
    expect(res.candidates).toBe(5);
    const picks = await rows("SELECT * FROM pick ORDER BY profile, rank");
    expect(res.published).toBe(picks.length);
    const aggressive = picks.filter((p) => p.profile === "aggressive");
    // all F1: at most 2 per family; ZZE1 (F4, no history) is never picked
    expect(aggressive.map((p) => p.code)).toEqual(["ZZA1", "ZZB1"]);
    expect(picks.some((p) => p.code === "ZZE1")).toBe(false);
    // Conservative takes U1 only; Balanced fails closed with no drop-from-peak history
    expect(picks.filter((p) => p.profile === "conservative").every((p) => p.tier === "U1")).toBe(
      true,
    );
    expect(picks.filter((p) => p.profile === "balanced")).toEqual([]);
    const top = aggressive[0]!;
    expect(top.label).toBe("PASSED-BACKTEST");
    expect(top.card_id).toBe(`card:sig:AU:${D}:F1:F1.v1:U:ZZA1`);
    expect(BigInt(String(top.stop_micro))).toBe(9_200_000n);
    expect(Number(top.n_similar)).toBe(32);
    expect(Number(top.time_frame_sessions)).toBe(4);
    expect(Number(top.bad_ppm)).toBeLessThan(Number(top.typical_ppm));
    expect(Number(top.typical_ppm)).toBeLessThan(Number(top.good_ppm));
    expect(Number(top.aim_reach_ppm)).toBeGreaterThan(0);
    const out = await rows(
      "SELECT kind, state, code FROM pick_outcome WHERE profile = 'aggressive' AND rank = 1 ORDER BY kind",
    );
    expect(out.map((o) => [o.kind, o.state])).toEqual([
      ["luck", "waiting"],
      ["pick", "waiting"],
    ]);
    expect(out.find((o) => o.kind === "pick")!.code).toBe("ZZA1");
    expect(out.find((o) => o.kind === "luck")!.code).not.toBe("ZZA1");
  });

  it("is idempotent for the same night and refuses a different pick under the same key", async () => {
    const before = JSON.stringify(await rows("SELECT * FROM pick ORDER BY profile, rank"));
    const again = await night();
    expect(again.published).toBe(0);
    expect(JSON.stringify(await rows("SELECT * FROM pick ORDER BY profile, rank"))).toBe(before);
    const [p] = await rows("SELECT * FROM pick WHERE profile = 'aggressive' AND rank = 1");
    expect(p).toBeDefined();
    await expect(
      writePicks(db, [
        {
          market: MARKET,
          d: D,
          profile: "aggressive",
          rank: 1,
          code: "ZZA1",
          family: "F1",
          tier: "U1",
          ruleVersion: "F1.v1",
          signalId: "x",
          cardId: null,
          label: "UNVALIDATED",
          referenceMicro: 10_000_000n,
          buyMaxMicro: 10_100_000n,
          validUntilD: SESSIONS[61]!,
          stopMicro: 9_000_000n,
          aimMicro: 11_000_000n,
          aimReachPpm: null,
          nSimilar: 1,
          badPpm: -1,
          typicalPpm: 0,
          goodPpm: 1,
          timeFrameSessions: 1,
          sizeMicro: 1n,
          riskMicro: 1n,
          factors: [],
          basedOn: [],
          pickSha: "b".repeat(64),
          createdAt: NOW,
          luckCode: null,
        },
      ]),
    ).rejects.toBeInstanceOf(PicksError);
  });

  it("never edits or deletes a published pick (append-only)", async () => {
    await expect(db.execute("UPDATE pick SET stop_micro = 1")).rejects.toThrow(/append-only/);
    await expect(db.execute("DELETE FROM pick")).rejects.toThrow(/append-only/);
    await expect(db.execute("DELETE FROM pick_outcome")).rejects.toThrow(/forever/);
  });

  it("gives Balanced picks once the development trades show a small drop-from-peak", async () => {
    for (let i = 0; i < 32; i += 1) {
      await run(
        `INSERT INTO attribution (subject_kind, subject_id, version, market, d, final, tags_json,
           mfe_ppm, mae_ppm, hold_sessions, cost_micro, slippage_micro)
         VALUES ('ledger_row', ?, 1, ?, ?, 1, '{}', 50000, -40000, 4, 1, 1)`,
        [`lr-F1-${i}`, MARKET, SESSIONS[i + 3]!],
      );
    }
    const res = await night();
    expect(res.published).toBeGreaterThan(0);
    const balanced = await rows(
      "SELECT code, tier FROM pick WHERE profile = 'balanced' ORDER BY rank",
    );
    expect(balanced.length).toBeGreaterThan(0);
    expect(balanced.every((p) => p.tier !== "U3")).toBe(true);
  });
});

describe("ARN-095 tracking", () => {
  it("follows the picks to closed (aim), missed (price ran away) and the twin to its own end", async () => {
    const [top] = await rows(
      "SELECT aim_micro FROM pick WHERE profile = 'aggressive' AND rank = 1",
    );
    const aim = BigInt(String(top!.aim_micro));
    for (const s of specs) {
      const over: Record<number, { o?: bigint; h?: bigint; l?: bigint; c?: bigint }> = {};
      if (s.code === "ZZA1")
        over[60] = { o: 10_000_000n, h: aim + 100_000n, l: 9_900_000n, c: 10_500_000n };
      if (s.code === "ZZB1") {
        for (const i of [60, 61])
          over[i] = { o: 11_000_000n, h: 11_100_000n, l: 10_900_000n, c: 11_000_000n };
      }
      await addBars(run, s, 60, 80, over);
    }
    const last = SESSIONS[79]!;
    // nothing is tracked before the bars exist: tracking at D itself changes nothing
    const none = await trackPicks(db, { market: MARKET, d: D, advWindow: params.windows.adv });
    expect(none).toEqual({ bought: 0, missed: 0, closed: 0, open: 0 });

    const sum = await trackPicks(db, { market: MARKET, d: last, advWindow: params.windows.adv });
    expect(sum.closed).toBeGreaterThan(0);

    const [a] = await rows(
      "SELECT * FROM pick_outcome WHERE profile = 'aggressive' AND rank = 1 AND kind = 'pick'",
    );
    expect(a).toMatchObject({
      state: "closed",
      exit_reason: "aim",
      entry_d: SESSIONS[60],
      exit_d: SESSIONS[60],
    });
    expect(BigInt(String(a!.exit_micro))).toBe(aim);
    expect(BigInt(String(a!.net_micro))).toBeGreaterThan(0n);

    const [b] = await rows(
      "SELECT * FROM pick_outcome WHERE profile = 'aggressive' AND rank = 2 AND kind = 'pick'",
    );
    expect(b).toMatchObject({ state: "missed", entry_d: null, net_micro: null, net_ppm: null });

    // the twin of the first pick follows the same rules on its own prices: flat prices mean it is
    // bought at the first open and closed at the time frame (sold at the next open); a twin that
    // is ZZB1 sees the price run away and is missed
    const [t] = await rows(
      "SELECT * FROM pick_outcome WHERE profile = 'aggressive' AND rank = 1 AND kind = 'luck'",
    );
    expect(t!.code).not.toBe("ZZA1");
    if (t!.code === "ZZB1") {
      expect(t!.state).toBe("missed");
    } else {
      expect(t).toMatchObject({ state: "closed", exit_reason: "time_frame", exit_d: SESSIONS[64] });
      expect(BigInt(String(t!.net_micro))).toBeLessThan(0n); // flat price: only costs
    }
  });

  it("re-running changes nothing and the closed rows stay as they were", async () => {
    const dump = async () =>
      JSON.stringify(await rows("SELECT * FROM pick_outcome ORDER BY d, profile, rank, kind"));
    const before = await dump();
    const sum = await trackPicks(db, {
      market: MARKET,
      d: SESSIONS[79]!,
      advWindow: params.windows.adv,
    });
    expect(sum.bought + sum.missed + sum.closed).toBe(0);
    expect(await dump()).toBe(before);
    await expect(
      db.execute("UPDATE pick_outcome SET net_micro = 1 WHERE state = 'closed'"),
    ).rejects.toThrow();
  });
});

describe("section 7a from stored rows", () => {
  it("lists tonight's picks per profile with cents, weeks and the success line", async () => {
    const ctx = await loadCtx(db, {
      market: MARKET,
      d: D,
      env: "production",
      appUrl: "https://praxis.example.test",
      now: new Date(NOW),
    });
    const s = await readPicksSection(ctx, {
      picks: params.picks,
      confidence: params.cif.confidence,
    });
    expect(s.d).toBe(D);
    expect(s.none).toBe(false);
    expect(s.profiles.map((p) => p.profile)).toEqual(["aggressive", "balanced", "conservative"]);
    const agg = s.profiles.find((p) => p.profile === "aggressive")!;
    expect(agg.picks.map((p) => p.code)).toEqual(["ZZA1", "ZZB1"]);
    expect(agg.picks[0]).toMatchObject({ stopCents: 920, timeFrameWeeks: 1 });
    expect(agg.picks[0]!.buyUpToCents).toBeGreaterThanOrEqual(1000);
    expect(agg.picks[0]!.basedOn).toContain("rsi_short");
    expect(agg.picks[0]!.link).toContain("https://praxis.example.test/picks");
    // the review date D is bounded: the outcomes closed AFTER D are not in tonight's strip
    expect(agg.successLine).toBe(
      `Model success: not measured yet — 0 of ${params.picks.pickSuccessMinN} picks closed`,
    );
    expect(s.honesty).toBe("Personal use only · Not financial advice · Model not proven yet");
  });

  it("shows nothing for a date with no picks", async () => {
    const ctx = await loadCtx(db, {
      market: MARKET,
      d: SESSIONS[10]!,
      env: "production",
      appUrl: "https://praxis.example.test",
      now: new Date(NOW),
    });
    const s = await readPicksSection(ctx, {
      picks: params.picks,
      confidence: params.cif.confidence,
    });
    expect(s.none).toBe(true);
    expect(s.profiles.every((p) => p.picks.length === 0)).toBe(true);
  });
});
