// Signal-ledger replay (M4 T11; design 2.7, 2.8, 4.7; ARN-080/081/102, decisions 18, 21, 23, 25, 32,
// 33; D-088 draft). A pure day loop over a snapshot-backed `LedgerSource`: on each decision session
// D the shared rule interpreter `runFamilies` (the same function the live batch calls, AGT-003) says
// which signals fire; each becomes AT MOST ONE ledger row per (family, rule version, variant, code)
// at a time and one row per event group, entered at the next open at the fixed notional (A$600, no
// cash, no position limit) and exited by the family's own exits (`walkPosition`). A new row for the
// same key starts only after the previous row's exit, and after an IS exit not before
// `reentry_block` sessions have passed (FAM-002, decision 18). Each closed row gets its matched
// controls from the shared path library. Output rows have the shape of migration 0008
// `ledger_row` / `ledger_control` (pure objects; writing is T14/T16). No clock, no randomness
// outside the seeded library: the same snapshot, parameters and seed give byte-identical output.
import {
  familyOutputJson,
  runFamilies,
  type Candidate,
  type FamilyInputs,
  type FamilyOptions,
} from "@/lib/agents/families";
import type { AgentParams } from "@/lib/agents/params";
import { canonicalJson, sha256Hex } from "@/lib/arena/cohort";
import { floorRat } from "@/lib/money/round";
import type { Rational } from "@/lib/money/rational";
import {
  createControlLibrary,
  type ControlDraw,
  type ControlLibrary,
  type ControlSource,
  type EventAnchor,
} from "./controlLibrary";
import {
  aggregateDaily,
  costSetupFrom,
  economicsOf,
  fractionToRational,
  pairedExcess,
  walkPosition,
  type CostSetup,
  type DailyPoint,
  type Fraction,
  type MtmPoint,
} from "./returns";

export interface LedgerSource extends ControlSource {
  /**
   * What the DecisionView returns for session `d`, reduced to facts (T6/T8 assemble it from the
   * snapshot). Must contain data up to `d` only and end its `sessions` at `d`.
   */
  familyInputs(d: string): FamilyInputs;
  /** True when the code has a corporate action with an ex-date in [fromD, toD] (rows are flagged). */
  corpActionBetween?(code: string, fromD: string, toD: string): boolean;
}

export type LedgerOptions = {
  readonly params: AgentParams;
  /** First and last decision session (inclusive). Defaults: the whole calendar. */
  readonly from?: string;
  readonly to?: string;
  /** Master seed for the control library scopes (the arena master seed in production). */
  readonly masterSeed?: bigint;
  readonly familyOptions?: FamilyOptions;
  /** Draw controls (default true); false for ledger-only runs. */
  readonly controls?: boolean;
  readonly cost?: CostSetup;
};

/** Default master seed: the arena's (closeBooks ARENA_MASTER_SEED), repeated to avoid a DB import. */
export const LEDGER_MASTER_SEED = 20_261_011n; // threshold-ok: arena master seed (closeBooks.ts)

/** `ledger_row` (migration 0008). Money columns are bigint micro; `qty` is a whole number of shares. */
export type LedgerRowRecord = {
  readonly id: string;
  readonly signal_id: string;
  readonly group_key: string | null;
  readonly entry_d: string;
  readonly exit_d: string | null;
  readonly exit_tag: "IS" | "CS" | null;
  readonly qty: number;
  readonly fill_in_micro: bigint;
  readonly fill_out_micro: bigint | null;
  readonly brok_in_micro: bigint;
  readonly brok_out_micro: bigint | null;
  readonly stress_in_micro: bigint;
  readonly stress_out_micro: bigint | null;
  readonly gross_num: bigint | null;
  readonly gross_den: bigint | null;
  readonly timed: 0 | 1;
  readonly forward: 0 | 1;
};

export type LedgerEntry = {
  readonly row: LedgerRowRecord;
  readonly lineage: string;
  readonly family: Candidate["family"];
  readonly ruleVersion: string;
  readonly variant: string;
  readonly code: string;
  readonly decisionD: string;
  /** CS rule id or `stop`; null while open. */
  readonly exitRule: string | null;
  /** Net and stressed returns as exact fractions of micro amounts; null while open. */
  readonly net: Fraction | null;
  readonly stress: Fraction | null;
  /** Paired excess r - mean(controls), exact (decision 25); null while open or without controls. */
  readonly excess: Rational | null;
  readonly flags: readonly string[];
  readonly mtm: readonly MtmPoint[];
  readonly controls: ControlDraw | null;
};

export type SkippedSignal = {
  readonly d: string;
  readonly family: string;
  readonly variant: string;
  readonly code: string;
  /** duplicate_group | open_row | reentry_block | fill_<reason> */
  readonly reason: string;
};

export type LedgerResult = {
  readonly market: string;
  readonly from: string;
  readonly to: string;
  readonly sessions: number;
  readonly entries: readonly LedgerEntry[];
  readonly skipped: readonly SkippedSignal[];
  readonly controlPaths: number;
};

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function signalId(
  market: string,
  d: string,
  family: string,
  ruleVersion: string,
  variant: string,
  code: string,
): string {
  return `sig:${market}:${d}:${family}:${ruleVersion}:${variant}:${code}`;
}

export function ledgerRowId(
  lineage: string,
  ruleVersion: string,
  variant: string,
  code: string,
  entryD: string,
): string {
  return `lr:${lineage}:${ruleVersion}:${variant}:${code}:${entryD}`;
}

/** Event anchors of a signal for the F2 / F3 control mapping (distance in micro, ATR at decision). */
function anchorsOf(c: Candidate, openMicro: bigint): EventAnchor[] | "no_atr" {
  const atr = c.stopSpec.atr_micro;
  const out: EventAnchor[] = [];
  const dist = (level: bigint): bigint => (openMicro > level ? openMicro - level : 0n);
  if (c.family === "F3") {
    const level = c.plan.initialStops.find((r) => r.via === null)?.spec.level_micro ?? null;
    if (level !== null) {
      if (atr === null) return "no_atr";
      out.push({ ruleId: "F3.is_event_low", distanceMicro: dist(level), atrMicro: atr });
    }
  }
  if (c.family === "F2") {
    const rule = c.plan.cs.find((r) => r.via === null && r.kind === "close_below_level");
    if (rule !== undefined && rule.kind === "close_below_level") {
      if (atr === null) return "no_atr";
      out.push({ ruleId: "F2.cs_event_low", distanceMicro: dist(rule.levelMicro), atrMicro: atr });
    }
  }
  return out;
}

/**
 * Replay the signal ledger over the snapshot calendar. Decision sessions run from `from` to `to`;
 * rows opened near the end that have not exited by the last session stay open (no exit columns,
 * marked to market to the last close). The result is deterministic.
 */
export function replayLedger(src: LedgerSource, opts: LedgerOptions): LedgerResult {
  const { params } = opts;
  const sessions = src.sessions;
  if (sessions.length === 0) throw new RangeError("no sessions");
  const endIdx = sessions.length - 1;
  const cost = opts.cost ?? costSetupFrom(params);
  const library: ControlLibrary | null =
    opts.controls === false
      ? null
      : createControlLibrary(src, cost, opts.masterSeed ?? LEDGER_MASTER_SEED);
  const from = opts.from ?? sessions[0]!;
  const to = opts.to ?? sessions[endIdx]!;
  const block = params.reentryBlock;

  /** Per key: the first decision index at which a new row may start. */
  const freeAt = new Map<string, { idx: number; exitIdx: number }>();
  const usedGroups = new Set<string>();
  const entries: LedgerEntry[] = [];
  const skipped: SkippedSignal[] = [];
  let market = "";

  for (let idx = 0; idx <= endIdx; idx += 1) {
    const d = sessions[idx]!;
    if (d < from) continue;
    if (d > to) break;
    const inputs = src.familyInputs(d);
    if (inputs.d !== d || inputs.sessions[inputs.sessions.length - 1] !== d) {
      throw new RangeError(`family inputs for ${d} must end at ${d}`);
    }
    market = inputs.market;
    const out = runFamilies(inputs, params, opts.familyOptions);
    const sameDay = new Map<string, Set<string>>();
    for (const c of [...out.candidates, ...out.blocked]) {
      let s = sameDay.get(c.family);
      if (s === undefined) sameDay.set(c.family, (s = new Set()));
      s.add(c.code);
    }

    for (const c of out.candidates) {
      const key = `${c.family}|${c.ruleVersion}|${c.variant}|${c.code}`;
      const skip = (reason: string): void => {
        skipped.push({ d, family: c.family, variant: c.variant, code: c.code, reason });
      };
      const groupKey =
        c.groupKey === null ? null : `${c.family}|${c.ruleVersion}|${c.variant}|${c.groupKey}`;
      if (groupKey !== null && usedGroups.has(groupKey)) {
        skip("duplicate_group");
        continue;
      }
      const busy = freeAt.get(key);
      if (busy !== undefined && idx < busy.idx) {
        skip(idx < busy.exitIdx ? "open_row" : "reentry_block");
        continue;
      }
      if (idx >= endIdx) {
        skip("fill_no_session");
        continue;
      }
      const advMicro = c.adv === null ? 0n : floorRat(c.adv);
      const w = walkPosition(
        src,
        {
          code: c.code,
          plan: c.plan,
          entryIdx: idx + 1,
          endIdx,
          advMicro,
          maxOpenMicro: c.maxOpenMicro,
          forceExit: false,
        },
        cost,
      );
      if (w.kind === "skipped") {
        skip(`fill_${w.reason}`);
        continue;
      }
      if (groupKey !== null) usedGroups.add(groupKey);
      const x = w.exit;
      freeAt.set(
        key,
        x === null
          ? { idx: endIdx + 1, exitIdx: endIdx + 1 }
          : { idx: x.idx + (x.tag === "IS" ? block : 0), exitIdx: x.idx },
      );

      const lineage = `${market}:${c.family}`;
      const rowId = ledgerRowId(lineage, c.ruleVersion, c.variant, c.code, w.entryD);
      const e = economicsOf(w);
      const flags = [...c.flags];
      if (
        src.corpActionBetween?.(c.code, w.entryD, x === null ? sessions[endIdx]! : x.d) === true
      ) {
        flags.push("corp_action_in_hold");
      }
      const row: LedgerRowRecord = {
        id: rowId,
        signal_id: signalId(market, d, c.family, c.ruleVersion, c.variant, c.code),
        group_key: c.groupKey,
        entry_d: w.entryD,
        exit_d: x === null ? null : x.d,
        exit_tag: x === null ? null : x.tag,
        qty: Number(w.qty),
        fill_in_micro: w.fillInMicro,
        fill_out_micro: x === null ? null : x.fillOutMicro,
        brok_in_micro: w.brokInMicro,
        brok_out_micro: x === null ? null : x.brokOutMicro,
        stress_in_micro: w.qty * w.stressFillInMicro + w.stressBrokInMicro,
        stress_out_micro: e === null ? null : e.stressOutMicro,
        gross_num: e === null ? null : e.gross.num,
        gross_den: e === null ? null : e.gross.den,
        timed: flags.includes("assumed-time") ? 0 : 1,
        forward: 0,
      };

      let controls: ControlDraw | null = null;
      if (library !== null && e !== null) {
        const anchors = anchorsOf(c, w.refInMicro);
        if (anchors === "no_atr") {
          controls = {
            controls: [],
            forcedIdx: [],
            poolSize: 0,
            usableSize: 0,
            withReplacement: false,
            decile: null,
            note: "no_anchor_atr",
          };
        } else {
          controls = library.draw({
            rowId,
            lineage,
            family: c.family,
            signalCode: c.code,
            tier: c.tier,
            decisionIdx: idx,
            entryIdx: idx + 1,
            endIdx,
            plan: c.plan,
            anchors,
            excludeCodes: sameDay.get(c.family) ?? new Set<string>(),
            count: params.stats.c2ControlsPerRow,
          });
        }
      }
      const net = e === null ? null : e.net;
      const excess =
        net !== null && controls !== null && controls.controls.length > 0
          ? pairedExcess(
              fractionToRational(net),
              controls.controls.map((k) => fractionToRational({ num: k.net_num, den: k.net_den })),
            )
          : null;
      entries.push({
        row,
        lineage,
        family: c.family,
        ruleVersion: c.ruleVersion,
        variant: c.variant,
        code: c.code,
        decisionD: d,
        exitRule: x === null ? null : x.rule,
        net,
        stress: e === null ? null : e.stress,
        excess,
        flags: flags.sort(),
        mtm: w.mtm,
        controls,
      });
    }
  }

  entries.sort((a, b) => cmp(a.row.entry_d, b.row.entry_d) || cmp(a.row.id, b.row.id));
  return {
    market,
    from,
    to,
    sessions: sessions.length,
    entries,
    skipped,
    controlPaths: library === null ? 0 : library.memoSize(),
  };
}

/** Daily mark-to-market series of the rows matching a filter (VAL-110 v and vi). */
export function dailySeries(
  result: LedgerResult,
  filter: (e: LedgerEntry) => boolean = () => true,
): DailyPoint[] {
  return aggregateDaily(result.entries.filter(filter).map((e) => e.mtm));
}

/** Canonical bytes of a result (key-sorted JSON, bigint as text, fractions as "num/den"). */
export function serializeLedger(result: LedgerResult): string {
  return familyOutputJson(result);
}

/** SHA-256 of the serialised result: the replay's determinism digest. */
export function ledgerDigest(result: LedgerResult): string {
  return sha256Hex(canonicalJson(JSON.parse(serializeLedger(result))));
}
