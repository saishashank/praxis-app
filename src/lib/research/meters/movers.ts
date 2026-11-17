// The mover-rule meters and their one look each (M23 M3; CXA-014, D-1625, D-1721). Each night and enabled market: (1) the plan
// of the six rules is frozen through the registry gate before anything is counted; (2) per rule one `research_meter` row: the
// matured events counted from dates alone (a new count is added to the last meter row, one keyed range per night, D-1641),
// status `collecting` below the rule's n, `met` at or above it, `looked` once its look is on file, `blocked` when the rule has no
// stored forward record (A2, A4, A5: D-1721) or its plan could not be frozen; (3) on the night the count first reaches n, the
// rule's one look through `takeLook`: the outcomes are read inside the computation, after the registry has checked that no look
// is on file and the plan is frozen, and a computation that finds too few complete events writes nothing, so the look waits.
// It reads the forward tables and the daily bars, writes only research_prereg, research_meter, holdout_look, research_result,
// holdout_look_refusal and app_log, and a PASS changes no rule, gate or status (CTX-053 stays a later reviewed step).
import type { Client } from "@libsql/client";
import type { ResearchNightOptions } from "../night";
import {
  CREEP_ANGLE_ID,
  CREEP_GRID_KEY,
  MOVERS_PLAN_PATH,
  MOVER_RULES,
  evaluateMover,
  moverStats,
  type MoverId,
  type MoverObs,
  type MoverRule,
} from "../lineages/movers";
import { lineageName } from "../names";
import { preregister, takeLook, type LookComputed } from "../registry";
import { diskIo, type LedgerIo } from "../steps/lookSync";
import {
  barsFrom,
  indexFrom,
  lookedLineages,
  num,
  previousMeter,
  sessionBack,
  str,
  writeMeter,
  type MeterStatus,
} from "./common";

const PPM = 1_000_000; // threshold-ok: parts per million
const MAX_EVENTS = 5000; // threshold-ok: a bound on the events read at the one look of a rule
const LOG_MAX = 500; // threshold-ok: an app_log line is cut at 500 characters

/** Where a rule's events come from. `read` is called only inside the one look, after the registry's checks. */
export type MoverSource = {
  /** The matured events counted from dates alone: `prev` is last night's meter row, the count is added to it. */
  meterN(db: Client, market: string, d: string, rule: MoverRule, prev: Prev): Promise<number>;
  /** The matured events with their outcomes. */
  read(db: Client, market: string, d: string, rule: MoverRule): Promise<MoverObs[]>;
};

type Prev = { d: string; n: number; status: string } | null;

export type MoversDeps = {
  readonly io?: LedgerIo;
  /** Replaces or adds a rule's source (a rule without one is `blocked`). */
  readonly sources?: Partial<Record<MoverId, MoverSource>>;
};

export type MoverOutcome = {
  readonly rule: MoverId;
  readonly n: number;
  readonly status: MeterStatus;
  readonly looked: boolean;
};

/** A1: halts of a watch with expected sign zero or negative that have resumed (one event per code and halt). */
const haltResumeSource: MoverSource = {
  async meterN(db, market, d, rule, prev) {
    const cut = await sessionBack(db, market, d, rule.horizon);
    if (cut === null) return prev?.n ?? 0;
    const prevCut = prev === null ? null : await sessionBack(db, market, prev.d, rule.horizon);
    // rows-ok: one aggregate over the halt watches that resumed in (previous cutoff, cutoff]; halts are a few hundred rows a year
    const r = await db.execute({
      sql:
        "SELECT COUNT(*) AS n FROM (SELECT code, since_d FROM halt_watch WHERE market = ? AND status = 'resumed' " +
        "AND expected_sign <= 0 AND resume_d > ? AND resume_d <= ? GROUP BY code, since_d)",
      args: [market, prevCut ?? "", cut],
    });
    return (prev?.n ?? 0) + num(r.rows[0]?.n ?? 0);
  },
  async read(db, market, d, rule) {
    const cut = await sessionBack(db, market, d, rule.horizon);
    if (cut === null) return [];
    // rows-ok: the matured resumed halts, one row per code and halt, LIMIT 5000
    const ev = await db.execute({
      sql:
        "SELECT code, MIN(resume_d) AS r FROM halt_watch WHERE market = ? AND status = 'resumed' " +
        "AND expected_sign <= 0 AND resume_d <= ? GROUP BY code, since_d ORDER BY r, code LIMIT ?",
      args: [market, cut, MAX_EVENTS],
    });
    if (ev.rows.length === 0) return [];
    const idx = await indexFrom(db, market, str(ev.rows[0]!.r), d);
    const out: MoverObs[] = [];
    for (const e of ev.rows) {
      const r0 = str(e.r);
      const bars = await barsFrom(db, market, str(e.code), r0, rule.horizon);
      if (bars.length < rule.horizon || bars[0]!.d !== r0) continue;
      const last = bars[bars.length - 1]!;
      const i0 = idx.get(r0);
      const i1 = idx.get(last.d);
      if (i0 === undefined || i1 === undefined || !(i0.o > 0) || !(bars[0]!.o > 0)) continue;
      const v = last.c / bars[0]!.o - 1 - (i1.c / i0.o - 1);
      if (Number.isFinite(v)) out.push({ session: r0, value: Math.round(v * PPM) });
    }
    return out;
  },
};

/** A3: code-days the volume-creep angle flagged at its default grid point. */
const creepSource: MoverSource = {
  async meterN(db, market, d, rule, prev) {
    const cut = await sessionBack(db, market, d, rule.horizon + 1);
    if (cut === null) return prev?.n ?? 0;
    const prevCut = prev === null ? null : await sessionBack(db, market, prev.d, rule.horizon + 1);
    // rows-ok: one aggregate over the flags of (previous cutoff, cutoff] by primary key range (market, d); flags are sparse by design
    const r = await db.execute({
      sql:
        "SELECT COUNT(*) AS n FROM (SELECT d, code FROM angle_forward_flag WHERE market = ? AND d > ? AND d <= ? " +
        "AND angle_id = ? AND grid_key = ? GROUP BY d, code)",
      args: [market, prevCut ?? "", cut, CREEP_ANGLE_ID, CREEP_GRID_KEY],
    });
    return (prev?.n ?? 0) + num(r.rows[0]?.n ?? 0);
  },
  async read(db, market, d, rule) {
    const cut = await sessionBack(db, market, d, rule.horizon + 1);
    if (cut === null) return [];
    // rows-ok: the matured flagged code-days by primary key range (market, d), LIMIT 5000
    const ev = await db.execute({
      sql:
        "SELECT d, code FROM angle_forward_flag WHERE market = ? AND d <= ? AND angle_id = ? AND grid_key = ? " +
        "GROUP BY d, code ORDER BY d, code LIMIT ?",
      args: [market, cut, CREEP_ANGLE_ID, CREEP_GRID_KEY, MAX_EVENTS],
    });
    if (ev.rows.length === 0) return [];
    const idx = await indexFrom(db, market, str(ev.rows[0]!.d), d);
    const out: MoverObs[] = [];
    for (const e of ev.rows) {
      const f = str(e.d);
      const bars = await barsFrom(db, market, str(e.code), f, rule.horizon + 1);
      if (bars.length < rule.horizon + 1 || bars[0]!.d !== f) continue;
      const last = bars[bars.length - 1]!;
      const i0 = idx.get(f);
      const i1 = idx.get(last.d);
      if (i0 === undefined || i1 === undefined || !(i0.c > 0) || !(bars[0]!.c > 0)) continue;
      const v = last.c / bars[0]!.c - 1 - (i1.c / i0.c - 1);
      if (Number.isFinite(v)) out.push({ session: f, value: Math.round(v * PPM) });
    }
    return out;
  },
};

/** A8: intraday candidates with a sector-adjusted move, split by the sign of that move; n is the smaller side. */
const sectorCount = async (db: Client, market: string): Promise<number> => {
  // rows-ok: one aggregate over the market's measured candidates (a few rows a session; none is read after the look)
  const r = await db.execute({
    sql:
      "SELECT SUM(CASE WHEN sector_adj_ppm > 0 THEN 1 ELSE 0 END) AS up, " +
      "SUM(CASE WHEN sector_adj_ppm <= 0 THEN 1 ELSE 0 END) AS down FROM intraday_candidate " +
      "WHERE market = ? AND sector_adj_ppm IS NOT NULL AND excess_open_1_ppm IS NOT NULL",
    args: [market],
  });
  return Math.min(num(r.rows[0]?.up ?? 0), num(r.rows[0]?.down ?? 0));
};

const sectorSource: MoverSource = {
  async meterN(db, market) {
    return sectorCount(db, market);
  },
  async read(db, market) {
    // rows-ok: the measured candidates with a sector-adjusted move by primary key range (market, session_d), LIMIT 5000
    const r = await db.execute({
      sql:
        "SELECT session_d, sector_adj_ppm, excess_open_1_ppm FROM intraday_candidate WHERE market = ? " +
        "AND sector_adj_ppm IS NOT NULL AND excess_open_1_ppm IS NOT NULL ORDER BY session_d, code LIMIT ?",
      args: [market, MAX_EVENTS],
    });
    return r.rows.map((x): MoverObs => ({
      session: str(x.session_d),
      value: num(x.excess_open_1_ppm),
      side: num(x.sector_adj_ppm) > 0 ? 1 : 0,
    }));
  },
};

/** The sources built here; A2, A4 and A5 have none (their events are not stored as a forward record, D-1721). */
export const DEFAULT_MOVER_SOURCES: Partial<Record<MoverId, MoverSource>> = {
  A1: haltResumeSource,
  A3: creepSource,
  A8: sectorSource,
};

async function ownerLine(db: Client, now: string, message: string): Promise<void> {
  // rows-ok: one plain line when a rule's one look is taken
  await db.execute({
    sql: "INSERT INTO app_log (at, level, source, message, run_id) VALUES (?, 'info', ?, ?, NULL)",
    args: [now, "research", message.slice(0, LOG_MAX)],
  });
}

/** One night for one market. Exported for the tests; the meters step calls it. */
export async function runMovers(
  db: Client,
  o: ResearchNightOptions,
  deps: MoversDeps = {},
): Promise<MoverOutcome[]> {
  const io = deps.io ?? diskIo;
  const sources = { ...DEFAULT_MOVER_SOURCES, ...deps.sources };

  // 1. Freeze the plan for every rule, before any count is taken. An unreadable plan freezes nothing and takes no look.
  const planText = io.read(MOVERS_PLAN_PATH)?.replace(/\r\n/g, "\n") ?? null;
  const shas = new Map<string, string>();
  let planOk = planText !== null;
  if (planText !== null) {
    for (const rule of MOVER_RULES) {
      const r = await preregister(db, {
        lineage: rule.lineage,
        market: o.market,
        item: "CXA-014",
        frozen: planText,
        now: o.now,
      });
      if (r.status === "refused") planOk = false;
      shas.set(rule.lineage, r.sha);
    }
  }
  const done = planOk
    ? await lookedLineages(
        db,
        o.market,
        MOVER_RULES.map((r) => r.lineage),
      )
    : new Set<string>();

  const out: MoverOutcome[] = [];
  for (const rule of MOVER_RULES) {
    const src = sources[rule.id];
    const prev = await previousMeter(db, o.market, rule.lineage, o.d);
    const base = { market: o.market, lineage: rule.lineage, d: o.d, target: rule.n, now: o.now };
    if (!planOk || src === undefined) {
      await writeMeter(db, { ...base, n: 0, status: "blocked", projectedD: null });
      out.push({ rule: rule.id, n: 0, status: "blocked", looked: false });
      continue;
    }
    if (done.has(rule.lineage)) {
      const n = Math.max(prev?.n ?? 0, rule.n);
      await writeMeter(db, { ...base, n, status: "looked", projectedD: null });
      out.push({ rule: rule.id, n, status: "looked", looked: false });
      continue;
    }
    // 2. The count, from dates alone; no outcome is read below the rule's n.
    const n = await src.meterN(db, o.market, o.d, rule, prev);
    let status: MeterStatus = n >= rule.n ? "met" : "collecting";
    let looked = false;
    // 3. At or above n, the one look, once per growth of the count (a night with no new events reads nothing again).
    const attempted = prev !== null && prev.status === "met" && prev.n === n;
    if (status === "met" && !attempted) {
      const r = await takeLook(db, {
        lineage: rule.lineage,
        market: o.market,
        sha: shas.get(rule.lineage)!,
        caller: "movers",
        now: o.now,
        compute: async (): Promise<LookComputed> => {
          const res = evaluateMover(rule, await src.read(db, o.market, o.d, rule));
          if (res.status === "below_sample") return { status: "below_sample", reason: res.reason };
          return {
            verdict: res.verdict,
            nSetups: res.n,
            nBlocks: res.blocks,
            stats: moverStats(rule, res),
          };
        },
      });
      if (r.status === "looked") {
        looked = true;
        status = "looked";
        await ownerLine(
          db,
          o.now,
          `The test "${lineageName(rule.lineage)}" reached its sample and was run once.`,
        );
      }
    }
    await writeMeter(db, { ...base, n, status });
    out.push({ rule: rule.id, n, status, looked });
  }
  return out;
}
