// @vitest-environment node
// Committee trial pre-registration (M22 C2; VAL-111, BLD-051; D-1420): version 1 is written once before any rating with the
// frozen figures and their sha; a later version, an unreadable text or a wrong sha is a problem; a verdict other than INVALID
// closes the market to a new trial (one look); the four frozen keys are refused by the switch guard while a trial runs; the
// engine finds the trial the step wrote and the trial command lines refuse replays and past dates.
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { committeeNight } from "@/lib/committee/night";
import {
  ensurePrereg,
  frozenText,
  parseFrozen,
  preregProblem,
  readVersions,
  shaOf,
  STATISTIC_TEXT,
} from "@/lib/committee/prereg";
import { trialMain } from "@/lib/committee/trialCli";
import { trialNight } from "@/lib/committee/trial";
import {
  FROZEN_TRIAL_KEYS,
  FROZEN_TRIAL_REFUSAL,
  frozenTrialGuard,
} from "@/lib/config/guards/committee";
import { roundTripThresholdPpm } from "@/lib/stats/committeeCost";
import { cleanupTempDbs } from "../db/helpers";
import {
  committeeLlm,
  committeeProvider,
  nightOptions,
  seedNight,
  D,
  NOW as NIGHT_NOW,
} from "./harness";
import { build, FROZEN, grid, NOW, switchOn } from "./trialWorld";

afterEach(cleanupTempDbs);

const o = (d: string, over: Record<string, unknown> = {}) => ({
  market: "AU",
  d,
  today: d,
  now: NOW,
  ...over,
});
const prereg = async (db: Client) =>
  (await db.execute("SELECT * FROM committee_prereg ORDER BY trial_id, version")).rows;

describe("the frozen text", () => {
  it("round-trips, and the sha is the sha-256 of the exact text", () => {
    const text = frozenText(FROZEN);
    expect(parseFrozen(text)).toEqual(FROZEN);
    expect(shaOf(text)).toMatch(/^[0-9a-f]{64}$/);
    expect(shaOf(text)).toBe(shaOf(frozenText({ ...FROZEN })));
    expect(shaOf(text)).not.toBe(shaOf(frozenText({ ...FROZEN, min_settled: 13 })));
  });

  it("rejects an incomplete text", () => {
    expect(parseFrozen("{}")).toBeNull();
    expect(parseFrozen("[]")).toBeNull();
    expect(parseFrozen("not json")).toBeNull();
    expect(parseFrozen(frozenText({ ...FROZEN, permutations: -1 }))).toBeNull();
  });

  it("the cost bar is one round trip at the default profile, a positive whole number of ppm", () => {
    const bar = roundTripThresholdPpm();
    expect(Number.isInteger(bar)).toBe(true);
    expect(bar).toBeGreaterThan(0);
    expect(bar).toBeLessThan(100_000); // under 10 % of the notional
  });
});

describe("ensurePrereg: version 1 before the first rated night (D-1420)", () => {
  it("writes version 1 once, with the keys' figures and the sha, when the switch is on", async () => {
    const db = await build([], { prereg: false });
    await switchOn(db);
    const r = await ensurePrereg(db, o("2026-06-30"));
    expect(r).toMatchObject({ status: "written", trialId: "committee-2026-06-30" });
    const rows = await prereg(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ version: 1, market: "AU" });
    const f = parseFrozen(String(rows[0]!.frozen_json))!;
    expect(f).toMatchObject({
      horizon_sessions: 20,
      trial_sessions: 126,
      min_settled: 150,
      permutations: 20_000,
      cost_threshold_ppm: roundTripThresholdPpm(),
      statistic: STATISTIC_TEXT,
      started_d: "2026-06-30",
    });
    expect(shaOf(String(rows[0]!.frozen_json))).toBe(String(rows[0]!.sha));
    expect(preregProblem(await readVersions(db, "AU", "committee-2026-06-30"))).toBeNull();
    // a second call the same night, or any later night, writes nothing
    expect(await ensurePrereg(db, o("2026-06-30"))).toEqual({
      status: "present",
      trialId: "committee-2026-06-30",
    });
    expect(await ensurePrereg(db, o("2026-07-01"))).toEqual({
      status: "present",
      trialId: "committee-2026-06-30",
    });
    expect(await prereg(db)).toHaveLength(1);
  });

  it("writes nothing when the switch is off, on a replay, or for a day that is not today", async () => {
    const db = await build([], { prereg: false });
    expect(await ensurePrereg(db, o("2026-06-30"))).toEqual({ status: "off" });
    await switchOn(db);
    expect(await ensurePrereg(db, { ...o("2026-06-30"), replay: true })).toEqual({
      status: "refused",
    });
    expect(await ensurePrereg(db, { ...o("2026-06-29"), today: "2026-06-30" })).toEqual({
      status: "refused",
    });
    expect(await prereg(db)).toHaveLength(0);
  });

  it("after a verdict other than INVALID no new trial starts (one look per market)", async () => {
    const db = await build(
      grid(8, () => 100),
      { frozen: { trial_sessions: 6, min_settled: 12 } },
    );
    await switchOn(db);
    expect((await trialNight(db, o("2026-06-30"))).status).toBe("final");
    await switchOn(db);
    expect(await ensurePrereg(db, o("2026-07-01"))).toEqual({ status: "done" });
    expect(await prereg(db)).toHaveLength(1);
  });

  it("after an INVALID trial a new trial may start (nothing was measured, no look was taken)", async () => {
    const db = await build(grid(3, () => 100));
    await switchOn(db);
    const text = frozenText({ ...FROZEN, min_settled: 99 });
    await db.execute({
      sql: "INSERT INTO committee_prereg (trial_id, version, market, frozen_json, sha, created_at) VALUES ('zz-trial-1', 2, 'AU', ?, ?, ?)",
      args: [text, shaOf(text), "2026-02-01T00:00:00.000Z"],
    });
    expect(await trialNight(db, o("2026-06-30"))).toMatchObject({
      status: "final",
      verdict: "INVALID",
    });
    expect((await db.execute("SELECT COUNT(*) n FROM holdout_look")).rows[0]!.n).toBe(0);
    await switchOn(db);
    expect(await ensurePrereg(db, o("2026-07-01"))).toMatchObject({
      status: "written",
      trialId: "committee-2026-07-01",
    });
  });
});

describe("a pre-registration that is not sound is INVALID (D-1420)", () => {
  it("a second version, an unreadable text and a wrong sha are each a problem", async () => {
    const good = frozenText(FROZEN);
    const v = (n: number, text: string, sha: string) => ({
      trialId: "t",
      version: n,
      frozenJson: text,
      sha,
      createdAt: "x",
    });
    expect(preregProblem([])).toBe("no pre-registration");
    expect(preregProblem([v(1, good, shaOf(good))])).toBeNull();
    expect(preregProblem([v(1, good, shaOf(good)), v(2, good, shaOf(good))])).toMatch(
      /edited after the trial started/,
    );
    expect(preregProblem([v(1, "{}", shaOf("{}"))])).toMatch(/cannot be read/);
    expect(preregProblem([v(1, good, "a".repeat(64))])).toMatch(/fingerprint/);
  });
});

describe("the four frozen keys", () => {
  it("are refused while a trial runs and free again after its final row (the guard of A2)", async () => {
    const db = await build(
      grid(8, () => 100),
      { frozen: { trial_sessions: 6, min_settled: 12 } },
    );
    for (const k of FROZEN_TRIAL_KEYS) expect(k).toMatch(/^committee_/);
    expect(await frozenTrialGuard(db, "30")).toBe(FROZEN_TRIAL_REFUSAL);
    await switchOn(db);
    await trialNight(db, o("2026-06-30"));
    expect(await frozenTrialGuard(db, "30")).toBeNull();
  });
});

describe("the engine finds the trial the step wrote", () => {
  it("rates under the trial id of the newest pre-registration, after ensurePrereg and before trialNight", async () => {
    const db = await seedNight();
    await switchOn(db);
    expect((await ensurePrereg(db, { market: "AU", d: D, today: D, now: NIGHT_NOW })).status).toBe(
      "written",
    );
    const llm = committeeLlm([committeeProvider("alpha"), committeeProvider("beta")]);
    const res = await committeeNight(db, nightOptions(llm));
    expect(res.status).toBe("done");
    const ids = (await db.execute("SELECT DISTINCT trial_id FROM committee_rating")).rows.map(
      (r) => r.trial_id,
    );
    expect(ids).toEqual([`committee-${D}`]);
    expect((await trialNight(db, { market: "AU", d: D, today: D, now: NIGHT_NOW })).status).toBe(
      "running",
    );
    expect((await db.execute("SELECT kind, verdict FROM committee_trial_result")).rows).toEqual([
      { kind: "interim", verdict: "running" },
    ]);
  });
});

/** The same database with a close that keeps it open for the next call. */
const noClose = (db: Client): Client =>
  new Proxy(db, {
    get: (t, k) => {
      if (k === "close") return () => undefined;
      const v = Reflect.get(t, k) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });

describe("trialMain: the command line", () => {
  const run = async (db: Client, argv: string[], nowMs: number) => {
    const lines: string[] = [];
    const code = await trialMain(
      argv,
      { TURSO_MAIN_URL: "x" },
      { openDb: () => noClose(db), nowMs: () => nowMs, out: (l) => lines.push(l) },
    );
    return { code, lines };
  };
  const at = Date.parse("2026-06-30T01:00:00Z"); // 11:00 Melbourne, the same date

  it("refuses a replay flag, a past date and a missing phase, exits 0 and writes nothing", async () => {
    const db = await build([], { prereg: false });
    await switchOn(db);
    for (const argv of [
      ["prereg", "--replay"],
      ["result", "--recorded-day"],
      ["prereg", "--date", "2026-06-01"],
      [],
    ]) {
      const r = await run(db, argv, at);
      expect(r.code).toBe(0);
      expect(r.lines.join(" ")).toMatch(/refused/);
    }
    expect(await prereg(db)).toHaveLength(0);
  });

  it("the prereg phase writes the trial, the result phase writes the night's row", async () => {
    const db = await build([], { prereg: false });
    await switchOn(db);
    const a = await run(db, ["prereg"], at);
    expect(a.lines[0]).toMatch(/prereg written/);
    const b = await run(db, ["result"], at);
    expect(b.lines[0]).toMatch(/result running reason=sample_short/);
    expect((await db.execute("SELECT COUNT(*) n FROM committee_trial_result")).rows[0]!.n).toBe(1);
  });
});
