// R2-S2 (D-800 series, supersedes the "approval is a code change" part of D-710): the Owner's
// attestation that the [VERIFY] money figures (moneyConstants.ts) are approved is DATA, not code.
// One append-only `config_version` row (key `money_constants_approved`, scope global) written by the
// audit-first Owner control below. The interlock (interlock.ts) accepts `full` in production when the
// latest row names every figure that is still unverified in code. The compile-time `verified` flags
// stay informational (staging message, Health "Money figures" line, the go-live page list). A figure
// ADDED to the code later is not in the attested list, so it blocks `full` again until re-attested.
// No migration: config_version is append-only already. No secret is stored; `reason` carries the
// audit reference.
import {
  commit,
  fail,
  NOOP,
  ownerCheck,
  type ControlBase,
  type ControlResult,
} from "@/lib/data/controls";
import { moneyConstants } from "./moneyConstants";
import { MONEY_APPROVAL_KEY, readMoneyApproval } from "./moneyApprovalRead";

export const MONEY_APPROVAL_PHRASE = "APPROVE MONEY FIGURES";
export { MONEY_APPROVAL_KEY, readMoneyApproval, uncoveredByApproval } from "./moneyApprovalRead";

export type ApproveInput = ControlBase & {
  /** The ids the Owner saw on the page; must equal the figures currently listed in code. */
  ids: unknown;
  confirmation: unknown;
};

/**
 * Error codes: forbidden, invalid, confirm_required, unavailable. Nothing is audited or written for
 * a refusal. Approving what is already attested changes nothing.
 */
export async function approveMoneyConstants(p: ApproveInput): Promise<ControlResult> {
  const now = (p.now ?? new Date()).toISOString();
  const denied = await ownerCheck(p.authDb, p.actorId);
  if (denied) return fail(denied);
  const current = moneyConstants()
    .map((c) => c.id)
    .sort();
  if (!Array.isArray(p.ids) || !p.ids.every((x) => typeof x === "string")) return fail("invalid");
  const seen = [...(p.ids as string[])].sort();
  if (seen.length !== current.length || seen.some((x, i) => x !== current[i])) {
    return fail("invalid");
  }
  if (p.confirmation !== MONEY_APPROVAL_PHRASE) return fail("confirm_required");
  try {
    const have = await readMoneyApproval(p.mainDb);
    if (have !== null && current.every((id) => have.ids.includes(id))) return NOOP;
    return await commit(p, now, {
      action: "golive.money_constants_approved",
      targetType: "control",
      targetId: MONEY_APPROVAL_KEY,
      detail: { ids: current },
      apply: async (tx, auditRef) => {
        const prev = await tx.execute({
          sql:
            "SELECT value_json FROM config_version WHERE key = ? AND scope = 'global' " +
            "ORDER BY id DESC LIMIT 1",
          args: [MONEY_APPROVAL_KEY],
        });
        await tx.execute({
          sql:
            "INSERT INTO config_version (key, scope, value_json, previous_json, " +
            "changed_by_user_id, changed_at, reason) VALUES (?, 'global', ?, ?, ?, ?, ?)",
          args: [
            MONEY_APPROVAL_KEY,
            JSON.stringify({ ids: current }),
            prev.rows.length > 0 ? String(prev.rows[0]!.value_json) : null,
            p.actorId,
            now,
            `Owner approved the money figures (${auditRef})`,
          ],
        });
      },
    });
  } catch {
    return fail("unavailable");
  }
}
