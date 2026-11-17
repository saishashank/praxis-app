// @vitest-environment node
// The SHOCK stop comparator (M23 T4; CXA-011, D-1638, D-1750 to D-1759): the frozen plan agrees with the constants; hand paths of the
// two walks (tightened stop hit, not hit, gap through); the paired difference; 29 recorded holds take no look and 30 take exactly
// one; a hold that saw a SHOCK session is recorded once through the real scoring and the real night seam; the variant cap holds the
// first row back; a write allowlist and the no-OFFSET and rows-ok rules. Synthetic ZZ data only (SEC-110).
import fs from "node:fs";
import path from "node:path";
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import type { ViewBar } from "@/lib/agents/decisionView";
import { loadAgentParams } from "@/lib/agents/params";
import { COST_PROFILES } from "@/lib/arena/costs";
import { scoreOutcomes } from "@/lib/cortex/stage";
import type { ExitPlan } from "@/lib/agents/families/types";
import { lineageName } from "@/lib/research/names";
import {
  SHOCK_ATR_MULTIPLE,
  SHOCK_ATR_PERIOD,
  SHOCK_BLOCK,
  SHOCK_FAMILIES,
  SHOCK_N,
  SHOCK_PLAN_PATH,
  atr14Micro,
  evaluateShock,
  netPpm,
  replayHold,
  shockLevel,
  shockLineage,
  type ShockObs,
} from "@/lib/research/lineages/shockStops";
import { runResearchNight } from "@/lib/research/night";
import {
  firstShockSession,
  holdOrigin,
  runShockStops,
  shockStopsStep,
} from "@/lib/research/steps/shockStops";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);
const ROOT = path.resolve(import.meta.dirname, "../..");
const M = 1_000_000n;
const TS = "2031-06-30T12:00:00Z";

// ---- bars -------------------------------------------------------------------------------------------------------------------

const bar = (d: string, o: number, h: number, l: number, c: number): ViewBar => ({
  d,
  open: BigInt(Math.round(o * 1e6)),
  high: BigInt(Math.round(h * 1e6)),
  low: BigInt(Math.round(l * 1e6)),
  close: BigInt(Math.round(c * 1e6)),
  volume: 1_000_000n,
});

/** Weekday dates from `from`, n of them. */
function weekdays(from: string, n: number): string[] {
  const out: string[] = [];
  const t = new Date(`${from}T00:00:00Z`);
  while (out.length < n) {
    const dow = t.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(t.toISOString().slice(0, 10));
    t.setUTCDate(t.getUTCDate() + 1);
  }
  return out;
}

const DAYS = weekdays("2030-01-02", 80);
/** 40 flat sessions around 100 with a true range of 2 (ATR 2), the history of a decision on its last day. */
const HISTORY = DAYS.slice(0, 40).map((d) => bar(d, 100, 101, 99, 100));
const AFTER = DAYS.slice(40);
const DEC_D = DAYS[39]!;

const stop = (level: number): ExitPlan => ({
  initialStops: [
    {
      id: "initial",
      via: null,
      spec: { atr_micro: null, k: null, cap: null, level_micro: BigInt(level) * M },
    },
  ],
  trails: [],
  cs: [{ id: "max_hold", via: null, kind: "time_stop", sessions: 12, minReturn: null }],
});

const input = (bars: readonly ViewBar[]) => ({
  code: "ZZA",
  family: "F1" as const,
  qty: 10n,
  limitMicro: 101n * M,
  plan: stop(80),
  atrMicro: 2n * M,
  bars,
  profile: COST_PROFILES.P5,
  advMicro: 1_000_000_000_000n,
});

/** fill day, then a SHOCK day closing at 99, then the given sessions. */
const path1 = (rest: ViewBar[]): ViewBar[] => [
  bar(AFTER[0]!, 100, 101, 99.5, 100), // fill at the open, no stop touched
  bar(AFTER[1]!, 100, 100.5, 98.5, 99), // the SHOCK session: close 99, ATR 2 -> the raised level is 97
  ...rest,
];

describe("the frozen plan and the constants (D-1638, D-1750)", () => {
  const plan = JSON.parse(fs.readFileSync(path.join(ROOT, SHOCK_PLAN_PATH), "utf8")) as Record<
    string,
    unknown
  >;
  it("agrees with the code", () => {
    expect(plan.item).toBe("CXA-011");
    expect(plan.n).toBe(SHOCK_N);
    expect(plan.atr_period).toBe(SHOCK_ATR_PERIOD);
    expect(plan.atr_multiple).toBe(Number(SHOCK_ATR_MULTIPLE));
    expect(plan.block_sessions).toBe(SHOCK_BLOCK);
    expect(plan.level).toBe(0.1);
    expect(plan.replicates).toBe(2000);
    expect(plan.lineages).toEqual(SHOCK_FAMILIES.map(shockLineage));
  });
  it("every lineage has a plain name that carries no code", () => {
    for (const f of SHOCK_FAMILIES) {
      const n = lineageName(shockLineage(f));
      expect(n).not.toBe("An unnamed test");
      expect(n).not.toMatch(/_|\bF[1-6]\b|CXA/);
    }
  });
});

describe("hand paths of the two walks", () => {
  it("the ATR(14) of flat range-2 bars is 2 and the raised level is the close less one ATR", () => {
    expect(atr14Micro(HISTORY)).toBe(2n * M);
    expect(shockLevel([...HISTORY, bar(AFTER[0]!, 100, 101, 99, 99)])).toBe(97n * M);
    expect(atr14Micro(HISTORY.slice(0, 10))).toBeNull();
  });

  it("tightened stop hit: the raised level is touched and filled at the level; the base path rides on to its time stop", () => {
    const bars = path1([
      bar(AFTER[2]!, 98.5, 99, 96.5, 97.5), // low 96.5 <= 97: the tight path exits at 97; the base stop is 80
      ...AFTER.slice(3, 16).map((d) => bar(d, 97.5, 98, 97, 97.5)),
    ]);
    const r = replayHold(input(bars), HISTORY, AFTER[1]!)!;
    expect(r).not.toBeNull();
    expect(r.raisedTo).toBe(shockLevel([...HISTORY, ...bars.slice(0, 2)]));
    expect(r.raisedTo > 97n * M && r.raisedTo < 97_100_000n).toBe(true); // 99 less an ATR a little under 2
    expect(r.tight.exitD).toBe(AFTER[2]);
    expect(r.tight.exitRule).toBe("level");
    expect(r.base.exitD > r.tight.exitD).toBe(true);
    expect(r.base.exitRule).toBe("close_signal");
    // exit near 97.03 against an entry at 100 loses about 3 % before costs, and the round-trip brokerage comes on top
    expect(r.tightPpm).toBeLessThan(-29_000);
    expect(r.tightPpm).toBeGreaterThan(-60_000);
    expect(r.basePpm).not.toBe(r.tightPpm);
  });

  it("not hit: the level is never touched, so the two paths are the same hold and the difference is zero", () => {
    const bars = path1(AFTER.slice(2, 16).map((d) => bar(d, 99, 100, 98, 99.5)));
    const r = replayHold(input(bars), HISTORY, AFTER[1]!)!;
    expect(r.tight.exitD).toBe(r.base.exitD);
    expect(r.tight.exitRule).toBe(r.base.exitRule);
    expect(r.tightPpm).toBe(r.basePpm);
  });

  it("gap through: the next open is below the raised level, so the tight path fills at the open", () => {
    const bars = path1([
      bar(AFTER[2]!, 95, 96, 94, 95.5), // opens below 97
      ...AFTER.slice(3, 16).map((d) => bar(d, 95.5, 96, 95, 95.5)),
    ]);
    const r = replayHold(input(bars), HISTORY, AFTER[1]!)!;
    expect(r.tight.exitD).toBe(AFTER[2]);
    expect(r.tight.exitRule).toBe("gap_open");
    expect(r.tightPpm).toBeLessThan(-40_000); // filled near 95 against 100
  });

  it("returns nothing when the date is not a session of the hold or the hold never closes", () => {
    const bars = path1(AFTER.slice(2, 16).map((d) => bar(d, 99, 100, 98, 99.5)));
    expect(replayHold(input(bars), HISTORY, "2031-01-01")).toBeNull();
    expect(replayHold(input(bars.slice(0, 5)), HISTORY, AFTER[1]!)).toBeNull();
  });

  it("the walker is unchanged without the hook (a base walk equals itself, a hook that never raises changes nothing)", async () => {
    const { wouldHaveOutcome } = await import("@/lib/cortex/night");
    const bars = path1(AFTER.slice(2, 16).map((d) => bar(d, 99, 100, 98, 99.5)));
    const a = wouldHaveOutcome(input(bars));
    const b = wouldHaveOutcome({ ...input(bars), raiseStop: () => null });
    const c = wouldHaveOutcome({ ...input(bars), raiseStop: () => 1n });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });
});

describe("parts per million and the first SHOCK session", () => {
  it("rounds half away from zero on the fill value", () => {
    expect(netPpm(5_000_000n, 100n * M, 10n)).toBe(5_000);
    expect(netPpm(1n, 2n * M, 1n)).toBe(1);
    expect(netPpm(1n, 3n * M, 1n)).toBe(0);
    expect(netPpm(1_000_000n, 2n * M, 1n)).toBe(500_000);
    expect(netPpm(-1n, 2n * M, 1n)).toBe(-1);
    expect(netPpm(-1_500_000n, 1_000_000n, 3n)).toBe(-500_000);
    expect(() => netPpm(1n, 0n, 1n)).toThrow();
  });
  it("the first SHOCK session after the fill and before the exit", () => {
    const s = ["2030-03-01", "2030-03-04", "2030-03-20"];
    expect(firstShockSession(s, "2030-03-04", "2030-03-10")).toBe("2030-03-04");
    expect(firstShockSession(s, "2030-03-05", "2030-03-10")).toBeNull();
    expect(firstShockSession(s, "2030-03-05", "2030-03-21")).toBe("2030-03-20");
    expect(firstShockSession(s, "2030-03-01", "2030-03-01")).toBeNull(); // a SHOCK on the exit session is no raise
  });
});

describe("the one look of a family (30 holds)", () => {
  const sessions = weekdays("2031-01-02", 40);
  const make = (n: number, diff: number): ShockObs[] =>
    Array.from({ length: n }, (_, i) => ({
      dShock: sessions[i % sessions.length]!,
      basePpm: -10_000,
      tightPpm: -10_000 + diff + (i % 2 === 0 ? 100 : -100),
    }));
  it("29 holds: below sample, nothing computed", () => {
    expect(evaluateShock("F1", make(29, 5_000))).toEqual({
      status: "below_sample",
      reason: "too few recorded holds",
    });
  });
  it("30 holds: a clearly better tight path is PASS, a worse one NULL, an equal one NULL", () => {
    const pass = evaluateShock("F1", make(30, 5_000));
    expect(pass.status === "looked" && pass.verdict).toBe("PASS");
    expect(evaluateShock("F1", make(30, -5_000))).toMatchObject({
      status: "looked",
      verdict: "NULL",
    });
    const zero = evaluateShock("F1", make(30, 0));
    expect(zero).toMatchObject({ status: "looked", verdict: "NULL", n: 30 });
    if (pass.status === "looked") {
      expect(pass.meanDiffPpm).toBeCloseTo(5_000, 6);
      expect(pass.lowerPpm).toBeGreaterThan(0);
    }
  });
  it("is deterministic", () => {
    expect(evaluateShock("F2", make(31, 2_000))).toEqual(evaluateShock("F2", make(31, 2_000)));
  });
});

// ---- the step through the real database -------------------------------------------------------------------------------------

const count = async (db: Client, t: string): Promise<number> =>
  Number((await db.execute(`SELECT COUNT(*) n FROM ${t}`)).rows[0]!.n);

async function seedRows(db: Client, family: string, n: number, from = 0): Promise<void> {
  const sessions = weekdays("2031-01-02", 40);
  for (let i = from; i < n; i += 1) {
    await db.execute({
      sql: `INSERT INTO shock_stop_outcome (market, family, origin, d_entry, d_shock, base_net_ppm, tight_net_ppm, created_at)
            VALUES ('AU', ?, ?, '2031-01-02', ?, -10000, ?, '2031-06-30T00:00:00Z')`,
      args: [
        family,
        `o${String(i).padStart(3, "0")}`,
        sessions[i % sessions.length]!,
        i % 2 === 0 ? -4_900 : -5_100,
      ],
    });
  }
}

describe("the step: plans, meters and the one look", () => {
  it("freezes six plans and writes six meter rows; with no SHOCK nothing else", async () => {
    const db = await freshDb("main");
    const r = await runResearchNight(db, { market: "AU", d: "2031-06-30", now: TS }, [
      shockStopsStep,
    ]);
    expect(r).toEqual({ status: "ran", ran: ["shockStops"], failed: [] });
    expect(await count(db, "research_prereg")).toBe(6);
    expect(await count(db, "research_meter")).toBe(6);
    expect(await count(db, "shock_stop_outcome")).toBe(0);
    expect(await count(db, "holdout_look")).toBe(0);
    const m = await db.execute("SELECT DISTINCT status, n, target FROM research_meter");
    expect(m.rows.map((x) => ({ ...x }))).toEqual([{ status: "collecting", n: 0, target: 30 }]);
  });

  it("29 recorded holds take no look; 30 take exactly one, and a second night takes none", async () => {
    const db = await freshDb("main");
    await seedRows(db, "F1", 29);
    await runShockStops(db, { market: "AU", d: "2031-06-30", now: TS });
    expect(await count(db, "holdout_look")).toBe(0);
    expect(await count(db, "research_result")).toBe(0);
    const m = await db.execute(
      "SELECT status, n FROM research_meter WHERE lineage = 'shock_stops_F1'",
    );
    expect(m.rows.map((x) => ({ ...x }))).toEqual([{ status: "collecting", n: 29 }]);

    await seedRows(db, "F1", 30, 29); // the thirtieth hold
    const out = await runShockStops(db, {
      market: "AU",
      d: "2031-07-01",
      now: "2031-07-01T12:00:00Z",
    });
    expect(out.find((x) => x.family === "F1")).toMatchObject({
      n: 30,
      status: "looked",
      looked: true,
    });
    expect(await count(db, "holdout_look")).toBe(1);
    expect(await count(db, "research_result")).toBe(1);
    const look = await db.execute(
      "SELECT h.lineage AS lineage, h.verdict AS verdict, r.n_setups AS n_setups FROM holdout_look h JOIN research_result r ON r.lineage = h.lineage AND r.market = h.market",
    );
    expect(look.rows[0]!.lineage).toBe("shock_stops_F1");
    expect(["PASS", "NULL", "INCONCLUSIVE"]).toContain(String(look.rows[0]!.verdict));
    expect(Number(look.rows[0]!.n_setups)).toBe(30);

    await runShockStops(db, { market: "AU", d: "2031-07-02", now: "2031-07-02T12:00:00Z" });
    expect(await count(db, "holdout_look")).toBe(1);
    expect(await count(db, "holdout_look_refusal")).toBe(0);
    const last = await db.execute(
      "SELECT status FROM research_meter WHERE lineage = 'shock_stops_F1' ORDER BY d DESC LIMIT 1",
    );
    expect(last.rows[0]!.status).toBe("looked");
  });

  it("is skipped for a market that is off, and writes nothing on a replayed night", async () => {
    const db = await freshDb("main");
    for (const market of ["IN", "US"])
      expect(
        (await runResearchNight(db, { market, d: "2031-06-30", now: TS }, [shockStopsStep])).status,
      ).toBe("skipped_market");
    expect(
      (
        await runResearchNight(db, { market: "AU", d: "2031-06-30", now: TS, replay: true }, [
          shockStopsStep,
        ])
      ).status,
    ).toBe("skipped_replay");
    expect(await count(db, "research_meter")).toBe(0);
  });
});

// ---- a hold that saw a SHOCK session, end to end ------------------------------------------------------------------------------

async function seedHold(
  db: Client,
  regimeDays: string[],
): Promise<{ decD: string; exitD: string | null }> {
  const stmt = (code: string, d: string, o: number, h: number, l: number, c: number) => ({
    sql: `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
          VALUES ('AU', ?, ?, ?, ?, ?, ?, 1000000, 'synthetic', ?, ?)`,
    args: [code, d, o, h, l, c, `${d}T06:30:00.000Z`, `${d}T07:00:00.000Z`],
  });
  const batch = HISTORY.map((b) => stmt("ZZA", b.d, 100, 101, 99, 100));
  // the tight path leaves on AFTER[2] at the raised level; the base path (the real F1 plan, stop about 5 below the fill) on AFTER[3]
  const path = path1([
    bar(AFTER[2]!, 98.5, 99, 96.5, 97.5),
    bar(AFTER[3]!, 97.5, 97.6, 93.5, 94),
    ...AFTER.slice(4, 8).map((d) => bar(d, 94, 94.5, 93.5, 94)),
  ]);
  AFTER.slice(0, path.length).forEach((d, i) => {
    const b = path[i]!;
    batch.push(
      stmt(
        "ZZA",
        d,
        Number(b.open) / 1e6,
        Number(b.high) / 1e6,
        Number(b.low) / 1e6,
        Number(b.close) / 1e6,
      ),
    );
  });
  await db.batch(batch, "write");
  await db.execute({
    sql: `INSERT INTO cortex_decision (market, d, book_id, code, arm, family, limit_micro, stop_micro, qty, gate_trace_json, manifest_id)
          VALUES ('AU', ?, 'E01@x', 'ZZA', 'shadow', 'F1', 101000000, 90000000, 10, '[]', 'zz-manifest')`,
    args: [DEC_D],
  });
  const params = await loadAgentParams(db);
  await scoreOutcomes(db, { market: "AU", d: AFTER[7]!, params, now: () => TS });
  for (const d of regimeDays) {
    await db.execute({
      sql: `INSERT INTO regime_daily (market, d, version, close_micro, raw_state, state, exit_streak)
            VALUES ('AU', ?, 1, 1000000, 'SHOCK', 'SHOCK', 0)`,
      args: [d],
    });
  }
  const o = await db.execute(
    "SELECT fill_status, exit_d, exit_rule FROM cortex_outcome WHERE code = 'ZZA'",
  );
  return {
    decD: DEC_D,
    exitD: o.rows[0]?.exit_d === null || o.rows[0] === undefined ? null : String(o.rows[0].exit_d),
  };
}

describe("a closed hold that saw a SHOCK session (the real scoring and the real night)", () => {
  it("is recorded once with both nets; a second night adds nothing; a hold with no SHOCK is not recorded", async () => {
    const db = await freshDb("main");
    const { exitD } = await seedHold(db, [AFTER[1]!]);
    expect(exitD).not.toBeNull();
    const o = { market: "AU", d: AFTER[7]!, now: TS };
    await runShockStops(db, o);
    const rows = await db.execute("SELECT * FROM shock_stop_outcome");
    expect(rows.rows).toHaveLength(1);
    const r = rows.rows[0]!;
    expect(r.family).toBe("F1");
    expect(r.origin).toBe(holdOrigin(DEC_D, "shadow", "ZZA", "E01@x"));
    expect(r.d_shock).toBe(AFTER[1]);
    expect(r.d_entry).toBe(AFTER[0]);
    expect(Number(r.tight_net_ppm)).not.toBe(Number(r.base_net_ppm));
    const meter = await db.execute(
      "SELECT n, status FROM research_meter WHERE lineage = 'shock_stops_F1'",
    );
    expect(meter.rows.map((x) => ({ ...x }))).toEqual([{ n: 1, status: "collecting" }]);
    await runShockStops(db, { ...o, now: "2031-07-01T12:00:00Z" });
    expect(await count(db, "shock_stop_outcome")).toBe(1);
    // the AU night tables the comparator must not touch are not touched
    expect(await count(db, "holdout_look")).toBe(0);
  });

  it("a SHOCK session before the fill or on the exit session records nothing", async () => {
    const db = await freshDb("main");
    const { exitD } = await seedHold(db, [DAYS[30]!, exitD0()]);
    expect(exitD).not.toBeNull();
    await runShockStops(db, { market: "AU", d: AFTER[7]!, now: TS });
    expect(await count(db, "shock_stop_outcome")).toBe(0);
  });

  it("with the family's variant cap full the first row waits and the meter says blocked; it records once a slot is free", async () => {
    const db = await freshDb("main");
    await seedHold(db, [AFTER[1]!]);
    const capFull = await runShockStopsWithCap(db, 3);
    expect(capFull).toBe("blocked");
    expect(await count(db, "shock_stop_outcome")).toBe(0);
    const free = await runShockStopsWithCap(db, 2);
    expect(free).toBe("collecting");
    expect(await count(db, "shock_stop_outcome")).toBe(1);
  });
});

/** The exit session of the seeded hold (the base path leaves on it). */
const exitD0 = (): string => AFTER[3]!;

/** Runs the night with a stand-in for the existing variant count; the real count is covered by challengerLifecycle's own tests. */
async function runShockStopsWithCap(db: Client, variants: number): Promise<string> {
  const mod = await import("@/lib/research/steps/shockStops");
  const out = await mod.runShockStops(
    db,
    { market: "AU", d: AFTER[7]!, now: TS },
    { variants: async () => variants },
  );
  return out.find((x) => x.family === "F1")!.status;
}

// ---- boundaries ---------------------------------------------------------------------------------------------------------------

const FILES = [
  "src/lib/research/lineages/shockStops.ts",
  "src/lib/research/steps/shockStops.ts",
  "src/lib/cortex/holdInputs.ts",
];
const code = (f: string): string =>
  fs
    .readFileSync(path.join(ROOT, f), "utf8")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

describe("what the comparator files write and import", () => {
  it("write only shock_stop_outcome, research_meter and app_log directly (the registry gate writes the look tables)", () => {
    const WRITE =
      /(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|(?<!DO\s)UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
    const bad: string[] = [];
    for (const f of FILES)
      for (const m of code(f).matchAll(WRITE))
        if (!["shock_stop_outcome", "research_meter", "app_log"].includes(m[1]!.toLowerCase()))
          bad.push(`${f}: ${m[0]}`);
    expect(bad).toEqual([]);
  });

  it("no OFFSET paging, and every statement carries a rows-ok line", () => {
    for (const f of FILES) {
      expect(code(f), f).not.toMatch(/\bOFFSET\b/i);
      const lines = fs.readFileSync(path.join(ROOT, f), "utf8").split("\n");
      lines.forEach((l, i) => {
        if (!/\bsql:/.test(l)) return;
        expect(lines.slice(Math.max(0, i - 4), i + 1).join("\n"), `${f}:${i + 1}`).toMatch(
          /rows-ok/,
        );
      });
    }
  });

  it("the research files import no book, order, gate, sizing, status or e-mail module", () => {
    for (const f of FILES.filter((x) => x.includes("/research/")))
      expect(code(f), f).not.toMatch(
        /from\s+["']@\/lib\/(arena|picks|rules|breakers?|sizing|ranking|email|mail|cortex\/(status(?!Rules)|look|gates|store\/status))/,
      );
  });
});
