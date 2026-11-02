// Owner action: confirm that a quarantined code is the SAME company listed again (V1-S7, D-685/D-686).
// HIGH RISK (it lets a delisted instrument back into the universe, so its old bars feed ADV, tiers and
// indicators): Owner-only, explicit confirmation, audit first, ONE main-DB transaction (the
// src/lib/data/controls.ts `commit` runner: audit event in the auth DB first, `_failed` event when the
// write fails). Only a status column changes: `delist_reason` goes from `code_reuse_suspected:<old>` to
// `relist_confirmed:<audit ref>:<old>`. The next universe import then reactivates the code through the
// ordinary rule. `confirmCodeReuse` is the other decision: it is a DIFFERENT company; `reuse_confirmed`
// makes the next import reactivate the code AND write an `instrument_listing` row (migration 0025), so
// every lookback stops at the new listing's start (src/lib/data/listing.ts). Leaving a code quarantined
// is the third outcome: it stays out. See docs/M13L_design.md, Batch A, D-686 and D-760..D-764.
import {
  commit,
  fail,
  NOOP,
  ownerCheck,
  Precondition,
  type ControlBase,
  type ControlResult,
} from "@/lib/data/controls";
import { marketDate } from "@/lib/data/calendar";
import { RELIST_CONFIRMED, REUSE_CONFIRMED, REUSE_SUSPECTED } from "@/lib/data/universe/apply.mjs";
import { UNIVERSE_MARKET } from "@/lib/data/universe/import";

export type ConfirmRelistingInput = ControlBase & { code: unknown; confirm: unknown };

const CODE_RE = /^[A-Z0-9]{1,6}$/; // threshold-ok: ASX code shape

/** The Owner's decision on a quarantined code: the same company again, or a different one (code reuse). */
export const confirmRelisting = (p: ConfirmRelistingInput): Promise<ControlResult> =>
  decide(p, RELIST_CONFIRMED, "data.relisting_confirmed");
/** ... a DIFFERENT company: the next import reactivates it with a new listing, so histories stay apart (0025). */
export const confirmCodeReuse = (p: ConfirmRelistingInput): Promise<ControlResult> =>
  decide(p, REUSE_CONFIRMED, "data.code_reuse_confirmed");

async function decide(
  p: ConfirmRelistingInput,
  prefix: string,
  action: string,
): Promise<ControlResult> {
  const denied = await ownerCheck(p.authDb, p.actorId);
  if (denied !== null) return fail(denied);
  if (typeof p.code !== "string" || !CODE_RE.test(p.code)) return fail("invalid");
  if (p.confirm !== true) return fail("confirm_required");
  const code = p.code;
  const now = (p.now ?? new Date()).toISOString();
  let reason: string | null;
  try {
    const r = await p.mainDb.execute({
      sql: "SELECT delisted_on, delist_reason FROM instrument WHERE market = ? AND code = ?",
      args: [UNIVERSE_MARKET, code],
    });
    if (r.rows.length === 0) return fail("unknown_code");
    reason = r.rows[0]!.delist_reason === null ? null : String(r.rows[0]!.delist_reason);
    if (r.rows[0]!.delisted_on === null) return fail("not_available");
  } catch {
    return fail("unavailable");
  }
  if (reason !== null && reason.startsWith(prefix)) return NOOP;
  if (reason === null || !reason.startsWith(REUSE_SUSPECTED)) return fail("not_available");
  const prior = reason.slice(REUSE_SUSPECTED.length + 1);
  return commit(p, now, {
    action,
    targetType: "instrument",
    targetId: `${UNIVERSE_MARKET}:${code}`,
    detail: { code, day: marketDate(new Date(now), "Australia/Melbourne"), prior },
    apply: async (tx, auditRef) => {
      const u = await tx.execute({
        sql: `UPDATE instrument SET delist_reason = ?
              WHERE market = ? AND code = ? AND delisted_on IS NOT NULL AND delist_reason = ?`,
        args: [`${prefix}:${auditRef}:${prior}`, UNIVERSE_MARKET, code, reason],
      });
      if (u.rowsAffected !== 1) throw new Precondition("not_available");
    },
  });
}
