// Weekly `robustness` stage (M14 WP3; docs/M14_design.md 2.1; D-222, D-223, D-224). For each lineage with
// a split it writes three descriptive `replay_stat` metrics (shapes: stats/robustnessTypes.ts), scope
// `<market>:<family>:<rule version>`, and never reads validation or holdout rows:
//   exit_ablation  the live rule against the same entries exited by the time exit only (ARN-106);
//   slip_one_tick  the same rows with one more adverse tick per side, beside the stress figure (ARN-107);
//   stability      the generator's +-1 grid steps of every numeric key: n, mean net, the one-sided 90 %
//                  lower bound under P5 and the absolute-gate result; "fragile" when the version passes
//                  and a neighbour fails (ARN-108). Weekly for the incumbent, once per challenger in replay.
// Nothing here is a trial and nothing is a finding. Net returns are fractions (0.012 = 1.2 %).
import { FAMILY_ORDER, FAMILY_RULE_VERSION } from "@/lib/agents/families/constants";
import { paramsWithVersion } from "@/lib/agents/params";
import type { Family } from "@/lib/agents/schema";
import { replayLedger, type LedgerEntry } from "@/lib/replay/ledger";
import { costSetupFrom } from "@/lib/replay/returns";
import { developmentNet, oneTickAdverse } from "@/lib/replay/sensitivity";
import type {
  ExitAblationStat,
  ReturnSummary,
  SlipOneTickStat,
  StabilityNeighbour,
  StabilityStat,
} from "@/lib/stats/robustnessTypes";
import { lineageId } from "@/lib/stats/splits";
import type { ReplayStatInput } from "@/lib/replay/scorecards";
import { candidateSteps } from "./challengerGenerator";
import { incumbentOf } from "./challengerLifecycle";
import type { StageOutput } from "./weeklyRun";
import {
  comparatorOf,
  developmentSessions,
  loadSplit,
  netRowsOf,
  versionParams,
  type WeeklyContext,
} from "./weeklyStages";

const ratNum = (r: { readonly num: bigint; readonly den: bigint }): number =>
  Number(r.num) / Number(r.den); // money-float-ok: descriptive figures are float64

const meanOf = (xs: readonly number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

function medianOf(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** n, mean/median net, hit rate and mean sessions held of a set of net returns. */
export function summarise(
  nets: readonly number[],
  held: readonly (number | null)[],
): ReturnSummary {
  const h = held.filter((x): x is number => x !== null);
  return {
    n: nets.length,
    mean_net: meanOf(nets),
    median_net: medianOf(nets),
    hit_rate: nets.length === 0 ? null : nets.filter((x) => x > 0).length / nets.length,
    mean_sessions_held: meanOf(h),
  };
}

const key = (e: LedgerEntry): string => `${e.code}|${e.row.entry_d}`;

export async function robustnessStage(c: WeeklyContext): Promise<StageOutput> {
  const { db, market, world, params } = c;
  const comparator = comparatorOf(c);
  const profile = costSetupFrom(params).profile;
  const sessionIdx = new Map(world.sessions.map((d, i) => [d, i]));
  const heldOf = (e: LedgerEntry): number | null => {
    const a = sessionIdx.get(e.row.entry_d);
    const b = e.row.exit_d === null ? undefined : sessionIdx.get(e.row.exit_d);
    return a === undefined || b === undefined ? null : b - a;
  };
  const stats: ReplayStatInput[] = [];
  const skipped: { family: string; reason: string }[] = [];

  const stability = async (
    family: Family,
    versionId: string,
    scope: string,
    vparams: Readonly<Record<string, unknown>>,
    devWin: ReturnType<typeof developmentSessions>,
    block: number,
    base: { passes: boolean },
  ): Promise<void> => {
    const lineage = lineageId(market, family);
    const neighbours: StabilityNeighbour[] = [];
    for (const cand of await candidateSteps(family, vparams, [])) {
      const res = replayLedger(world, {
        params: paramsWithVersion(params, family, cand.params),
        familyOptions: { families: [family], ruleVersions: { [family]: `${family}.dev` } },
        controls: false,
      });
      const dev = res.entries.filter(
        (e) => e.variant === family && e.net !== null && devWin.index.has(e.row.entry_d),
      );
      const dn = developmentNet(
        netRowsOf(dev, devWin.index),
        devWin.sessions.length,
        block,
        params.stats,
        `${lineage}:${versionId}:${cand.key}:${cand.direction}`,
      );
      neighbours.push({
        key: cand.key,
        direction: cand.direction,
        value: cand.value,
        n: dn.n,
        mean_net: dn.meanNet,
        net_lower90: dn.netLower90,
        passes_absolute_gate: dn.passesAbsoluteGate,
      });
    }
    const value: StabilityStat = {
      family,
      rule_version: versionId,
      passes_absolute_gate: base.passes,
      fragile: base.passes && neighbours.some((n) => !n.passes_absolute_gate),
      neighbours,
    };
    stats.push({ scope, metric: "stability", value });
  };

  for (const family of FAMILY_ORDER) {
    const lineage = lineageId(market, family);
    const split = await loadSplit(db, lineage);
    if (split === null) {
      skipped.push({ family, reason: "no_split" });
      continue;
    }
    const incumbentId = (await incumbentOf(db, market, family)) ?? FAMILY_RULE_VERSION[family];
    const devWin = developmentSessions(world, split);
    const inDev = (e: LedgerEntry): boolean => e.net !== null && devWin.index.has(e.row.entry_d);
    const rule = c.ledger.entries.filter(
      (e) =>
        e.family === family && e.variant === family && e.ruleVersion === incumbentId && inDev(e),
    );
    const scope = `${market}:${family}:${incumbentId}`;

    // ARN-106 and ARN-107 on the rows both passes produced
    const comp = new Map(
      (comparator?.entries ?? [])
        .filter((e) => e.family === family && e.variant === family && e.ruleVersion === incumbentId)
        .map((e) => [key(e), e]),
    );
    const paired = rule.filter((e) => comp.get(key(e))?.net != null);
    if (comparator !== null) {
      const value: ExitAblationStat = {
        family,
        rule_version: incumbentId,
        rule: summarise(
          paired.map((e) => ratNum(e.net!)),
          paired.map(heldOf),
        ),
        time_stop_only: summarise(
          paired.map((e) => ratNum(comp.get(key(e))!.net!)),
          paired.map((e) => heldOf(comp.get(key(e))!)),
        ),
      };
      stats.push({ scope, metric: "exit_ablation", value });
    }
    const slip = oneTickAdverse(rule, profile);
    const slipValue: SlipOneTickStat = {
      family,
      rule_version: incumbentId,
      base: summarise(
        rule.map((e) => ratNum(e.net!)),
        rule.map(heldOf),
      ),
      one_tick: summarise(
        slip.map((s) => ratNum(s.net)),
        rule.map(heldOf),
      ),
      stress_mean_net: meanOf(rule.filter((e) => e.stress !== null).map((e) => ratNum(e.stress!))),
    };
    stats.push({ scope, metric: "slip_one_tick", value: slipValue });

    // ARN-108: the incumbent weekly, each challenger in replay once
    const baseNet = developmentNet(
      netRowsOf(rule, devWin.index),
      devWin.sessions.length,
      split.block_sessions,
      params.stats,
      `${lineage}:${incumbentId}:base`,
    );
    await stability(
      family,
      incumbentId,
      scope,
      await versionParams(db, incumbentId),
      devWin,
      split.block_sessions,
      { passes: baseNet.passesAbsoluteGate },
    );
    const chs = await db.execute({
      sql: "SELECT rule_version_id FROM challenger WHERE lineage_id = ? AND state = 'replay' ORDER BY id",
      args: [lineage],
    });
    for (const ch of chs.rows) {
      const vid = String(ch.rule_version_id);
      const cscope = `${market}:${family}:${vid}`;
      const seen = await db.execute({
        sql: "SELECT 1 FROM replay_stat WHERE scope = ? AND metric = 'stability' LIMIT 1",
        args: [cscope],
      });
      if (seen.rows.length > 0) continue;
      const vp = await versionParams(db, vid);
      const res = replayLedger(world, {
        params: paramsWithVersion(params, family, vp),
        familyOptions: { families: [family], ruleVersions: { [family]: vid } },
        controls: false,
      });
      const mine = res.entries.filter((e) => e.variant === family && inDev(e));
      const bn = developmentNet(
        netRowsOf(mine, devWin.index),
        devWin.sessions.length,
        split.block_sessions,
        params.stats,
        `${lineage}:${vid}:base`,
      );
      await stability(family, vid, cscope, vp, devWin, split.block_sessions, {
        passes: bn.passesAbsoluteGate,
      });
    }
  }
  return { stats: [...stats, { scope: market, metric: "robustness", value: { skipped } }] };
}
