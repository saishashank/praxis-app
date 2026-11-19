// M23 night step "shockStops" (docs/M23_design.md, D-1613; task T4, D-1638, D-1750 to D-1759): the CXA-011 SHOCK stop comparator.
// A shadow comparison: nothing here changes a stop, a rule, a gate, sizing, a book or the live behaviour. Each night and enabled
// market it (1) freezes the plan of the six family lineages through the registry gate before anything is counted; (2) records one
// `shock_stop_outcome` row for every Cortex would-have hold (live or shadow arm) that was filled, has closed, and saw a SHOCK
// session between its fill and its exit: the net of the hold as the app scores it and the net of the same hold with its stop
// raised after the first SHOCK session (the pair is computed once, by the app's own walker). The first row of a family in a quarter
// counts as one stop variant of that family under O-46, through the existing cap check; with the cap full nothing is recorded and
// the meter reads blocked until a quarter has room. (3) writes one `research_meter` row per family (the recorded holds against 30).
// (4) On the night a family's count first reaches 30 it takes its one look through `takeLook`; the paired differences are read only
// inside that computation, so below 30 no difference is formed. It reads the Cortex decisions and outcomes, the regime and the
// daily bars, writes only shock_stop_outcome, research_prereg, research_meter, holdout_look, research_result,
// holdout_look_refusal and app_log, and never throws past `runResearchNight`, which logs a failure and goes on.
import type { Client } from "@libsql/client";
import { loadHoldContext, loadHoldInputs, type HoldContext } from "@/lib/cortex/holdInputs";
import {
  VARIANT_QUARTER_CAP,
  quarterBounds,
  stopVariantsThisQuarter,
} from "@/lib/learning/challengerLifecycle";
import type { Family } from "@/lib/agents/schema";
import {
  SHOCK_FAMILIES,
  SHOCK_N,
  SHOCK_PLAN_PATH,
  evaluateShock,
  replayHold,
  shockLineage,
  shockStats,
  type ShockObs,
} from "../lineages/shockStops";
import {
  lookedLineages,
  num,
  previousMeter,
  sessionBack,
  str,
  writeMeter,
  type MeterStatus,
} from "../meters/common";
import { lineageName } from "../names";
import type { ResearchNightOptions, ResearchStep } from "../night";
import { preregister, takeLook, type LookComputed } from "../registry";
import { diskIo, type LedgerIo } from "./lookSync";

const LOOKBACK_SESSIONS = 260; // threshold-ok: D-1750 a hold older than a year is not followed (the longest hold plan is shorter)
const MAX_SHOCK_DAYS = 300; // threshold-ok: a bound on the SHOCK sessions read in the window
const MAX_HOLDS = 400; // threshold-ok: a bound on the closed holds read in a night
const MAX_NEW = 40; // threshold-ok: a bound on the holds recorded in one night
const MAX_ROWS = 5000; // threshold-ok: a bound on the recorded holds read at the one look of a family
const ORIGIN_MAX = 64; // threshold-ok: the origin column holds at most 64 characters
const LOG_MAX = 500; // threshold-ok: an app_log line is cut at 500 characters

export type ShockDeps = {
  readonly io?: LedgerIo;
  /** Replaces the count of the family's stop variants this quarter (tests only; the app reads the registered rule versions). */
  readonly variants?: (db: Client, market: string, family: string, d: string) => Promise<number>;
};

export type ShockOutcome = {
  readonly family: string;
  readonly n: number;
  readonly status: MeterStatus;
  readonly looked: boolean;
};

/** The origin of a recorded hold: its decision date, arm, code and book; the same text SQL builds in `NOT EXISTS` below. */
export const holdOrigin = (d: string, arm: string, code: string, bookId: string): string =>
  `${d}|${arm}|${code}|${bookId}`.slice(0, ORIGIN_MAX);

/** The first SHOCK session `s` with `fillD <= s < exitD`, from an ascending list; null when the hold saw none. */
export function firstShockSession(
  shocks: readonly string[],
  fillD: string,
  exitD: string,
): string | null {
  for (const s of shocks) {
    if (s >= exitD) return null;
    if (s >= fillD) return s;
  }
  return null;
}

async function ownerLine(
  db: Client,
  now: string,
  level: "info" | "warn",
  message: string,
): Promise<void> {
  // rows-ok: one plain line when a family's one look is taken, or when holds were left out (at most seven a night)
  await db.execute({
    sql: "INSERT INTO app_log (at, level, source, message, run_id) VALUES (?, ?, ?, ?, NULL)",
    args: [now, level, "research", message.slice(0, LOG_MAX)],
  });
}

async function storedCount(db: Client, market: string, family: string): Promise<number> {
  // rows-ok: the family's recorded holds by primary key prefix (market, family); a few dozen rows at most before the look
  const r = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM shock_stop_outcome WHERE market = ? AND family = ?",
    args: [market, family],
  });
  return num(r.rows[0]?.n ?? 0);
}

/** True when the family may record a hold tonight: it already holds a row of this quarter, or the quarter has a free stop variant. */
async function slotFree(
  db: Client,
  market: string,
  family: string,
  d: string,
  variants: ShockDeps["variants"],
): Promise<boolean> {
  const { start } = quarterBounds(d);
  // rows-ok: the family's recorded holds of this quarter by primary key prefix (market, family), LIMIT 1
  const mine = await db.execute({
    sql: "SELECT 1 FROM shock_stop_outcome WHERE market = ? AND family = ? AND created_at >= ? LIMIT 1",
    args: [market, family, start],
  });
  if (mine.rows.length > 0) return true;
  const used =
    variants !== undefined
      ? await variants(db, market, family, d)
      : await stopVariantsThisQuarter(db, market, family as Family, d);
  return used + 1 <= VARIANT_QUARTER_CAP; // threshold-ok: this comparator is the one more variant
}

type Hold = {
  readonly d: string;
  readonly bookId: string;
  readonly code: string;
  readonly arm: string;
  readonly family: string;
  readonly fillD: string;
  readonly exitD: string;
  readonly netMicro: bigint;
  readonly limitMicro: bigint;
  readonly qty: bigint;
  readonly ruleVersion: string | null;
};

/** The SHOCK sessions after `from` up to the night, ascending. */
async function shockSessions(
  db: Client,
  market: string,
  from: string,
  d: string,
): Promise<string[]> {
  // rows-ok: the stored daily regime of the window by primary key range (market, d), one row a session, LIMIT 300
  const r = await db.execute({
    sql: "SELECT d FROM regime_daily WHERE market = ? AND d > ? AND d <= ? AND state = 'SHOCK' GROUP BY d ORDER BY d LIMIT ?",
    args: [market, from, d, MAX_SHOCK_DAYS],
  });
  return r.rows.map((x) => str(x.d));
}

/** Closed, filled holds of the window that overlap a SHOCK session and are not recorded yet, oldest decision first. */
async function candidateHolds(
  db: Client,
  market: string,
  from: string,
  firstShock: string,
  lastShock: string,
): Promise<Hold[]> {
  // rows-ok: the market's outcomes of the window by primary key range (market, d), joined to their decision by primary key, LIMIT 400
  const r = await db.execute({
    sql:
      "SELECT o.d AS d, o.book_id AS book_id, o.code AS code, o.arm AS arm, c.family AS family, o.fill_d AS fill_d, " +
      "o.exit_d AS exit_d, o.net_micro AS net_micro, c.limit_micro AS limit_micro, c.qty AS qty, c.rule_version AS rule_version " +
      "FROM cortex_outcome o JOIN cortex_decision c ON c.market = o.market AND c.d = o.d AND c.book_id = o.book_id " +
      "AND c.code = o.code AND c.arm = o.arm " +
      "WHERE o.market = ? AND o.d >= ? AND o.fill_status = 'filled' AND o.exit_d IS NOT NULL AND o.net_micro IS NOT NULL " +
      "AND o.fill_d <= ? AND o.exit_d > ? AND c.family IN ('F1','F2','F3','F4','F5','F6') " +
      "AND c.limit_micro IS NOT NULL AND c.qty IS NOT NULL AND c.qty > 0 " +
      "AND NOT EXISTS (SELECT 1 FROM shock_stop_outcome x WHERE x.market = o.market AND x.family = c.family " +
      `AND x.origin = substr(o.d || '|' || o.arm || '|' || o.code || '|' || o.book_id, 1, ${ORIGIN_MAX})) ` +
      "ORDER BY o.d, o.book_id, o.code, o.arm LIMIT ?",
    args: [market, from, lastShock, firstShock, MAX_HOLDS],
  });
  return r.rows.map((x): Hold => ({
    d: str(x.d),
    bookId: str(x.book_id),
    code: str(x.code),
    arm: str(x.arm),
    family: str(x.family),
    fillD: str(x.fill_d),
    exitD: str(x.exit_d),
    netMicro: BigInt(x.net_micro as number | bigint),
    limitMicro: BigInt(x.limit_micro as number | bigint),
    qty: BigInt(x.qty as number | bigint),
    ruleVersion: x.rule_version === null ? null : str(x.rule_version),
  }));
}

/** Records tonight's closed SHOCK holds for the families that may still record. Returns the holds left out because they could not be compared. */
async function recordHolds(
  db: Client,
  o: ResearchNightOptions,
  open: ReadonlySet<string>,
  blocked: Set<string>,
  variants: ShockDeps["variants"],
): Promise<number> {
  if (open.size === 0) return 0;
  const from = (await sessionBack(db, o.market, o.d, LOOKBACK_SESSIONS)) ?? "";
  const shocks = await shockSessions(db, o.market, from, o.d);
  if (shocks.length === 0) return 0;
  const holds = await candidateHolds(db, o.market, from, shocks[0]!, shocks[shocks.length - 1]!);
  let ctx: HoldContext | null = null;
  let recorded = 0;
  let left = 0;
  const free = new Map<string, boolean>();
  for (const h of holds) {
    if (recorded >= MAX_NEW) break;
    if (!open.has(h.family)) continue;
    const s = firstShockSession(shocks, h.fillD, h.exitD);
    if (s === null) continue;
    let ok = free.get(h.family);
    if (ok === undefined) {
      ok = await slotFree(db, o.market, h.family, o.d, variants);
      free.set(h.family, ok);
      if (!ok) blocked.add(h.family);
    }
    if (!ok) continue;
    ctx ??= await loadHoldContext(db, o.market);
    const inputs = await loadHoldInputs(
      db,
      o.market,
      {
        d: h.d,
        bookId: h.bookId,
        code: h.code,
        family: h.family,
        limitMicro: h.limitMicro,
        qty: h.qty,
        ruleVersion: h.ruleVersion,
      },
      h.exitD,
      ctx,
    );
    const pair = inputs === null ? null : replayHold(inputs.input, inputs.history, s);
    // the recomputed base path must reproduce what the app stored for the hold, else the pair is not comparable
    if (pair === null || pair.base.exitD !== h.exitD || pair.base.netMicro !== h.netMicro) {
      left += 1;
      continue;
    }
    // rows-ok: one keyed insert per recorded hold (at most 40 a night; under 5 on a usual night, D-1641)
    const w = await db.execute({
      sql:
        "INSERT INTO shock_stop_outcome (market, family, origin, d_entry, d_shock, base_net_ppm, tight_net_ppm, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
      args: [
        o.market,
        h.family,
        holdOrigin(h.d, h.arm, h.code, h.bookId),
        h.fillD,
        s,
        pair.basePpm,
        pair.tightPpm,
        o.now,
      ],
    });
    recorded += w.rowsAffected;
  }
  return left;
}

/** The recorded holds of a family as the look reads them. Called only inside the look. */
async function readObs(db: Client, market: string, family: string): Promise<ShockObs[]> {
  // rows-ok: the family's recorded holds by primary key prefix (market, family), LIMIT 5000
  const r = await db.execute({
    sql:
      "SELECT d_shock, base_net_ppm, tight_net_ppm FROM shock_stop_outcome WHERE market = ? AND family = ? " +
      "ORDER BY origin LIMIT ?",
    args: [market, family, MAX_ROWS],
  });
  return r.rows.map((x): ShockObs => ({
    dShock: str(x.d_shock),
    basePpm: num(x.base_net_ppm),
    tightPpm: num(x.tight_net_ppm),
  }));
}

/** One night for one market. Exported for the tests; the step calls it. */
export async function runShockStops(
  db: Client,
  o: ResearchNightOptions,
  deps: ShockDeps = {},
): Promise<ShockOutcome[]> {
  const io = deps.io ?? diskIo;
  const lineages = SHOCK_FAMILIES.map(shockLineage);

  // 1. Freeze the plan for every family, before anything is counted. An unreadable plan freezes nothing and takes no look.
  const planText = io.read(SHOCK_PLAN_PATH)?.replace(/\r\n/g, "\n") ?? null;
  const shas = new Map<string, string>();
  let planOk = planText !== null;
  if (planText !== null) {
    for (const lineage of lineages) {
      const r = await preregister(db, {
        lineage,
        market: o.market,
        item: "CXA-011",
        frozen: planText,
        now: o.now,
      });
      if (r.status === "refused") planOk = false;
      shas.set(lineage, r.sha);
    }
  }
  const done = planOk ? await lookedLineages(db, o.market, lineages) : new Set<string>();

  // 2. Record the closed holds that saw a SHOCK session (a family with its look on file records no more).
  const open = new Set<string>(
    planOk ? SHOCK_FAMILIES.filter((f) => !done.has(shockLineage(f))) : [],
  );
  const blocked = new Set<string>();
  const left = await recordHolds(db, o, open, blocked, deps.variants);
  if (left > 0)
    await ownerLine(
      db,
      o.now,
      "info",
      "A hold that saw a market shock could not be compared with the stop rule and was left out.",
    );

  // 3. The meter and, at the floor, the one look of each family.
  const out: ShockOutcome[] = [];
  for (const family of SHOCK_FAMILIES) {
    const lineage = shockLineage(family);
    const prev = await previousMeter(db, o.market, lineage, o.d);
    const n = await storedCount(db, o.market, family);
    const base = { market: o.market, lineage, d: o.d, target: SHOCK_N, now: o.now };
    if (!planOk) {
      await writeMeter(db, { ...base, n, status: "blocked", projectedD: null });
      out.push({ family, n, status: "blocked", looked: false });
      continue;
    }
    if (done.has(lineage)) {
      await writeMeter(db, {
        ...base,
        n: Math.max(n, SHOCK_N),
        status: "looked",
        projectedD: null,
      });
      out.push({ family, n: Math.max(n, SHOCK_N), status: "looked", looked: false });
      continue;
    }
    // a family held back by a full variant cap says so; its count stays where it was
    let status: MeterStatus = n >= SHOCK_N ? "met" : blocked.has(family) ? "blocked" : "collecting";
    let looked = false;
    const attempted = prev !== null && prev.status === "met" && prev.n === n;
    if (status === "met" && !attempted) {
      const r = await takeLook(db, {
        lineage,
        market: o.market,
        sha: shas.get(lineage)!,
        caller: "shockStops",
        now: o.now,
        compute: async (): Promise<LookComputed> => {
          const res = evaluateShock(family, await readObs(db, o.market, family));
          if (res.status === "below_sample") return { status: "below_sample", reason: res.reason };
          return {
            verdict: res.verdict,
            nSetups: res.n,
            nBlocks: res.clusters,
            stats: shockStats(family, res),
          };
        },
      });
      if (r.status === "looked") {
        looked = true;
        status = "looked";
        await ownerLine(
          db,
          o.now,
          "info",
          `The test "${lineageName(lineage)}" reached its sample and was run once.`,
        );
      }
    }
    await writeMeter(db, { ...base, n, status });
    out.push({ family, n, status, looked });
  }
  return out;
}

export const shockStopsStep: ResearchStep = {
  name: "shockStops",
  plain: "comparing the two stop rules after a shock",
  async run(db, o) {
    await runShockStops(db, o);
  },
};
