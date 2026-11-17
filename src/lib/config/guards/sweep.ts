// The intraday-sweep switch guard (intraday_sweep_enabled, AGT-147, D-1445; M22 E5, D-1443): "on" is refused while the batch
// quote source's register row (`yahoo_delayed_batch`) is not accepted (status `enabled`). Fails closed: a failed read refuses.
// "off" and every other value pass. Read only: one primary-key probe.
import type { Guard } from "../switchGuards";
import { sweepAccepted } from "@/lib/intraday/sweep";

export const SWEEP_REFUSAL =
  "The midday sweep needs its batch price source accepted first; accept the source's terms, then switch this on";

export const sweepGuard: Guard = async (db, value) =>
  value === "on" ? ((await sweepAccepted(db)) ? null : SWEEP_REFUSAL) : null;
