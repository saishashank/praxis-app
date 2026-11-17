// The intraday-sweep switch guard (intraday_sweep_enabled, AGT-147, D-1445): a pass-through stub in M22 A2, owned later by the
// sweep task.
import type { Guard } from "../switchGuards";

export const sweepGuard: Guard = async () => null;
