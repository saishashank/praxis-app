// The MiniLM switch guard (minilm_enabled, D-946, D-1445): a pass-through stub in M22 A2, owned later by the MiniLM task.
import type { Guard } from "../switchGuards";

export const minilmGuard: Guard = async () => null;
