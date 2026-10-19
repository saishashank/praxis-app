// AGT-113 inputs: reads tonight's stored signals (and what the Decision Card, the bars, the labels,
// the development-split ledger and AGT-112 say about them) and reduces them to `PickInput`s. Every
// read is bounded by the night D. Picks READ these tables; nothing in the trading path reads picks.
import type { Client } from "@libsql/client";
import { buildScenario, loadScenarioInput } from "@/lib/agents/cards";
import { logReturns, microToFloat, stdevFloat } from "@/lib/agents/indicators";
import type { AgentParams } from "@/lib/agents/params";
import { priceMicro } from "@/lib/arena/marketData";
import { addDays, isTradingDay, sessionsBetween, type CalendarRow } from "@/lib/data/calendar";
import { divFloor } from "@/lib/money/rational";
import { factorLines, readFactorRows } from "./factors";
import type { Family, PickInput, Tier, UniverseCode } from "./types";

type Db = Pick<Client, "execute">;
type Row = Record<string, unknown>;

const PPM = 1_000_000n; // threshold-ok: parts per million
const str = (v: unknown): string => String(v);
const asInt = (v: unknown): number => Number(v); // money-float-ok: SQL integer column

/** The date `n` trading sessions before d (d itself when n = 0). */
export function sessionsBack(d: string, n: number, calendar: readonly CalendarRow[]): string {
  let day = d;
  let left = n;
  while (left > 0) {
    day = addDays(day, -1);
    if (isTradingDay(day, calendar)) left -= 1;
  }
  return day;
}

type BarPoint = { readonly c: bigint; readonly volume: bigint };

/** The last `count` bars up to d for every code (oldest first). */
async function recentBars(
  db: Db,
  market: string,
  d: string,
  count: number,
  calendar: readonly CalendarRow[],
): Promise<Map<string, BarPoint[]>> {
  const from = sessionsBack(d, count, calendar);
  const r = await db.execute({
    sql: `SELECT code, d, c, volume FROM price_bar
          WHERE market = ? AND d <= ? AND d >= ? ORDER BY code, d`,
    args: [market, d, from],
  });
  const out = new Map<string, BarPoint[]>();
  for (const x of r.rows) {
    const code = str(x.code);
    const list = out.get(code) ?? [];
    list.push({ c: priceMicro(x.c), volume: BigInt(str(x.volume)) });
    out.set(code, list);
  }
  for (const [code, list] of out) out.set(code, list.slice(-count));
  return out;
}

function volOf(points: readonly BarPoint[], window: number): number | null {
  if (points.length < window + 1) return null;
  const closes = points.map((p) => microToFloat(p.c));
  return stdevFloat(logReturns(closes).slice(-window), window, 1);
}

function advValueOf(points: readonly BarPoint[], window: number): bigint {
  const last = points.slice(-window);
  if (last.length === 0) return 0n;
  let value = 0n;
  for (const p of last) value += p.c * p.volume;
  return divFloor(value, BigInt(last.length));
}

function median(sorted: readonly number[]): number {
  return sorted[Math.floor((sorted.length - 1) / 2)]!; // lower median
}

/** Stop price of the family's own initial stop, from the stored Decision Card (tightest wins). */
export function stopFromCard(cardJson: string): bigint | null {
  const card = JSON.parse(cardJson) as { exit_plan?: unknown };
  if (!Array.isArray(card.exit_plan)) return null;
  let best: bigint | null = null;
  for (const e of card.exit_plan as Row[]) {
    if (e.tag !== "IS" || e.kind !== "initial_stop") continue;
    const detail = (e.detail ?? {}) as Row;
    if (typeof detail.stop_at_close_micro !== "string") continue;
    const v = BigInt(detail.stop_at_close_micro);
    if (best === null || v > best) best = v;
  }
  return best;
}

type History = {
  readonly scenario: PickInput["scenario"];
  readonly aimReachByGood: (goodPpm: number) => number | null;
  readonly holdMedian: number | null;
  readonly medianDropPpm: number | null;
  readonly splitVersion: number | null;
};

async function historyOf(
  db: Db,
  q: { market: string; family: string; ruleVersion: string; variant: string },
  p: AgentParams,
  calendar: readonly CalendarRow[],
): Promise<History> {
  const input = await loadScenarioInput(db, q);
  const sc = buildScenario(input, q.variant, q.ruleVersion, p.stats.scenarioMinN);
  const scenario: PickInput["scenario"] =
    sc.insufficient_history || sc.p10_ppm === null || sc.p50_ppm === null || sc.p90_ppm === null
      ? null
      : { n: sc.n, badPpm: sc.p10_ppm, typicalPpm: sc.p50_ppm, goodPpm: sc.p90_ppm };
  const dev = input.split?.devEndD ?? null;
  let holdMedian: number | null = null;
  let medianDrop: number | null = null;
  if (dev !== null) {
    const rows = await db.execute({
      sql: `SELECT l.id, l.entry_d, l.exit_d FROM ledger_row l JOIN signal s ON s.id = l.signal_id
            WHERE s.market = ? AND s.family = ? AND s.rule_version = ? AND s.variant = ?
              AND l.exit_d IS NOT NULL AND l.entry_d <= ? AND l.exit_d <= ?
            ORDER BY l.id`,
      args: [q.market, q.family, q.ruleVersion, q.variant, dev, dev],
    });
    const holds = rows.rows
      .map((x) => sessionsBetween(str(x.entry_d), str(x.exit_d), calendar).length)
      .filter((h) => h >= 1)
      .sort((a, b) => a - b);
    if (holds.length > 0) holdMedian = median(holds);
    const drops = await db.execute({
      sql: `SELECT a.mae_ppm FROM attribution a
            JOIN ledger_row l ON a.subject_kind = 'ledger_row' AND a.subject_id = l.id
            JOIN signal s ON s.id = l.signal_id
            WHERE s.market = ? AND s.family = ? AND s.rule_version = ? AND s.variant = ?
              AND l.exit_d IS NOT NULL AND l.entry_d <= ? AND l.exit_d <= ?
              AND a.version = (SELECT MAX(b.version) FROM attribution b
                               WHERE b.subject_kind = a.subject_kind AND b.subject_id = a.subject_id)`,
      args: [q.market, q.family, q.ruleVersion, q.variant, dev, dev],
    });
    const mags = drops.rows
      .filter((x) => x.mae_ppm !== null)
      .map((x) => Math.abs(asInt(x.mae_ppm)))
      .sort((a, b) => a - b);
    if (mags.length > 0) medianDrop = median(mags);
  }
  return {
    scenario,
    holdMedian,
    medianDropPpm: medianDrop,
    splitVersion: input.split?.version ?? null,
    aimReachByGood: (goodPpm) => {
      if (input.nets.length === 0) return null;
      const reached = input.nets.filter((f) => f.num * PPM >= BigInt(goodPpm) * f.den).length;
      return Number((BigInt(reached) * PPM) / BigInt(input.nets.length)); // money-float-ok: ppm share
    },
  };
}

export type PickContextData = {
  readonly inputs: PickInput[];
  readonly universe: UniverseCode[];
};

/** Everything the generator needs for night D, read from the stored state (bounded by D). */
export async function loadPickInputs(
  db: Db,
  q: { market: string; d: string; params: AgentParams; calendar: readonly CalendarRow[] },
): Promise<PickContextData> {
  const { market, d, params: p, calendar } = q;
  const count = Math.max(p.windows.adv, p.windows.vol + 1);
  const bars = await recentBars(db, market, d, count, calendar);

  // universe of the night: not halted, with a bar on D
  const snap = await db.execute({
    sql: `SELECT code, tier FROM universe_snapshot
          WHERE market = ? AND halted = 0
            AND d = (SELECT MAX(d) FROM universe_snapshot WHERE market = ? AND d <= ?)
          ORDER BY code`,
    args: [market, market, d],
  });
  const universe: UniverseCode[] = [];
  for (const x of snap.rows) {
    const pts = bars.get(str(x.code));
    if (pts === undefined || pts.length === 0) continue;
    universe.push({
      code: str(x.code),
      tier: str(x.tier) as Tier,
      vol: volOf(pts, p.windows.vol),
    });
  }

  const sigs = await db.execute({
    sql: `SELECT id, family, rule_version, variant, code, rank_score, rules_json, evidence_json
          FROM signal WHERE market = ? AND d = ? AND partial = 0 ORDER BY id`,
    args: [market, d],
  });
  const histories = new Map<string, History>();
  const labels = new Map<string, string>();
  const inputs: PickInput[] = [];
  for (const s of sigs.rows) {
    const family = str(s.family) as Family;
    const ruleVersion = str(s.rule_version);
    const variant = str(s.variant);
    const evidence = JSON.parse(str(s.evidence_json)) as Row;
    if (typeof evidence.close_micro !== "string") continue;
    const tier = evidence.tier as Tier;
    const key = `${family}|${ruleVersion}|${variant}`;
    let h = histories.get(key);
    if (h === undefined) {
      h = await historyOf(db, { market, family, ruleVersion, variant }, p, calendar);
      histories.set(key, h);
    }
    const lk = `${family}|${ruleVersion}`;
    if (!labels.has(lk)) {
      const lab = await db.execute({
        sql: `SELECT l.label FROM label l JOIN execution e ON e.id = l.execution_id
              WHERE e.family = ? AND l.rule_version = ? AND l.d <= ?
              ORDER BY l.d DESC, l.id DESC LIMIT 1`,
        args: [family, ruleVersion, d],
      });
      labels.set(lk, lab.rows.length === 0 ? "UNVALIDATED" : str(lab.rows[0]!.label));
    }
    const card = await db.execute({
      sql: "SELECT id, card_json FROM decision_card WHERE signal_id = ? ORDER BY id LIMIT 1",
      args: [str(s.id)],
    });
    const rules = JSON.parse(str(s.rules_json)) as {
      rule: string;
      value: string;
      threshold: string;
      pass: boolean;
    }[];
    const today: Record<string, string> = {};
    for (const r of rules) today[r.rule] = r.value;
    const rows =
      h.splitVersion === null
        ? []
        : await readFactorRows(db, { market, family, ruleVersion, splitVersion: h.splitVersion });
    const pts = bars.get(str(s.code)) ?? [];
    inputs.push({
      signalId: str(s.id),
      cardId: card.rows.length === 0 ? null : str(card.rows[0]!.id),
      family,
      ruleVersion,
      variant,
      code: str(s.code),
      tier,
      rankScore: str(s.rank_score),
      label: labels.get(lk)!,
      referenceMicro: BigInt(evidence.close_micro),
      stopMicro: card.rows.length === 0 ? null : stopFromCard(str(card.rows[0]!.card_json)),
      advValueMicro: advValueOf(pts, p.windows.adv),
      vol: volOf(pts, p.windows.vol),
      scenario: h.scenario,
      aimReachPpm: h.scenario === null ? null : h.aimReachByGood(h.scenario.goodPpm),
      holdMedianSessions: h.holdMedian,
      medianDropPpm: h.medianDropPpm,
      factors: factorLines(today, rows, p.picks.factorMinBucketN),
      basedOn: rules
        .filter((r) => r.pass)
        .map((r) => `${r.rule}: ${r.value} (needed ${r.threshold})`),
    });
  }
  return { inputs, universe };
}
