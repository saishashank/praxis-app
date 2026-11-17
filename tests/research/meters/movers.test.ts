// @vitest-environment node
// The mover-rule meters and their one look each (M23 M3; CXA-014, D-1625, D-1721): the plan file and the code agree, the plan is
// frozen before any count, a rule at n - 1 takes no look and reads no outcome, at n it takes exactly one, a second look is refused
// and audited, the direction decides PASS or NULL, and A2, A4 and A5 are blocked with no read. Synthetic data only (SEC-110).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { angleById } from "@/lib/cortex/angles/registry";
import { staticProfile } from "@/lib/market/staticProfile.mjs";
import {
  CREEP_ANGLE_ID,
  CREEP_GRID_KEY,
  MOVERS_PLAN_PATH,
  MOVER_RULES,
  evaluateMover,
  type MoverObs,
} from "@/lib/research/lineages/movers";
import { DEFAULT_MOVER_SOURCES, runMovers, type MoverSource } from "@/lib/research/meters/movers";
import { sha256Hex, takeLook } from "@/lib/research/registry";
import { cleanupTempDbs, freshDb } from "../../db/helpers";

afterEach(cleanupTempDbs);

const ROOT = join(__dirname, "../../..");
const planText = readFileSync(join(ROOT, MOVERS_PLAN_PATH), "utf8").replace(/\r\n/g, "\n");
const plan = JSON.parse(planText) as {
  replicates: number;
  level: number;
  rules: {
    id: string;
    lineage: string;
    kind: string;
    n: number;
    horizon_sessions: number;
    direction: string;
  }[];
};
const io = { read: (p: string) => (p === MOVERS_PLAN_PATH ? planText : null) };
const M = "AU";

/** Weekdays from a Monday far beyond any seeded calendar. */
function weekdays(n: number, start = "2045-01-02"): string[] {
  const out: string[] = [];
  const t = new Date(`${start}T00:00:00Z`);
  while (out.length < n) {
    if (t.getUTCDay() !== 0 && t.getUTCDay() !== 6) out.push(t.toISOString().slice(0, 10));
    t.setUTCDate(t.getUTCDate() + 1);
  }
  return out;
}
const DAYS = weekdays(60);
const at = (d: string) => ({ market: M, d, now: `${d}T12:00:00Z` });

async function calendar(db: Client, days: readonly string[]): Promise<void> {
  await db.batch(
    days.map((d) => ({
      sql: "INSERT OR IGNORE INTO trading_calendar (market, d, kind, close_time, confirmed, source) VALUES (?, ?, 'session', NULL, 1, 'test')",
      args: [M, d],
    })),
    "write",
  );
}

/** A flat benchmark index on every day. */
async function flatIndex(db: Client, days: readonly string[]): Promise<void> {
  const code = staticProfile(M).benchmarkIndex as string;
  await db.batch(
    days.map((d) => ({
      sql: `INSERT OR IGNORE INTO index_bar (market, index_code, d, o_micro, h_micro, l_micro, c_micro, source, published_at, ingested_at)
            VALUES (?, ?, ?, 1000000000, 1000000000, 1000000000, 1000000000, 'test', ?, ?)`,
      args: [M, code, d, `${d}T08:00:00Z`, `${d}T08:00:00Z`],
    })),
    "write",
  );
}

/** Bars of one code on the given days: open and close from a function of the day index. */
async function bars(
  db: Client,
  code: string,
  days: readonly string[],
  px: (k: number) => { o: number; c: number },
): Promise<void> {
  await db.batch(
    days.map((d, k) => ({
      sql: `INSERT OR IGNORE INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1000, 'test', ?, ?)`,
      args: [
        M,
        code,
        d,
        px(k).o,
        Math.max(px(k).o, px(k).c),
        Math.min(px(k).o, px(k).c),
        px(k).c,
        `${d}T08:00:00Z`,
        `${d}T08:00:00Z`,
      ],
    })),
    "write",
  );
}

const noise = (i: number): number => (((i * 7) % 11) - 5) / 1000;
const n = async (db: Client, sql: string): Promise<number> =>
  Number((await db.execute(sql)).rows[0]!.n);
const meter = async (db: Client, lineage: string, d: string) =>
  (
    await db.execute({
      sql: "SELECT n, target, status FROM research_meter WHERE market = ? AND lineage = ? AND d = ?",
      args: [M, lineage, d],
    })
  ).rows[0]!;

describe("the plan file and the code agree", () => {
  it("six rules with the n, horizon, kind and direction of D-1625; level 0.10, 2000 replicates", () => {
    expect(plan.replicates).toBe(2000);
    expect(plan.level).toBe(0.1);
    expect(plan.rules.map((r) => r.id)).toEqual(MOVER_RULES.map((r) => r.id));
    for (const rule of MOVER_RULES) {
      const p = plan.rules.find((r) => r.id === rule.id)!;
      expect(p.lineage, rule.id).toBe(rule.lineage);
      expect(p.kind, rule.id).toBe(rule.kind);
      expect(p.n, rule.id).toBe(rule.n);
      expect(p.horizon_sessions, rule.id).toBe(rule.horizon);
      if (rule.kind === "mean")
        expect(p.direction.startsWith(rule.direction === 1 ? "above" : "below"), rule.id).toBe(
          true,
        );
    }
    expect(plan.rules.map((r) => r.n)).toEqual([40, 60, 100, 60, 60, 60]);
  });

  it("the grid point A3 counts is the default point of the angle registry", () => {
    const def = angleById(CREEP_ANGLE_ID)!;
    const key = Object.keys(def.grid)
      .sort()
      .map((k) => `${k}=${def.grid[k]![0]}`)
      .join(",");
    expect(CREEP_GRID_KEY).toBe(key);
  });
});

describe("evaluateMover (pure)", () => {
  const a1 = MOVER_RULES[0]!;
  const obs = (count: number, ret: number): MoverObs[] =>
    Array.from({ length: count }, (_, i) => ({
      session: DAYS[Math.floor(i / 5)]!,
      value: Math.round((ret + noise(i)) * 1e6),
    }));

  it("at n - 1 it returns before it reads a single value", () => {
    const poisoned: MoverObs[] = Array.from({ length: a1.n - 1 }, (_, i) => ({
      session: DAYS[Math.floor(i / 5)]!,
      get value(): number {
        throw new Error("a value was read below n");
      },
    }));
    expect(evaluateMover(a1, poisoned)).toEqual({
      status: "below_sample",
      reason: "too few matured events",
    });
  });

  it("at n it looks; the direction decides: below zero passes on falling prices, not on rising ones", () => {
    const down = evaluateMover(a1, obs(a1.n, -0.03));
    const up = evaluateMover(a1, obs(a1.n, 0.03));
    if (down.status !== "looked" || up.status !== "looked") throw new Error("expected looks");
    expect(down.verdict).toBe("PASS");
    expect(down.meanPpm).toBeLessThan(0);
    expect(up.verdict).toBe("NULL");
    expect(down.n).toBe(a1.n);
  });

  it("is deterministic for the same input", () => {
    const a = evaluateMover(a1, obs(a1.n, -0.03));
    const b = evaluateMover(a1, obs(a1.n, -0.03));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("a difference rule needs n on each side", () => {
    const a8 = MOVER_RULES[5]!;
    const side = (count: number, s: 0 | 1, base: number): MoverObs[] =>
      Array.from({ length: count }, (_, i) => ({
        session: DAYS[i % 30]!,
        value: base + noise(i) * 1e6,
        side: s,
      }));
    expect(evaluateMover(a8, [...side(a8.n, 1, 20000), ...side(a8.n - 1, 0, -5000)]).status).toBe(
      "below_sample",
    );
    const r = evaluateMover(a8, [...side(a8.n, 1, 20000), ...side(a8.n, 0, -5000)]);
    if (r.status !== "looked") throw new Error("expected a look");
    expect(r.verdict).toBe("PASS");
    const flat = evaluateMover(a8, [...side(a8.n, 1, -5000), ...side(a8.n, 0, 20000)]);
    if (flat.status !== "looked") throw new Error("expected a look");
    expect(flat.verdict).toBe("NULL");
  });
});

describe("A1 halt-resume block on a database", () => {
  /** 39 matured resumes (five a session from DAYS[10]), the 40th on DAYS[18]; one positive-sign resume and one still open. */
  async function plant(db: Client, ret: number, noBars = 0): Promise<void> {
    await calendar(db, DAYS);
    await flatIndex(db, DAYS);
    const ins = async (
      code: string,
      since: string,
      status: "open" | "resumed",
      sign: number,
      resume: string | null,
    ) =>
      db.execute({
        sql: `INSERT INTO halt_watch (market, code, since_d, seq, status, reason_class, expected_sign, resume_d, known_at)
              VALUES (?, ?, ?, ?, ?, 'capital_raise', ?, ?, ?)`,
        args: [
          M,
          code,
          since,
          status === "open" ? 1 : 2,
          status,
          sign,
          resume,
          `${since}T01:00:00Z`,
        ],
      });
    for (let i = 0; i < 40; i += 1) {
      const r = DAYS[i < 39 ? 10 + Math.floor(i / 5) : 18]!;
      const k = DAYS.indexOf(r);
      await ins(`H${i}`, DAYS[k - 1]!, "resumed", -1, r);
      if (i >= noBars)
        await bars(db, `H${i}`, DAYS.slice(k, k + 6), (j) => ({
          o: 100,
          c: j === 4 ? 100 * (1 + ret + noise(i)) : 100,
        }));
    }
    await ins("HPOS", DAYS[9]!, "resumed", 1, DAYS[10]!); // a positive expectation never counts
    await ins("HOPEN", DAYS[12]!, "open", -1, null); // not resumed
  }

  it("n - 1 gives no look and reads no outcome; n gives exactly one; later nights give none; a direct second look is refused", async () => {
    const db = await freshDb("main");
    await plant(db, -0.03);
    const read = vi.fn(DEFAULT_MOVER_SOURCES.A1!.read);
    const sources = { A1: { ...DEFAULT_MOVER_SOURCES.A1!, read } as MoverSource };
    for (const d of DAYS.slice(10, 22)) await runMovers(db, at(d), { io, sources });
    // the plan was frozen for all six rules, at the hash of the committed file
    const shas = (await db.execute("SELECT DISTINCT sha FROM research_prereg")).rows;
    expect(shas.map((r) => String(r.sha))).toEqual([sha256Hex(planText)]);
    expect(await n(db, "SELECT COUNT(*) n FROM research_prereg")).toBe(6);
    // night DAYS[21] (the last of the loop): cutoff DAYS[17]: 39 matured resumes
    expect(Number((await meter(db, "movers_a1", DAYS[21]!)).n)).toBe(39);
    expect(String((await meter(db, "movers_a1", DAYS[21]!)).status)).toBe("collecting");
    expect(read).not.toHaveBeenCalled();
    expect(await n(db, "SELECT COUNT(*) n FROM holdout_look")).toBe(0);
    // night DAYS[22]: cutoff DAYS[18]: 40
    const out = await runMovers(db, at(DAYS[22]!), { io, sources });
    expect(out.find((x) => x.rule === "A1")).toMatchObject({
      n: 40,
      status: "looked",
      looked: true,
    });
    expect(read).toHaveBeenCalledTimes(1);
    const look = (await db.execute("SELECT * FROM holdout_look")).rows;
    expect(look).toHaveLength(1);
    expect(String(look[0]!.lineage)).toBe("movers_a1");
    expect(String(look[0]!.verdict)).toBe("PASS");
    const res = (await db.execute("SELECT n_setups, stats_json FROM research_result")).rows[0]!;
    expect(Number(res.n_setups)).toBe(40);
    expect(JSON.parse(String(res.stats_json))).toMatchObject({ rule: "A1", n: 40 });
    // a later night writes no second look and no refusal, and reads nothing again
    await runMovers(db, at(DAYS[23]!), { io, sources });
    expect(read).toHaveBeenCalledTimes(1);
    expect(await n(db, "SELECT COUNT(*) n FROM holdout_look")).toBe(1);
    expect(await n(db, "SELECT COUNT(*) n FROM holdout_look_refusal")).toBe(0);
    expect(String((await meter(db, "movers_a1", DAYS[23]!)).status)).toBe("looked");
    // a direct second look is refused and audited, and never computes
    const compute = vi.fn();
    const again = await takeLook(db, {
      lineage: "movers_a1",
      market: M,
      sha: sha256Hex(planText),
      caller: "test",
      now: `${DAYS[24]}T12:00:00Z`,
      compute,
    });
    expect(again).toEqual({ status: "refused", reason: "already_looked" });
    expect(compute).not.toHaveBeenCalled();
    expect(await n(db, "SELECT COUNT(*) n FROM holdout_look_refusal")).toBe(1);
  });

  it("rising prices after a resume are a NULL", async () => {
    const db = await freshDb("main");
    await plant(db, 0.03);
    for (const d of DAYS.slice(21, 23)) await runMovers(db, at(d), { io });
    const look = (await db.execute("SELECT verdict FROM holdout_look")).rows;
    expect(look.map((r) => String(r.verdict))).toEqual(["NULL"]);
  });

  it("missing prices leave events out: below n nothing is written and the look waits for new events", async () => {
    const db = await freshDb("main");
    // a gap in the data: ten events have no bars
    await plant(db, -0.03, 10);
    for (const d of DAYS.slice(21, 25)) await runMovers(db, at(d), { io });
    expect(await n(db, "SELECT COUNT(*) n FROM holdout_look")).toBe(0);
    expect(await n(db, "SELECT COUNT(*) n FROM research_result")).toBe(0);
    expect(String((await meter(db, "movers_a1", DAYS[24]!)).status)).toBe("met");
  });
});

describe("A3 volume creep and A8 sector composite on a database", () => {
  it("A3 counts the default grid point only; 99 gives no look, 100 gives one; PASS on rising prices", async () => {
    const db = await freshDb("main");
    await calendar(db, DAYS);
    await flatIndex(db, DAYS);
    const codes = ["C0", "C1", "C2", "C3", "C4"];
    for (const [i, c] of codes.entries())
      await bars(db, c, DAYS, (k) => ({ o: 100, c: 100 * 1.003 ** k * (1 + noise(i + k) / 10) }));
    const flags: { d: string; code: string; key: string; angle: string }[] = [];
    for (let i = 0; i < 100; i += 1)
      flags.push({
        d: DAYS[i < 99 ? Math.floor(i / 5) : 20]!,
        code: codes[i % 5]!,
        key: CREEP_GRID_KEY,
        angle: CREEP_ANGLE_ID,
      });
    // other grid point and another angle are not counted
    flags.push({ d: DAYS[3]!, code: "C0", key: "ar_min_pct=2,vr_min=2", angle: CREEP_ANGLE_ID });
    flags.push({ d: DAYS[3]!, code: "C1", key: CREEP_GRID_KEY, angle: "A-D2-01" });
    // the 100 above hold 99 distinct (day, code) pairs for the first 99 and one more on DAYS[20]; make them unique
    const seen = new Set<string>();
    for (const f of flags) {
      if (seen.has(`${f.d}|${f.code}|${f.key}|${f.angle}`)) continue;
      seen.add(`${f.d}|${f.code}|${f.key}|${f.angle}`);
      await db.execute({
        sql: `INSERT INTO angle_forward_flag (market, d, code, angle_id, grid_key, angle_version, known_at)
              VALUES (?, ?, ?, ?, ?, 2, ?)`,
        args: [M, f.d, f.code, f.angle, f.key, `${f.d}T10:00:00Z`],
      });
    }
    const read = vi.fn(DEFAULT_MOVER_SOURCES.A3!.read);
    const sources = { A3: { ...DEFAULT_MOVER_SOURCES.A3!, read } as MoverSource };
    // cutoff = the 11th latest session: night DAYS[30] -> DAYS[20]; the day before -> DAYS[19]
    for (const d of DAYS.slice(25, 30)) await runMovers(db, at(d), { io, sources });
    const m = await meter(db, "movers_a3", DAYS[29]!);
    expect(Number(m.n)).toBe(99);
    expect(String(m.status)).toBe("collecting");
    expect(read).not.toHaveBeenCalled();
    await runMovers(db, at(DAYS[30]!), { io, sources });
    expect(Number((await meter(db, "movers_a3", DAYS[30]!)).n)).toBe(100);
    expect(read).toHaveBeenCalledTimes(1);
    const look = (await db.execute("SELECT lineage, verdict FROM holdout_look")).rows;
    expect(look.map((r) => `${r.lineage}:${r.verdict}`)).toEqual(["movers_a3:PASS"]);
  });

  it("A8 counts the smaller side; 59 gives no look, 60 gives one", async () => {
    const db = await freshDb("main");
    await calendar(db, DAYS);
    const cand = async (i: number, sector: number, x: number): Promise<void> => {
      await db.execute({
        sql: `INSERT INTO intraday_candidate (market, session_d, code, found_slot, found_at, item_source, item_ann_id,
                item_category, materiality, polarity, move_ppm, sector_adj_ppm, gates_json, excess_open_1_ppm)
              VALUES (?, ?, ?, 'scan-1030', ?, 'asx', ?, 'earnings', 2, 'positive', 0, ?, '[]', ?)`,
        args: [
          M,
          DAYS[i % 30]!,
          `S${i}-${sector > 0 ? "u" : "d"}`,
          `${DAYS[i % 30]}T00:30:00Z`,
          `a${i}`,
          sector,
          x,
        ],
      });
    };
    for (let i = 0; i < 60; i += 1) await cand(i, 5000, 20000 + Math.round(noise(i) * 1e6));
    for (let i = 0; i < 59; i += 1) await cand(i, -5000, -5000 + Math.round(noise(i) * 1e6));
    const read = vi.fn(DEFAULT_MOVER_SOURCES.A8!.read);
    const sources = { A8: { ...DEFAULT_MOVER_SOURCES.A8!, read } as MoverSource };
    await runMovers(db, at(DAYS[40]!), { io, sources });
    expect(Number((await meter(db, "movers_a8", DAYS[40]!)).n)).toBe(59);
    expect(read).not.toHaveBeenCalled();
    await cand(59, -5000, -5000);
    await runMovers(db, at(DAYS[41]!), { io, sources });
    expect(read).toHaveBeenCalledTimes(1);
    const look = (await db.execute("SELECT lineage, verdict FROM holdout_look")).rows;
    expect(look.map((r) => `${r.lineage}:${r.verdict}`)).toEqual(["movers_a8:PASS"]);
  });
});

describe("rules without a stored forward record, and an unreadable plan", () => {
  it("A2, A4 and A5 are blocked with n 0 and never read; their plans are frozen", async () => {
    const db = await freshDb("main");
    await calendar(db, DAYS);
    const out = await runMovers(db, at(DAYS[30]!), { io });
    for (const id of ["A2", "A4", "A5"] as const)
      expect(
        out.find((x) => x.rule === id),
        id,
      ).toMatchObject({ n: 0, status: "blocked" });
    for (const id of ["A1", "A3", "A8"] as const)
      expect(out.find((x) => x.rule === id)!.status, id).toBe("collecting");
    expect(await n(db, "SELECT COUNT(*) n FROM research_prereg WHERE item = 'CXA-014'")).toBe(6);
    expect(await n(db, "SELECT COUNT(*) n FROM holdout_look")).toBe(0);
  });

  it("a plan that cannot be read freezes nothing, blocks every meter and takes no look", async () => {
    const db = await freshDb("main");
    const out = await runMovers(db, at(DAYS[30]!), { io: { read: () => null } });
    expect(out.every((x) => x.status === "blocked")).toBe(true);
    expect(await n(db, "SELECT COUNT(*) n FROM research_prereg")).toBe(0);
  });

  it("a changed plan is refused: the first plan stands and no look is taken", async () => {
    const db = await freshDb("main");
    await runMovers(db, at(DAYS[30]!), { io });
    const changed = JSON.stringify({ ...JSON.parse(planText), replicates: 10 });
    const out = await runMovers(db, at(DAYS[31]!), { io: { read: () => changed } });
    expect(out.every((x) => x.status === "blocked")).toBe(true);
    expect(await n(db, "SELECT COUNT(*) n FROM research_prereg")).toBe(6);
    expect(
      Number((await db.execute("SELECT COUNT(*) n FROM app_log WHERE level = 'warn'")).rows[0]!.n),
    ).toBeGreaterThan(0);
  });
});
