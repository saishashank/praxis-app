// Evening Review section readers (M5 T9; docs/M5_design.md 2.6 and 4.6; EML-011/012/014/035/037,
// ARN-070/073/075/077). One bounded reader per section group. Every number comes from stored rows
// (LLM-034) and every reader is bounded to the review date D: a reader never falls back to
// yesterday's numbers (EML-035). The only cumulative inputs are the statistics of section 7
// (cumulative by definition, EML-012), read at D.
//
// The readers produce the fact types of the T4 renderer (`ReviewFacts` and its parts).
import type { Client } from "@libsql/client";
import { parseCohortParams } from "@/lib/arena/cohort";
import { terminalThresholds } from "@/lib/arena/terminal";
import { loadCalendar } from "@/lib/arena/closeBooks";
import { addDays, isTradingDay, type CalendarRow } from "@/lib/data/calendar";
import { parseOn } from "@/lib/data/controls";
import type {
  AgentSuccess,
  AlertFact,
  AttentionItem,
  ExecutionFact,
  HealthLine,
  NarrativeFacts,
  OrderFact,
  PickReviewFacts,
  StatRow,
} from "@/lib/email/templates/review";
import { money, pct, plural } from "@/lib/email/templates/format";
import type { EnvName } from "@/lib/email/templates/core";
import { melbourneDate } from "@/lib/email/keys";
import type { PicksParams } from "@/lib/agents/params";
import { readSection7a } from "@/lib/picks/section7a";
import { readNight } from "@/lib/steelman/store";
import { getMeters, usageEnvironment, worstMeter } from "@/lib/usage/meters";
import { HEALTH_COMPONENTS } from "@/lib/sentinel/schema";
import { learnLines, readLearnFacts, type LearnFacts } from "@/lib/learning/learnFacts";
import {
  NARRATIVE_METRIC,
  big,
  clampPct,
  microToCents,
  narrativeScope,
  runKeys,
  type Availability,
  type NarrativeKind,
} from "./facts";

type Db = Pick<Client, "execute">;

export type Ctx = {
  db: Client;
  market: string;
  d: string;
  env: EnvName;
  appUrl: string;
  /** Stamps the quota meter only; it never reaches a number of the trading sections. */
  now: Date;
  currency: string;
  mode: string;
  tradingDay: boolean;
  calendar: CalendarRow[];
};

const str = (v: unknown): string => String(v);
const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number => Number(v ?? 0); // money-float-ok: a count read from SQL

const MS_PER_DAY = 86_400_000;
const MS_PER_MINUTE = 60_000;
/** ARN-073: a "material move" is |abnormal return| >= 5 % (50,000 ppm). */
export const MATERIAL_MOVE_PPM = 50_000;
/** Cap on P2 rows listed in section 8 (P0 and P1 are always listed in full). */
const P2_LIST_CAP = 20;
const UNREAD_LOOKBACK = 10;
const NEXT_SESSION_SCAN_DAYS = 14;

export async function loadCtx(
  db: Client,
  o: { market: string; d: string; env: EnvName; appUrl: string; now: Date },
): Promise<Ctx> {
  const m = await db.execute({
    sql: "SELECT mode, currency FROM market WHERE code = ?",
    args: [o.market],
  });
  const calendar = await loadCalendar(db, o.market);
  return {
    db,
    market: o.market,
    d: o.d,
    env: o.env,
    appUrl: o.appUrl,
    now: o.now,
    currency: m.rows.length ? str(m.rows[0]!.currency) : "AUD",
    mode: m.rows.length ? str(m.rows[0]!.mode) : "off",
    tradingDay: isTradingDay(o.d, calendar),
    calendar,
  };
}

// ---- availability (the inputs the partial map looks at) -----------------------------------------

async function hasRun(db: Db, key: string): Promise<boolean> {
  const r = await db.execute({
    sql: "SELECT 1 FROM run_record WHERE concurrency_key = ? AND status IN ('success', 'degraded') LIMIT 1",
    args: [key],
  });
  return r.rows.length > 0;
}

export async function readAvailability(c: Ctx): Promise<Availability> {
  const marker = await c.db.execute({
    sql: "SELECT 1 FROM completion_marker WHERE market = ? AND d = ? AND kind IN ('data', 'non-trading') LIMIT 1",
    args: [c.market, c.d],
  });
  return {
    arenaActive: c.mode === "full",
    tradingDay: c.tradingDay,
    marker: marker.rows.length > 0,
    closeOk: await hasRun(c.db, runKeys.close(c.market, c.d)),
    signalsOk: await hasRun(c.db, runKeys.signals(c.market, c.d)),
    reviewOk: await hasRun(c.db, runKeys.review(c.market, c.d)),
    learnOk: await hasRun(c.db, runKeys.learn(c.market, c.d)),
  };
}

// ---- sections 1 and 3: executions ---------------------------------------------------------------

type CohortNav = {
  cohortId: string;
  executionId: string;
  family: string;
  variant: string;
  paramsJson: string;
  sleeveJson: string | null;
  startD: string;
  terminalKind: string | null;
  terminalD: string | null;
  seed: bigint;
  navD: string;
  nav: bigint;
  liq: bigint;
  positions: bigint;
  sleeveUnreal: bigint;
};

/**
 * One cohort per live execution E01-E12: the latest cohort with a NAV row on or before D. On a
 * trading day that row must be D's own (a cohort without one is skipped, never carried).
 */
async function cohortNavs(c: Ctx, carried: boolean): Promise<CohortNav[]> {
  const r = await c.db.execute({
    sql: `SELECT co.id AS cohort_id, co.execution_id, e.family, e.variant, co.params_json, co.sleeve_json,
            co.start_d, co.terminal_kind, co.terminal_d, co.seed_micro, n.d AS nav_d, n.nav_micro,
            n.liq_nav_micro, n.positions_micro, n.sleeve_unreal_micro
          FROM cohort co
          JOIN execution e ON e.id = co.execution_id AND e.kind = 'E' AND e.market = ?
          JOIN nav_daily n ON n.cohort_id = co.id
            AND n.d = (SELECT MAX(d) FROM nav_daily WHERE cohort_id = co.id AND d <= ?)
          WHERE co.start_d <= ?
          ORDER BY co.execution_id, co.start_d DESC, co.id`,
    args: [c.market, c.d, c.d],
  });
  const seen = new Set<string>();
  const out: CohortNav[] = [];
  for (const x of r.rows) {
    const navD = str(x.nav_d);
    if (!carried && navD !== c.d) continue;
    const execId = str(x.execution_id);
    if (seen.has(execId)) continue;
    seen.add(execId);
    out.push({
      cohortId: str(x.cohort_id),
      executionId: execId,
      family: str(x.family),
      variant: str(x.variant),
      paramsJson: str(x.params_json),
      sleeveJson: text(x.sleeve_json),
      startD: str(x.start_d),
      terminalKind: text(x.terminal_kind),
      terminalD: text(x.terminal_d),
      seed: big(x.seed_micro),
      navD,
      nav: big(x.nav_micro),
      liq: big(x.liq_nav_micro),
      positions: big(x.positions_micro),
      sleeveUnreal: big(x.sleeve_unreal_micro),
    });
  }
  return out;
}

const sum = async (db: Db, sql: string, args: (string | number)[]): Promise<bigint> => {
  const r = await db.execute({ sql, args });
  return r.rows.length && r.rows[0]!.s !== null ? big(r.rows[0]!.s) : 0n;
};

async function executionFact(c: Ctx, x: CohortNav, carried: boolean): Promise<ExecutionFact> {
  const prev = await c.db.execute({
    sql: "SELECT nav_micro FROM nav_daily WHERE cohort_id = ? AND d < ? ORDER BY d DESC LIMIT 1",
    args: [x.cohortId, x.navD],
  });
  const prevNav = prev.rows.length ? big(prev.rows[0]!.nav_micro) : x.seed;
  const dayPl = carried ? 0n : x.nav - prevNav;

  const target = terminalThresholds(parseCohortParams(x.paramsJson).terminal).targetMicro;
  const gap = target - x.seed;
  const progressPct = clampPct(x.liq - x.seed, gap);
  const distance = target > x.liq ? target - x.liq : 0n;

  const costs = await sum(
    c.db,
    "SELECT SUM(brokerage_micro) AS s FROM fill WHERE cohort_id = ? AND d <= ?",
    [x.cohortId, x.navD],
  );
  const basis = await sum(
    c.db,
    `SELECT SUM(f.value_micro) AS s FROM trade t JOIN fill f ON f.id = t.entry_fill_id
     WHERE t.cohort_id = ? AND t.exit_type IS NULL AND f.d <= ?`,
    [x.cohortId, x.navD],
  );
  const unrealised = x.positions - basis + x.sleeveUnreal;
  const realised = x.nav - x.seed - unrealised + costs;

  let sleeve: ExecutionFact["sleeve"] = "none";
  let sleevePl = 0n;
  if (x.sleeveJson !== null) {
    const st = await c.db.execute({
      sql: "SELECT state FROM sleeve_state WHERE cohort_id = ? AND d <= ? ORDER BY seq DESC LIMIT 1",
      args: [x.cohortId, x.navD],
    });
    sleeve = st.rows.length && str(st.rows[0]!.state) === "locked" ? "locked" : "unlocked";
    const closed = await sum(
      c.db,
      `SELECT SUM(price_pl_micro - financing_micro - costs_micro) AS s FROM sleeve_trade
       WHERE cohort_id = ? AND shadow = 0 AND close_d IS NOT NULL AND close_d <= ?`,
      [x.cohortId, x.navD],
    );
    sleevePl = closed + x.sleeveUnreal;
  }
  const terminalToday = x.terminalD === c.d && x.terminalKind !== null;
  const fact: ExecutionFact = {
    id: x.executionId,
    label: `${x.family}-${x.variant}`,
    currency: c.currency,
    navCents: microToCents(x.nav),
    dayPlCents: microToCents(dayPl),
    progressPct,
    distanceToTargetCents: microToCents(distance),
    realisedCents: microToCents(realised),
    unrealisedCents: microToCents(unrealised),
    costsCents: microToCents(costs),
    sleevePlCents: microToCents(sleevePl),
    sleeve,
    path: `/executions/${x.executionId}`,
  };
  if (terminalToday) fact.terminal = x.terminalKind as NonNullable<ExecutionFact["terminal"]>;
  return fact;
}

/** Sections 1 and 3 inputs. `carried`: non-trading day, the latest NAV on or before D. */
export async function readExecutions(c: Ctx, carried: boolean): Promise<ExecutionFact[]> {
  const navs = await cohortNavs(c, carried);
  const out: ExecutionFact[] = [];
  for (const x of navs) out.push(await executionFact(c, x, carried));
  return out;
}

// ---- section 2: orders --------------------------------------------------------------------------

const EXIT_TEXT: Readonly<Record<string, string>> = {
  exit_cs: "Close-signal exit",
  exit_is: "Stop exit",
  sleeve_open: "Leverage sleeve opened",
  sleeve_close: "Leverage sleeve closed",
  entry: "Entry",
};

type CardJson = {
  thesis?: unknown;
  sizing?: { fill_price_micro?: unknown };
  cost?: { entry_brokerage_micro?: unknown };
};

/** Orders filled on D and orders created on D for the next session, with card links. */
export async function readOrders(c: Ctx): Promise<OrderFact[]> {
  const r = await c.db.execute({
    sql: `SELECT o.id, o.kind, o.side, o.code, o.qty, o.status, o.card_id, o.ref_stop_micro,
            o.decided_d, co.execution_id, f.d AS fill_d, f.fill_price_micro, f.brokerage_micro,
            dc.card_json
          FROM arena_order o
          JOIN cohort co ON co.id = o.cohort_id
          JOIN execution e ON e.id = co.execution_id AND e.kind = 'E' AND e.market = ?
          LEFT JOIN fill f ON f.order_id = o.id
          LEFT JOIN decision_card dc ON dc.id = o.card_id
          WHERE (f.d = ?) OR (o.decided_d = ? AND o.status <> 'cancelled' AND o.status <> 'rejected')
          ORDER BY co.execution_id, o.code, o.id`,
    args: [c.market, c.d, c.d],
  });
  const out: OrderFact[] = [];
  for (const x of r.rows) {
    const filledToday = x.fill_d !== null && str(x.fill_d) === c.d;
    const kind = str(x.kind);
    let card: CardJson = {};
    if (x.card_json !== null) {
      try {
        card = JSON.parse(str(x.card_json)) as CardJson;
      } catch {
        card = {};
      }
    }
    let price = filledToday && x.fill_price_micro !== null ? big(x.fill_price_micro) : 0n;
    let costs = filledToday && x.brokerage_micro !== null ? big(x.brokerage_micro) : 0n;
    if (!filledToday) {
      if (typeof card.sizing?.fill_price_micro === "string")
        price = big(card.sizing.fill_price_micro);
      if (typeof card.cost?.entry_brokerage_micro === "string") {
        costs = big(card.cost.entry_brokerage_micro);
      }
    }
    const reason =
      typeof card.thesis === "string" && card.thesis.length > 0
        ? card.thesis
        : (EXIT_TEXT[kind] ?? kind);
    const o: OrderFact = {
      executionId: str(x.execution_id),
      state: filledToday ? "filled" : "created",
      side: str(x.side) as OrderFact["side"],
      code: str(x.code),
      qty: num(x.qty),
      priceCents: microToCents(price),
      costsCents: microToCents(costs),
      currency: c.currency,
      reason,
      cardPath:
        x.card_id !== null ? `/cards/${encodeURIComponent(str(x.card_id))}` : `/reviews/${c.d}`,
    };
    if (x.ref_stop_micro !== null) o.stopCents = microToCents(big(x.ref_stop_micro));
    out.push(o);
  }
  return out;
}

// ---- section 7: statistics ----------------------------------------------------------------------

export type Stats = { headline: string; rows: StatRow[]; agents: AgentSuccess[] };

const oneDecimal = (n: bigint, den: bigint): string => {
  // n/den with two decimals, exact integer arithmetic
  const neg = n < 0n;
  const a = (neg ? -n : n) * 100n;
  const q = (a + den / 2n) / den;
  const s = `${q / 100n}.${String(q % 100n).padStart(2, "0")}`;
  return neg ? `-${s}` : s;
};

type Pl = { pl: bigint };

async function closedTrades(c: Ctx): Promise<Pl[]> {
  const r = await c.db.execute({
    sql: `SELECT ef.value_micro AS ev, ef.brokerage_micro AS eb, xf.value_micro AS xv, xf.brokerage_micro AS xb
          FROM trade t
          JOIN cohort co ON co.id = t.cohort_id
          JOIN execution e ON e.id = co.execution_id AND e.kind = 'E' AND e.market = ?
          JOIN fill ef ON ef.id = t.entry_fill_id
          JOIN fill xf ON xf.id = t.exit_fill_id
          WHERE xf.d <= ?
          ORDER BY t.id`,
    args: [c.market, c.d],
  });
  return r.rows.map((x) => ({ pl: big(x.xv) - big(x.xb) - big(x.ev) - big(x.eb) }));
}

/** ARN-073 Sentinel precision: alerts followed by a material move, from the stored event rows. */
export async function sentinelScore(
  db: Db,
  market: string,
  d: string,
): Promise<{
  n: number;
  hits: number;
  falseAlarms: number;
  days: number;
  medianLatencyMin: number | null;
  changed: number;
}> {
  const r = await db.execute({
    sql: `SELECT a.alert_key, a.detected_at, a.published_at, a.facts_json, ev.ar_ppm
          FROM alert a
          LEFT JOIN event ev ON ev.market = a.market
            AND ev.source = json_extract(a.facts_json, '$.source')
            AND ev.ann_id = json_extract(a.facts_json, '$.annId')
          WHERE a.market = ? AND a.kind = 'announcement' AND a.detected_at < ?
          ORDER BY a.alert_key`,
    args: [market, `${addDays(d, 2)}T00:00:00.000Z`],
  });
  let n = 0;
  let hits = 0;
  const days = new Set<string>();
  const lat: number[] = [];
  for (const x of r.rows) {
    const day = melbourneDate(new Date(str(x.detected_at)));
    if (day > d) continue;
    if (x.published_at !== null) {
      const ms = Date.parse(str(x.detected_at)) - Date.parse(str(x.published_at));
      if (Number.isFinite(ms) && ms >= 0) lat.push(Math.round(ms / MS_PER_MINUTE));
    }
    if (x.ar_ppm === null) continue; // no measured move yet: not scored (ARN-073 needs the result)
    n += 1;
    if (Math.abs(num(x.ar_ppm)) >= MATERIAL_MOVE_PPM) hits += 1;
    else days.add(day);
  }
  lat.sort((a, b) => a - b);
  const mid = Math.floor(lat.length / 2);
  const median =
    lat.length === 0
      ? null
      : lat.length % 2 === 1
        ? lat[mid]!
        : Math.round((lat[mid - 1]! + lat[mid]!) / 2);
  const ch = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM preopen_result WHERE market = ? AND outcome = 'cancel' AND d <= ?`,
    args: [market, d],
  });
  return {
    n,
    hits,
    falseAlarms: n - hits,
    days: days.size,
    medianLatencyMin: median,
    changed: num(ch.rows[0]!.n),
  };
}

/** Cumulative statistics (section 7). `exact`: the batch 3 run of D itself, else the latest before. */
export async function readStats(c: Ctx, exact: boolean): Promise<Stats | null> {
  const trades = await closedTrades(c);
  const rows: StatRow[] = [];
  const n = trades.length;
  let headline = `No closed trades yet (to ${c.d}).`;
  if (n > 0) {
    const wins = trades.filter((t) => t.pl > 0n);
    const losses = trades.filter((t) => t.pl < 0n);
    const total = trades.reduce((a, t) => a + t.pl, 0n);
    const winSum = wins.reduce((a, t) => a + t.pl, 0n);
    const lossSum = losses.reduce((a, t) => a - t.pl, 0n);
    const winRate = Number((BigInt(wins.length) * 1000n) / BigInt(n)) / 10; // money-float-ok: percent display
    headline = `Cumulative to ${c.d}: ${n} closed ${plural(n, "trade")}, win rate ${pct(winRate, 1)}.`;
    rows.push({ label: "Closed trades", value: String(n), detail: "all live executions" });
    rows.push({ label: "Win rate", value: pct(winRate, 1), detail: `${wins.length} of ${n}` });
    rows.push({
      label: "Expectancy per trade",
      value: money(microToCents(total / BigInt(n)), c.currency, true),
      detail: "after costs",
    });
    if (wins.length > 0)
      rows.push({
        label: "Average win",
        value: money(microToCents(winSum / BigInt(wins.length)), c.currency, true),
      });
    if (losses.length > 0)
      rows.push({
        label: "Average loss",
        value: money(-microToCents(lossSum / BigInt(losses.length)), c.currency),
      });
    rows.push({
      label: "Profit factor",
      value: lossSum > 0n ? oneDecimal(winSum, lossSum) : "n/a",
      detail: lossSum > 0n ? "gross wins / gross losses" : "no losing trade yet",
    });
  }

  // batch 3 figures (CIFs with n and effective N versus the controls, zero-edge, labels)
  const run = await c.db.execute({
    sql: exact
      ? "SELECT run_id FROM replay_stat WHERE run_id = ? LIMIT 1"
      : "SELECT run_id FROM replay_stat WHERE run_id LIKE ? AND d <= ? ORDER BY d DESC, run_id DESC LIMIT 1",
    args: exact ? [runKeys.review(c.market, c.d)] : [`arena-3:${c.market}:%`, c.d],
  });
  if (run.rows.length) {
    const runId = str(run.rows[0]!.run_id);
    const hs = await c.db.execute({
      sql: "SELECT scope, value_json FROM replay_stat WHERE run_id = ? AND metric = 'headline' ORDER BY scope",
      args: [runId],
    });
    for (const h of hs.rows) {
      const v = JSON.parse(str(h.value_json)) as {
        comparator: string;
        cifTargetMinusC2: number | null;
        effectiveN: number;
        comparatorEffectiveN: number;
      };
      rows.push({
        label: `${str(h.scope)} vs ${v.comparator}`,
        value:
          v.cifTargetMinusC2 === null
            ? "not yet measured"
            : `${pct(v.cifTargetMinusC2 * 100, 1, true)} target CIF`, // money-float-ok: fraction to percent
        detail: `effective N ${v.effectiveN} vs ${v.comparatorEffectiveN}`,
      });
    }
    const ze = await c.db.execute({
      sql: "SELECT scope, value_json FROM replay_stat WHERE run_id = ? AND metric = 'zero_edge' AND scope LIKE ? ORDER BY scope",
      args: [runId, `${c.market}:%`],
    });
    for (const z of ze.rows) {
      const v = JSON.parse(str(z.value_json)) as {
        family: string;
        trials: number;
        probability: { target: number };
      };
      rows.push({
        label: `Zero-edge ${v.family}`,
        value: `${pct(v.probability.target * 100, 1)} reach target`, // money-float-ok: fraction to percent
        detail: `${v.trials} trials`,
      });
    }
  }
  const lb = await c.db.execute({
    sql: `SELECT l.execution_id, l.label, l.n, l.mde FROM label l
          WHERE l.d <= ? AND l.id = (SELECT l2.id FROM label l2 WHERE l2.execution_id = l.execution_id
            AND l2.d <= ? ORDER BY l2.d DESC, l2.id DESC LIMIT 1)
          ORDER BY l.execution_id`,
    args: [c.d, c.d],
  });
  for (const l of lb.rows) {
    rows.push({
      label: `${str(l.execution_id)} label`,
      value: str(l.label),
      detail: `n = ${str(l.n)}${l.mde === null ? "" : `, minimum detectable effect ${pct(num(l.mde) * 100, 1)}`}`, // money-float-ok: display
    });
  }

  const s = await sentinelScore(c.db, c.market, c.d);
  const agents: AgentSuccess[] = [
    {
      agent: "A1 Sentinel (ARN-073)",
      successPct: s.n === 0 ? null : Math.round((s.hits * 100) / s.n),
      n: s.n,
    },
    { agent: "Pattern agent (ARN-074)", successPct: null, n: 0 },
    { agent: "LLM roles (ARN-075)", successPct: null, n: 0 },
  ];
  if (rows.length === 0 && n === 0 && s.n === 0) return null;
  return { headline, rows, agents };
}

// ---- section 8: Sentinel recap ------------------------------------------------------------------

const timeFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Australia/Melbourne",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export type Recap = {
  alerts: AlertFact[];
  regimeNotice?: string;
  breakerHits: { execution: string; breaker: string; effect: string }[];
};

export async function readRecap(c: Ctx): Promise<Recap> {
  const r = await c.db.execute({
    sql: `SELECT alert_key, code, kind, tier, detected_at, facts_json, text_llm FROM alert
          WHERE market = ? AND detected_at >= ? AND detected_at < ?
          ORDER BY detected_at, alert_key`,
    args: [c.market, `${addDays(c.d, -1)}T00:00:00.000Z`, `${addDays(c.d, 2)}T00:00:00.000Z`],
  });
  const tierRank: Record<string, number> = { P0: 0, P1: 1, P2: 2 };
  const day = r.rows.filter((x) => melbourneDate(new Date(str(x.detected_at))) === c.d);
  day.sort(
    (a, b) =>
      tierRank[str(a.tier)]! - tierRank[str(b.tier)]! ||
      (str(a.detected_at) < str(b.detected_at)
        ? -1
        : str(a.detected_at) > str(b.detected_at)
          ? 1
          : 0),
  );
  const alerts: AlertFact[] = [];
  let p2 = 0;
  let regimeNotice: string | undefined;
  for (const x of day) {
    const f = JSON.parse(str(x.facts_json)) as {
      title?: string;
      type?: string;
      why?: string;
      url?: string | null;
      from?: string;
      to?: string;
      gated?: { id: string; effect: string }[];
    };
    const kind = str(x.kind);
    if (kind === "regime_shift" && f.from !== undefined && f.to !== undefined) {
      const gated = (f.gated ?? []).map((g) => `${g.id}: ${g.effect}`).join("; ");
      regimeNotice = `Market regime changed from ${f.from} to ${f.to}.${gated ? ` ${gated}.` : ""}`;
    }
    const tier = str(x.tier) as AlertFact["tier"];
    if (tier === "P2") {
      p2 += 1;
      if (p2 > P2_LIST_CAP) continue;
    }
    const a: AlertFact = {
      tier,
      code: x.code === null ? "-" : str(x.code),
      title: f.title ?? f.type ?? kind.replace(/_/g, " "),
      time: timeFmt.format(new Date(str(x.detected_at))),
      effect: f.why ?? "Recorded.",
    };
    if (typeof f.url === "string" && f.url.length > 0) a.url = f.url;
    alerts.push(a);
  }
  const br = await c.db.execute({
    sql: `SELECT t.subject_id, t.subject_kind, t.breaker_id, t.status, t.code, t.card_id, t.trigger_text,
            (SELECT p.outcome FROM preopen_result p WHERE p.order_id = t.subject_id AND p.d = t.d) AS po
          FROM thesis_breaker_eval t
          WHERE t.market = ? AND t.d = ? AND t.status IN ('red', 'amber')
          ORDER BY t.status DESC, t.subject_id, t.breaker_id, t.phase, t.seq`,
    args: [c.market, c.d],
  });
  const breakerHits = br.rows.map((x) => {
    const red = str(x.status) === "red";
    const order = str(x.subject_kind) === "order";
    return {
      execution: str(x.code),
      breaker: `${str(x.breaker_id)} (${str(x.status)})`,
      effect: red
        ? order
          ? x.po !== null && str(x.po) === "cancel"
            ? "pending buy cancelled at the pre-open re-check"
            : "pending buy flagged"
          : "held position exits at the next open"
        : "watch: within the amber band",
    };
  });
  const out: Recap = { alerts, breakerHits };
  if (regimeNotice !== undefined) out.regimeNotice = regimeNotice;
  return out;
}

// ---- M17 EML-042: pick alerts in sections 8 and 9 ---------------------------------------------------

const CLEAR_WORDS: Record<string, string> = {
  left_list: "left the list",
  below_stop: "fell under the stop",
  above_chase_cap: "ran above the limit",
  halted: "halted",
  expired: "expired",
  muted: "muted",
  filled: "filled in the book",
};

/**
 * Pick-alert facts of date D, or null when nothing happened (so a quiet day leaves the review facts,
 * and their hash, unchanged). `candidatesOn` = the Owner's `intraday_candidate_emails`.
 */
export async function readPickReview(
  c: Ctx,
  candidatesOn: boolean,
): Promise<PickReviewFacts | null> {
  const a = await c.db.execute({
    sql: `SELECT alert_id, state, clear_reason FROM pick_alert
          WHERE market = ? AND session_d = ? AND state <> 'armed' ORDER BY alert_id, seq`,
    args: [c.market, c.d],
  });
  const hits = new Set<string>();
  const clears = new Map<string, number>();
  for (const x of a.rows) {
    if (str(x.state) === "hit") hits.add(str(x.alert_id));
    else clears.set(str(x.clear_reason), (clears.get(str(x.clear_reason)) ?? 0) + 1);
  }
  const cand = await c.db.execute({
    sql: `SELECT code, item_source, item_category, decision_outcome FROM intraday_candidate
          WHERE market = ? AND session_d = ? ORDER BY found_at, code`,
    args: [c.market, c.d],
  });
  const carried = cand.rows.filter((x) => text(x.decision_outcome) === "night_pick").length;
  const mail = await c.db.execute({
    sql: `SELECT m.status, m.kind, m.at, COALESCE(a.code, m.alert_id) AS code FROM pick_alert_mail m
          LEFT JOIN pick_alert a ON a.alert_id = m.alert_id AND a.seq = 1
          WHERE m.status IN ('suppressed_cap','held','held_to_review') AND m.at >= ? AND m.at < ?
          ORDER BY m.id`,
    args: [`${addDays(c.d, -1)}T00:00:00.000Z`, `${addDays(c.d, 2)}T00:00:00.000Z`],
  });
  const held = mail.rows
    .filter((x) => melbourneDate(new Date(str(x.at))) === c.d)
    .map((x) => {
      const what = str(x.kind) === "pick_candidate" ? "intraday candidate" : "buy-price alert";
      const why = str(x.status) === "suppressed_cap" ? "daily cap reached" : "held in quiet hours";
      return `${str(x.code).replace(/^cand:[^:]*:[^:]*:/, "")}: ${what}, ${why}`;
    });
  if (hits.size === 0 && clears.size === 0 && cand.rows.length === 0 && held.length === 0)
    return null;
  const nClear = [...clears.values()].reduce((s, n) => s + n, 0);
  const why = [...clears.entries()].map(([r, n]) => `${n} ${CLEAR_WORDS[r] ?? r}`).join(", ");
  const lines = [
    `Buy-price alerts today: ${hits.size} hit, ${nClear} cleared${why ? ` (${why})` : ""}.`,
    `Intraday candidates today: ${cand.rows.length} found, ${carried} carried into tonight's decision.`,
  ];
  const candidates =
    candidatesOn && cand.rows.length > 0
      ? cand.rows.map((x) => ({
          code: str(x.code),
          trigger: text(x.item_category) ?? str(x.item_source),
          outcome: text(x.decision_outcome) ?? "not yet decided",
        }))
      : null;
  return { lines, candidates, held };
}

// ---- section 9: system and quota health ---------------------------------------------------------

const BACKUP_JOB = "nightly-backup";

export async function readHealth(
  c: Ctx,
  av: Availability,
): Promise<{ lines: HealthLine[]; suppressed: number }> {
  const lines: HealthLine[] = [];
  // nightly run
  if (!av.arenaActive) {
    lines.push({
      label: "Nightly run",
      status: "ok",
      detail: "Arena not active (data-only mode).",
    });
  } else if (!c.tradingDay) {
    lines.push({ label: "Nightly run", status: "ok", detail: "Non-trading day." });
  } else {
    const parts: string[] = [];
    let worst: HealthLine["status"] = "ok";
    for (const [name, ok] of [
      ["2a books", av.closeOk],
      ["2b signals", av.signalsOk],
      ["3 review numbers", av.reviewOk],
    ] as const) {
      parts.push(`${name} ${ok ? "done" : "missing"}`);
      if (!ok) worst = "attention";
    }
    lines.push({ label: "Nightly run", status: worst, detail: parts.join("; ") });
  }
  // data freshness
  lines.push({
    label: "Data freshness",
    status: av.marker ? "ok" : "attention",
    detail: av.marker
      ? `Completion marker present for ${c.d}.`
      : `No completion marker for ${c.d} yet.`,
  });
  // ASX switch (DAT-123, AT-21): off when the Owner switch (worker_state.asx_enabled) is off, or the
  // source is off or tripped. The Worker reads the same switch, so the review states what it does.
  const asx = await c.db.execute({
    sql: "SELECT mode, reason FROM source_status WHERE source = 'asx_announcements'",
    args: [],
  });
  const sw = await c.db.execute({
    sql: "SELECT value_json FROM worker_state WHERE key = 'asx_enabled'",
    args: [],
  });
  const swRaw = sw.rows[0]?.value_json;
  const switchOn = parseOn(swRaw); // same parsing as the Worker and the System Health control
  if (asx.rows.length) {
    const mode = str(asx.rows[0]!.mode);
    const on = mode === "on" && switchOn;
    lines.push({
      label: "ASX feed",
      status: on ? "ok" : "attention",
      detail: on
        ? "ASX announcements feed is on."
        : mode === "on"
          ? "ASX announcements feed is off: the ASX contact switch is off."
          : `ASX announcements feed is ${mode === "tripped" ? "stopped by a safety trip" : "off"}${asx.rows[0]!.reason === null ? "" : `: ${str(asx.rows[0]!.reason)}`}.`,
    });
  }
  // AI models
  const llm = await c.db.execute({
    sql: `SELECT COUNT(*) AS n,
            SUM(CASE WHEN fallback_depth = 'rules-only' THEN 1 ELSE 0 END) AS rules,
            SUM(CASE WHEN outcome LIKE '%budget%' THEN 1 ELSE 0 END) AS budget
          FROM llm_call WHERE market = ? AND d = ?`,
    args: [c.market, c.d],
  });
  const calls = num(llm.rows[0]!.n);
  const rulesOnly = num(llm.rows[0]!.rules);
  const budget = num(llm.rows[0]!.budget);
  lines.push({
    label: "AI models",
    status: budget > 0 ? "attention" : "ok",
    detail:
      calls === 0
        ? "No model calls today (rules-only)."
        : `${calls} ${plural(calls, "call")}, ${rulesOnly} answered by rules${budget > 0 ? `; budget exhausted ${budget}x` : ""}.`,
  });
  // Steelman (D-484, D-493): one LLM-free line from the night counters, only on a night that has a row.
  try {
    const n = await readNight(c.db, c.market, c.d);
    if (n !== null) {
      const parts = [`${n.written} of ${n.requested} written`];
      if (n.notWrittenNoModel > 0) parts.push(`${n.notWrittenNoModel} with no model available`);
      if (n.notWrittenBudget > 0) parts.push(`${n.notWrittenBudget} stopped by the AI budget`);
      if (n.notWrittenLimit > 0) parts.push(`${n.notWrittenLimit} over the daily limit`);
      if (n.notWrittenCritic > 0) parts.push(`${n.notWrittenCritic} not passed by the checks`);
      lines.push({
        label: "Steelman",
        status: n.notWrittenBudget > 0 ? "attention" : "ok",
        detail: `${parts.join("; ")}. Informational only; it never changes a pick or an order.`,
      });
    }
  } catch {
    // an unreadable counter table must not break the review
  }
  // quota (estimate)
  try {
    const worst = worstMeter(await getMeters(c.db, c.now, usageEnvironment(process.env)));
    const lvl = worst.level;
    lines.push({
      label: "Quota (estimate)",
      status: lvl === "degrade" ? "down" : lvl === "alert" || lvl === "notice" ? "attention" : "ok",
      detail:
        worst.meter === undefined || worst.meter.ratio === null
          ? "No quota data."
          : `${worst.meter.label} at ${Math.round(worst.meter.ratio * 100)}% of its limit (self-counted estimate).`, // threshold-ok: percent display
    });
  } catch {
    lines.push({
      label: "Quota (estimate)",
      status: "attention",
      detail: "Quota figures unavailable.",
    });
  }
  // backups
  const bk = await c.db.execute({
    sql: "SELECT status, started_at FROM run_record WHERE job = ? ORDER BY started_at DESC LIMIT 1",
    args: [BACKUP_JOB],
  });
  if (bk.rows.length === 0) {
    lines.push({ label: "Backups", status: "attention", detail: "No backup recorded yet." });
  } else {
    const ok = str(bk.rows[0]!.status) === "success";
    lines.push({
      label: "Backups",
      status: ok ? "ok" : "down",
      detail: `Last backup ${ok ? "succeeded" : str(bk.rows[0]!.status)} at ${str(bk.rows[0]!.started_at).slice(0, 16).replace("T", " ")} UTC.`, // threshold-ok: slice width of an ISO minute
    });
  }
  // open incidents
  const inc = await c.db.execute({
    sql: `SELECT COUNT(*) AS n, SUM(CASE WHEN severity = 'S1' THEN 1 ELSE 0 END) AS s1
          FROM incident WHERE resolved_at IS NULL AND at < ?`,
    args: [`${addDays(c.d, 1)}T14:00:00.000Z`], // threshold-ok: end of the Melbourne date, UTC bound (DST-safe margin)
  });
  const open = num(inc.rows[0]!.n);
  lines.push({
    label: "Incidents",
    status: num(inc.rows[0]!.s1) > 0 ? "down" : open > 0 ? "attention" : "ok",
    detail: open === 0 ? "No open incidents." : `${open} open ${plural(open, "incident")}.`,
  });
  // the review email itself
  const em = await c.db.execute({
    sql: "SELECT status, sent_at FROM email_message WHERE email_key = ?",
    args: [`review:${c.d}`],
  });
  lines.push({
    label: "Evening email",
    status:
      em.rows.length === 0 || ["sent", "claimed"].includes(str(em.rows[0]!.status))
        ? "ok"
        : "attention",
    detail:
      em.rows.length === 0
        ? "Not sent yet."
        : `Status: ${str(em.rows[0]!.status).replace(/_/g, " ")}.`,
  });
  const sup = await c.db.execute({
    sql: "SELECT COUNT(*) AS n FROM email_message WHERE d = ? AND status = 'suppressed_cap'",
    args: [c.d],
  });
  return { lines, suppressed: num(sup.rows[0]!.n) };
}

/** Healthy / total components and the open attention items (section 1), from the review snapshot. */
export async function readHealthSummary(
  c: Ctx,
  lines: HealthLine[],
): Promise<{ healthyComponents: number; totalComponents: number; attention: AttentionItem[] }> {
  const own = await c.db.execute({
    sql: "SELECT components_json FROM health_snapshot WHERE d = ? AND purpose = 'review'",
    args: [c.d],
  });
  const fallback = await c.db.execute({
    sql: "SELECT d, components_json FROM health_snapshot WHERE d <= ? AND purpose = 'reminder' ORDER BY d DESC LIMIT 1",
    args: [c.d],
  });
  const row = own.rows[0] ?? fallback.rows[0];
  if (row) {
    try {
      const parsed = JSON.parse(str(row.components_json)) as {
        components?: { id?: string; state?: string; items?: Record<string, unknown>[] }[];
      };
      const comps = (parsed.components ?? []).filter((x) =>
        (HEALTH_COMPONENTS as readonly unknown[]).includes(x.id),
      );
      if (comps.length) {
        const attention: AttentionItem[] = [];
        for (const comp of comps) {
          for (const it of comp.items ?? []) {
            if (it.state !== "attention" && it.state !== "down") continue;
            const since = typeof it.since_d === "string" ? it.since_d : null;
            attention.push({
              name: typeof it.label === "string" ? it.label : str(it.key),
              status: it.state,
              daysOpen:
                since === null
                  ? 1
                  : Math.max(1, Math.round((Date.parse(c.d) - Date.parse(since)) / MS_PER_DAY) + 1),
              fix: typeof it.fix === "string" ? it.fix : "Open System Health for the fix.",
            });
          }
        }
        return {
          healthyComponents: comps.filter((x) => x.state === "healthy").length,
          totalComponents: comps.length,
          attention,
        };
      }
    } catch {
      // fall through to the lines
    }
  }
  const bad = lines.filter((l) => l.status !== "ok");
  return {
    healthyComponents: lines.length - bad.length,
    totalComponents: lines.length,
    attention: bad.map((l) => ({
      name: l.label,
      status: l.status === "down" ? ("down" as const) : ("attention" as const),
      daysOpen: 1,
      fix: l.detail,
    })),
  };
}

// ---- sections 4-6: narrative (R5 row or the facts-only fallback) --------------------------------

export type NarrativePack = {
  d: string;
  nextSession: string | null;
  executions: { id: string; dayPlCents: number; currency: string; dayPl: string }[];
  terminal: { id: string; state: string }[];
  ordersCreated: number;
  ordersFilled: number;
  pendingByExecution: { id: string; orders: number }[];
  regime: string | null;
  breakersAmber: { code: string; breaker: string }[];
  labelsToday: { id: string; label: string; n: number }[];
  invariantViolations: number | null;
  asxFeed: string | null;
  /** The A6 `learn` output of D (M6 T11); null when the phase has no run for the date. */
  learning: LearnFacts | null;
};

export type NarrativeLists = { s4: string[]; s5: string[]; s6: string[] };

export function nextSession(d: string, calendar: readonly CalendarRow[]): string | null {
  let x = d;
  for (let i = 0; i < NEXT_SESSION_SCAN_DAYS; i += 1) {
    x = addDays(x, 1);
    if (isTradingDay(x, calendar)) return x;
  }
  return null;
}

/** The facts the R5 prompt is given (batch 3) and the rules lists are written from. */
export async function readNarrativePack(c: Ctx): Promise<NarrativePack> {
  const carried = !c.tradingDay;
  const ex = c.mode === "full" ? await readExecutions(c, carried) : [];
  const orders = c.mode === "full" && c.tradingDay ? await readOrders(c) : [];
  const reg = await c.db.execute({
    sql: "SELECT state FROM regime_daily WHERE market = ? AND d <= ? ORDER BY d DESC, version DESC LIMIT 1",
    args: [c.market, c.d],
  });
  const amber = await c.db.execute({
    sql: `SELECT code, breaker_id FROM thesis_breaker_eval WHERE market = ? AND d = ? AND status = 'amber'
          ORDER BY code, breaker_id`,
    args: [c.market, c.d],
  });
  const lab = await c.db.execute({
    sql: "SELECT execution_id, label, n FROM label WHERE d = ? ORDER BY execution_id, id",
    args: [c.d],
  });
  const inv = await c.db.execute({
    sql: "SELECT value_json FROM replay_stat WHERE run_id = ? AND scope = 'invariants' AND metric = 'recheck'",
    args: [runKeys.review(c.market, c.d)],
  });
  const asx = await c.db.execute({
    sql: "SELECT mode FROM source_status WHERE source = 'asx_announcements'",
    args: [],
  });
  const pending = new Map<string, number>();
  for (const o of orders.filter((x) => x.state === "created")) {
    pending.set(o.executionId, (pending.get(o.executionId) ?? 0) + 1);
  }
  return {
    d: c.d,
    nextSession: nextSession(c.d, c.calendar),
    executions: ex.map((e) => ({
      id: e.id,
      dayPlCents: e.dayPlCents,
      currency: e.currency,
      dayPl: money(e.dayPlCents, e.currency, true),
    })),
    terminal: ex.filter((e) => e.terminal).map((e) => ({ id: e.id, state: e.terminal! })),
    ordersCreated: orders.filter((o) => o.state === "created").length,
    ordersFilled: orders.filter((o) => o.state === "filled").length,
    pendingByExecution: [...pending.entries()].sort().map(([id, n]) => ({ id, orders: n })),
    regime: reg.rows.length ? str(reg.rows[0]!.state) : null,
    breakersAmber: amber.rows.map((x) => ({ code: str(x.code), breaker: str(x.breaker_id) })),
    labelsToday: lab.rows.map((x) => ({
      id: str(x.execution_id),
      label: str(x.label),
      n: num(x.n),
    })),
    invariantViolations: inv.rows.length
      ? num((JSON.parse(str(inv.rows[0]!.value_json)) as { violations?: number }).violations)
      : null,
    asxFeed: asx.rows.length ? str(asx.rows[0]!.mode) : null,
    learning: await readLearnFacts(c.db, { market: c.market, d: c.d, calendar: c.calendar }),
  };
}

/** The facts-only lists ("Written without AI today", EML-014): deterministic, no model. */
export function rulesNarrative(p: NarrativePack, nonTrading: boolean): NarrativeLists {
  const s4: string[] = [];
  const s5: string[] = [];
  const s6: string[] = [];
  for (const t of p.terminal) s4.push(`${t.id} reached a terminal state today: ${t.state}.`);
  for (const l of p.labelsToday) s4.push(`${l.id} validation label: ${l.label} (n = ${l.n}).`);
  if (p.invariantViolations !== null) {
    s4.push(
      p.invariantViolations === 0
        ? "The ledger re-check found no violations."
        : `The ledger re-check found ${p.invariantViolations} ${plural(p.invariantViolations, "violation")}.`,
    );
  }
  const learn = p.learning === null ? null : learnLines(p.learning);
  if (learn === null) {
    s4.push("No attribution observations are recorded yet; they start in a later release.");
  } else {
    s4.push(...learn.s4);
  }
  if (!nonTrading && p.executions.length > 0) {
    const sorted = [...p.executions].sort(
      (a, b) => b.dayPlCents - a.dayPlCents || (a.id < b.id ? -1 : 1),
    );
    const best = sorted[0]!;
    const worst = sorted[sorted.length - 1]!;
    s5.push(`Best day: ${best.id} ${best.dayPl} (single-day result, noise).`);
    if (worst.id !== best.id) {
      s5.push(`Weakest day: ${worst.id} ${worst.dayPl} (single-day result, noise).`);
    }
    if (learn === null) {
      s5.push("Reasons for results are not analysed yet; attribution starts in a later release.");
    }
  }
  if (learn !== null) s5.push(...learn.s5);
  if (p.nextSession !== null) s6.push(`Next trading session: ${p.nextSession}.`);
  if (learn !== null) s6.push(...learn.s6);
  if (!nonTrading) {
    s6.push(
      p.ordersCreated === 0
        ? "No orders are queued for the next session."
        : `${p.ordersCreated} ${plural(p.ordersCreated, "order")} queued for the next session.`,
    );
  }
  if (p.regime !== null && p.regime !== "NEUTRAL") s6.push(`Market regime: ${p.regime}.`);
  for (const b of p.breakersAmber) s6.push(`Thesis-breaker amber: ${b.code} ${b.breaker}.`);
  if (p.asxFeed !== null && p.asxFeed !== "on")
    s6.push(`The ASX announcements feed is ${p.asxFeed}.`);
  return { s4, s5, s6 };
}

/** The router request for R5 (batch 3). Grounded: the answer may only use numbers of the pack. */
export const NARRATIVE_TEMPLATE_VERSION = "r5-review-1";
const NARRATIVE_MAX_OUTPUT_TOKENS = 600; // threshold-ok: output cap for one review narrative
const NARRATIVE_MAX_ITEMS = 6; // threshold-ok: items per section in the review narrative

function stringList(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > NARRATIVE_MAX_ITEMS) return null;
  return v.every((x) => typeof x === "string" && x.length > 0) ? (v as string[]) : null;
}

export function parseNarrative(v: unknown): NarrativeLists | null {
  if (v === null || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const s4 = stringList(o.s4);
  const s5 = stringList(o.s5);
  const s6 = stringList(o.s6);
  return s4 && s5 && s6 ? { s4, s5, s6 } : null;
}

export function narrativeRequest(market: string, pack: NarrativePack, nonTrading: boolean) {
  return {
    role: "R5" as const,
    market,
    d: pack.d,
    nightly: true,
    templateVersion: NARRATIVE_TEMPLATE_VERSION,
    task: 'Write the three narrative sections of a retail investor\'s Evening Review from FACTS: "s4" what was learned today, "s5" what worked better and why, "s6" what needs improving for tomorrow. Each is a short list of plain sentences. Use only the facts given; do not forecast and do not state numbers that are not in FACTS. Answer as JSON {"s4": string[], "s5": string[], "s6": string[]}.',
    facts: pack,
    parse: parseNarrative,
    rules: rulesNarrative(pack, nonTrading),
    maxOutputTokens: NARRATIVE_MAX_OUTPUT_TOKENS,
  };
}

export type NarrativeRow = {
  kind: "llm" | "rules";
  provider: string;
  fallbackDepth: string;
  s4: string[];
  s5: string[];
  s6: string[];
};

/** The batch 3 row of D, or null when absent. The request path never calls a model. */
export async function readNarrativeRow(
  db: Db,
  market: string,
  d: string,
): Promise<NarrativeRow | null> {
  const r = await db.execute({
    sql: "SELECT value_json FROM replay_stat WHERE run_id = ? AND scope = ? AND metric = ?",
    args: [runKeys.words(market, d), narrativeScope(market, d), NARRATIVE_METRIC],
  });
  if (r.rows.length === 0) return null;
  try {
    const v = JSON.parse(str(r.rows[0]!.value_json)) as NarrativeRow;
    const lists = parseNarrative(v);
    if (!lists || (v.kind !== "llm" && v.kind !== "rules")) return null;
    return {
      ...lists,
      kind: v.kind,
      provider: str(v.provider),
      fallbackDepth: str(v.fallbackDepth),
    };
  } catch {
    return null;
  }
}

export function narrativeProvenance(row: NarrativeRow | null): NarrativeKind {
  if (row === null || row.kind === "rules") return "rules";
  return row.provider === "mock" ? "mock" : "llm";
}

export function narrativeFacts(row: NarrativeRow | null, rules: NarrativeLists): NarrativeFacts {
  if (row === null || row.kind === "rules") return { kind: "rules", ...rules };
  return { kind: "llm", s4: row.s4, s5: row.s5, s6: row.s6 };
}

// ---- unread streak (EML-036) --------------------------------------------------------------------

/** Consecutive earlier review dates (newest first) with no `review_read`; 0 when the newest was read. */
export async function unreadStreak(db: Db, d: string): Promise<number> {
  const r = await db.execute({
    sql: `SELECT DISTINCT e.d, (SELECT 1 FROM review_read rr WHERE rr.d = e.d) AS read
          FROM evening_review e WHERE e.d < ? ORDER BY e.d DESC LIMIT ?`,
    args: [d, UNREAD_LOOKBACK],
  });
  let n = 0;
  for (const x of r.rows) {
    if (x.read !== null) break;
    n += 1;
  }
  return n;
}

// ---- section 7a: New picks (UXN-044, M6 T17) ------------------------------------------------------
// Read from the STORED picks of the review date D and the stored outcomes: bounded to D, no
// recomputation, no LLM. The review reads picks; no trading module does (a test pins it). The
// assembler and the renderer take this section over in M7; until then it is a reader with facts.

export type NewPickFact = {
  readonly code: string;
  readonly rank: number;
  readonly buyUpToCents: number;
  readonly validUntilD: string;
  readonly stopCents: number;
  readonly aimCents: number;
  readonly timeFrameWeeks: number | null;
  readonly basedOn: string | null;
  readonly link: string;
};

export type NewPicksFacts = {
  readonly d: string;
  readonly profiles: readonly {
    readonly profile: string;
    readonly picks: readonly NewPickFact[];
    readonly successLine: string;
  }[];
  readonly none: boolean;
  readonly honesty: string;
};

export async function readPicksSection(
  c: Ctx,
  q: { picks: PicksParams; confidence: number },
): Promise<NewPicksFacts> {
  const f = await readSection7a(c.db, {
    market: c.market,
    d: c.d,
    appUrl: c.appUrl,
    picks: q.picks,
    confidence: q.confidence,
  });
  return {
    d: f.d,
    none: f.none,
    honesty: f.proven
      ? "Personal use only · Not financial advice"
      : "Personal use only · Not financial advice · Model not proven yet",
    profiles: f.profiles.map((p) => ({
      profile: p.profile,
      successLine: p.successLine,
      picks: p.picks.map((x) => ({
        code: x.code,
        rank: x.rank,
        buyUpToCents: microToCents(x.buyUpToMicro),
        validUntilD: x.validUntilD,
        stopCents: microToCents(x.stopMicro),
        aimCents: microToCents(x.aimMicro),
        timeFrameWeeks: x.timeFrameWeeks,
        basedOn: x.basedOn,
        link: x.link,
      })),
    })),
  };
}
