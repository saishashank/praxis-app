// The alt-input switch guard (regime_altinputs_enabled, D-945, D-1445): a pass-through stub in M22 A2, owned later by the
// alt-input task.
import type { Guard } from "../switchGuards";

export const regimeAltGuard: Guard = async () => null;
