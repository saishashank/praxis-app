// The live-roles guard (llm_live_roles, D-1401, D-1445): a pass-through stub in M22 A2. Task L1 owns it and will refuse a role
// that has no passing bake-off; until then every valid value passes (the key's own validator checks the names).
import type { Guard } from "../switchGuards";

export const liveRolesGuard: Guard = async () => null;
