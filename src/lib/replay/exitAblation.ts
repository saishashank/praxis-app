// ARN-106 exit ablation (M14, D-222; docs/M14_design.md 2.1). The comparator of a rule is the SAME
// entries exited by the family's unconditional time exit only: no initial stop, no trail, no other
// close-signal rule. A trailing-stop challenger is kept only if it beats this comparator on the
// development split. Pure and deterministic: a plan transform and a second ledger pass that reuses the
// first pass's family outputs (the `outputSink` / `familyOutput` hooks), so `runFamilies` runs once.
import type { ExitPlan, FamilyOutput } from "@/lib/agents/families";
import type { AgentParams } from "@/lib/agents/params";
import { replayLedger, type LedgerResult, type LedgerSource } from "./ledger";

export type FamilyOutputs = ReadonlyMap<string, Pick<FamilyOutput, "candidates" | "blocked">>;

/**
 * The plan with only its unconditional time exits kept (a CS `time_stop` without a minimum return:
 * F1 `max_hold`, F2-F6 `time_stop`). Initial stops, trails and every other CS rule are dropped.
 */
export function timeStopOnly(plan: ExitPlan): ExitPlan {
  return {
    initialStops: [],
    trails: [],
    cs: plan.cs.filter((r) => r.kind === "time_stop" && r.minReturn === null),
  };
}

/**
 * A view of a ledger source whose `familyOutput` answers from `outputs` (and whose `market` is set), so
 * a ledger pass over it never runs the rule interpreter again. Sessions not in `outputs` return null
 * and fall back to the source's own family inputs.
 */
export function withFamilyOutputs<S extends LedgerSource>(
  src: S,
  market: string,
  outputs: FamilyOutputs,
): LedgerSource {
  return new Proxy(src, {
    get(target, prop) {
      if (prop === "familyOutput") return (d: string) => outputs.get(d) ?? null;
      if (prop === "market") return market;
      const v: unknown = Reflect.get(target, prop, target);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/**
 * The comparator ledger: the same signals as the first pass (its recorded outputs), controls off,
 * every exit replaced by the time exit only. Rows pair with the rule's by (code, entry date).
 */
export function comparatorLedger(
  src: LedgerSource,
  market: string,
  params: AgentParams,
  outputs: FamilyOutputs,
): LedgerResult {
  const days = [...outputs.keys()].sort();
  return replayLedger(withFamilyOutputs(src, market, outputs), {
    params,
    ...(days.length === 0 ? {} : { from: days[0]!, to: days[days.length - 1]! }),
    controls: false,
    exitTransform: timeStopOnly,
  });
}
