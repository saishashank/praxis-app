// The live-roles guard (llm_live_roles, M22 L1, LLM-077, D-1401, D-1445). Adding a job to the list is refused unless the
// bake-off index holds a PASS for it (R3 and R5 follow the words verdict, D-1402). Removing a job, or keeping the list as
// it is, always passes. Read-only, fails closed: a value that is not a list, or a list that cannot be compared with the
// stored one, refuses. The index is the generated module, so no database read other than the stored list is made.
import { getConfig } from "../store";
import { BAKEOFF_INDEX } from "@/lib/llm/bakeoffIndex.generated";
import { gateOf } from "@/lib/llm/roster";
import type { Guard } from "../switchGuards";

/** The refusal text (plain words, no job code). */
export const LIVE_ROLE_REFUSAL = "This writing task has not passed its test run yet";

/** Null when `value` may be stored now, else the refusal text. */
export const liveRolesGuard: Guard = async (db, value) => {
  if (!Array.isArray(value) || !value.every((x) => typeof x === "string")) return LIVE_ROLE_REFUSAL;
  let current: readonly unknown[];
  try {
    const stored = await getConfig(db, "llm_live_roles");
    if (!Array.isArray(stored)) return LIVE_ROLE_REFUSAL;
    current = stored;
  } catch {
    return LIVE_ROLE_REFUSAL;
  }
  for (const role of value as string[]) {
    if (current.includes(role)) continue;
    const gate = gateOf(role);
    const verdict = gate === null ? undefined : BAKEOFF_INDEX[gate];
    if (!verdict || verdict.verdict !== "PASS" || verdict.models.length === 0)
      return LIVE_ROLE_REFUSAL;
  }
  return null;
};
