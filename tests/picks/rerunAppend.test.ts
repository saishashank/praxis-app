// @vitest-environment node
// D-1856: the Owner's dated rerun of a past session (`arena-signals.yml` input `date`). Fri 20 Nov 2026
// published 5 shortlist picks because the day's bars were stored after the cut-off; the rerun reads
// those bars, and its strategy picks are ADDED after the published ones (next rank, up to 10). The
// published picks are never changed or deleted, and a normal night still refuses to rewrite a rank.
import type { Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePicks, PICK_RANK_MAX, type GenerateContext } from "@/lib/picks/generate";
import { runPicksNight } from "@/lib/picks/nightly";
import { PicksError, type PickInput } from "@/lib/picks/types";
import { cleanupTempDbs } from "../db/helpers";
import {
  D,
  MARKET,
  NOW,
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

// flat bars: every code a small company, so all of them fall in the Aggressive band (D-1000)
const specs: CodeSpec[] = ["ZZA1", "ZZB1", "ZZD3"].map((code) => ({
  code,
  tier: "U3",
  base: 10_000_000n,
  step: 0n,
}));

let db: Client;
let run: Sql;
const rows = async (sql: string, args: (string | number)[] = []) =>
  (await db.execute({ sql, args })).rows.map((r) => ({ ...r }));
const signal = async (code: string, rank: string) =>
  addCard(
    run,
    await addSignal(run, {
      d: D,
      family: "F1",
      rv: "F1.v1",
      code,
      tier: "U3",
      closeMicro: 10_000_000n,
      rank,
    }),
    9_200_000n,
  );
const night = (append?: boolean) =>
  runPicksNight(db, {
    market: MARKET,
    d: D,
    params,
    calendar: [],
    now: NOW,
    ...(append === undefined ? {} : { appendAfterPublished: append }),
  });

beforeAll(async () => {
  ({ db, run } = await world());
  for (const s of specs) await addBars(run, s, 0, 60);
  await addUniverse(run, D, specs);
  await addHistory(run);
  await addExecutionAndLabel(run, "F1", "F1.v1", "PASSED-BACKTEST");
  // the published night: one strategy signal only (the late bars hid the others)
  await signal("ZZA1", "9/1");
  await night();
});

afterAll(cleanupTempDbs);

describe("D-1856 dated rerun of a published session", () => {
  it("the published night has its pick at rank 1", async () => {
    const picks = await rows("SELECT profile, rank, code FROM pick ORDER BY profile, rank");
    expect(picks).toEqual([{ profile: "aggressive", rank: 1, code: "ZZA1" }]);
  });

  it("a normal night with new signals still refuses to rewrite a published rank", async () => {
    // the late bars now give a stronger signal; a normal run would put it at rank 1
    await signal("ZZB1", "99/1");
    await signal("ZZD3", "6/1");
    const before = await rows("SELECT * FROM pick ORDER BY profile, rank");
    await expect(night()).rejects.toThrow(PicksError);
    expect(await rows("SELECT * FROM pick ORDER BY profile, rank")).toEqual(before);
  });

  it("the rerun keeps every published pick byte-identical and adds strategy picks after them", async () => {
    const pick = await rows("SELECT * FROM pick ORDER BY profile, rank");
    const outcome = await rows("SELECT * FROM pick_outcome ORDER BY profile, rank, kind");
    const res = await night(true);
    const after = await rows("SELECT * FROM pick ORDER BY profile, rank");
    // ranks 1..n unchanged, field for field
    expect(after.slice(0, pick.length)).toEqual(pick);
    const outcomeAfter = await rows("SELECT * FROM pick_outcome ORDER BY profile, rank, kind");
    expect(outcomeAfter.filter((o) => Number(o.rank) <= pick.length)).toEqual(outcome);
    // ZZB1 follows at rank 2; ZZD3 is the third F1 pick and stays out (2 per family, the
    // published pick counts)
    const added = after.slice(pick.length).map((p) => ({ rank: p.rank, code: p.code }));
    expect(added).toEqual([{ rank: 2, code: "ZZB1" }]);
    expect(res.appended).toEqual({ kept: 1, added: 1 });
    expect(res.shortlist).toBe(0);
  });

  it("is idempotent: the same rerun again writes nothing", async () => {
    const before = await rows("SELECT * FROM pick ORDER BY profile, rank");
    const res = await night(true);
    expect(res.appended).toEqual({ kept: 2, added: 0 });
    expect(await rows("SELECT * FROM pick ORDER BY profile, rank")).toEqual(before);
  });
});

describe("D-1856 generatePicks after published picks (pure)", () => {
  const mk = (code: string, rankScore: string, family: PickInput["family"] = "F1"): PickInput => ({
    code,
    signalId: `sig:${code}`,
    cardId: `card:${code}`,
    family,
    ruleVersion: `${family}.v1`,
    variant: "U",
    tier: "U3",
    rankScore,
    label: "PASSED-BACKTEST",
    referenceMicro: 10_000_000n,
    stopMicro: 9_200_000n,
    advValueMicro: 5_000_000_000n,
    vol: 0.05,
    scenario: { n: 87, badPpm: -60_000, typicalPpm: 30_000, goodPpm: 110_000 },
    aimReachPpm: 400_000,
    holdMedianSessions: 15,
    medianDropPpm: 50_000,
    factors: [],
    basedOn: ["a", "b", "c", "d"],
  });
  const codes = Array.from({ length: 12 }, (_, i) => `YY${String(i + 1).padStart(2, "0")}`);
  const ctx = (existing?: GenerateContext["existing"]): GenerateContext => ({
    market: "AU",
    d: "2030-03-22",
    calendar: [],
    picks: { ...params.picks, picksMaxPerFamily: 99 },
    universe: codes.map((code) => ({ code, tier: "U3" as const, vol: 0.05 })),
    createdAt: "2030-03-22T07:00:00.000Z",
    ...(existing === undefined ? {} : { existing }),
  });
  // five published shortlist picks, then twelve strategy inputs (two of them already published)
  const published = codes.slice(0, 5).map((code, i) => ({ rank: i + 1, code, family: "SL" }));
  const inputs = codes.map((c, i) => mk(c, `${50 - i}/1`, "F1"));

  it("starts after the highest published rank, skips published companies, stops at rank 10", () => {
    const out = generatePicks(inputs, ctx(new Map([["aggressive", published]])));
    const aggr = out.filter((p) => p.profile === "aggressive");
    expect(aggr.map((p) => p.rank)).toEqual([6, 7, 8, 9, 10]);
    expect(aggr.every((p) => !published.some((e) => e.code === p.code))).toBe(true);
    expect(Math.max(...aggr.map((p) => p.rank))).toBe(PICK_RANK_MAX);
  });

  it("without published picks a night is unchanged (picksPerProfile, from rank 1)", () => {
    const plain = generatePicks(inputs, ctx()).filter((p) => p.profile === "aggressive");
    expect(plain.map((p) => p.rank)).toEqual(
      Array.from({ length: params.picks.picksPerProfile }, (_, i) => i + 1),
    );
  });

  it("a session already at rank 10 gets nothing more", () => {
    const full = codes.slice(0, 10).map((code, i) => ({ rank: i + 1, code, family: "SL" }));
    const out = generatePicks(inputs, ctx(new Map([["aggressive", full]])));
    expect(out.filter((p) => p.profile === "aggressive")).toEqual([]);
  });
});
