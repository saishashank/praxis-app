// Owner action: confirm that a quarantined code is the SAME company listed again (V1-S7, D-685/D-686).
// HIGH RISK (it lets a delisted instrument back into the universe, so its old bars feed ADV, tiers and
// indicators): Owner-only, explicit confirmation, audit first, ONE main-DB transaction (the
// src/lib/data/controls.ts `commit` runner: audit event in the auth DB first, `_failed` event when the
// write fails). Only a status column changes: `delist_reason` goes from `code_reuse_suspected:<old>` to
// `relist_confirmed:<audit ref>:<old>`. The next universe import then reactivates the code through the
// ordinary rule. A code that is NOT the same company is simply left delisted (the quarantine is the
// outcome); a genuinely new company under a reused code needs its own instrument identity, which is a
// schema change (see docs/M13L_design.md, Batch A, D-686).
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
import { RELIST_CONFIRMED, REUSE_SUSPECTED } from "@/lib/data/universe/apply.mjs";
import { UNIVERSE_MARKET } from "@/lib/data/universe/import";

export type ConfirmRelistingInput = ControlBase & { code: unknown; confirm: unknown };

const CODE_RE = /^[A-Z0-9]{1,6}$/; // threshold-ok: ASX code shape

export async function confirmRelisting(p: ConfirmRelistingInput): Promise<ControlResult> {
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
  if (reason !== null && reason.startsWith(RELIST_CONFIRMED)) return NOOP;
  if (reason === null || !reason.startsWith(REUSE_SUSPECTED)) return fail("not_available");
  const prior = reason.slice(REUSE_SUSPECTED.length + 1);
  return commit(p, now, {
    action: "data.relisting_confirmed",
    targetType: "instrument",
    targetId: `${UNIVERSE_MARKET}:${code}`,
    detail: { code, day: marketDate(new Date(now), "Australia/Melbourne"), prior },
    apply: async (tx, auditRef) => {
      const u = await tx.execute({
        sql: `UPDATE instrument SET delist_reason = ?
              WHERE market = ? AND code = ? AND delisted_on IS NOT NULL AND delist_reason = ?`,
        args: [`${RELIST_CONFIRMED}:${auditRef}:${prior}`, UNIVERSE_MARKET, code, reason],
      });
      if (u.rowsAffected !== 1) throw new Precondition("not_available");
    },
  });
}
