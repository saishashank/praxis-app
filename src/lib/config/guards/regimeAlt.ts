// The alt-input switch guard (regime_altinputs_enabled, D-945, D-1445; M22 E5, D-1441): the switch changes the Cortex display
// only (the gate never reads it), so "on" is allowed once the shadow table can be read. Fails closed: a failed read refuses.
// "off" and every other value pass.
import type { Guard } from "../switchGuards";

export const REGIME_ALT_REFUSAL =
  "The market-mood check with outside signals cannot be shown yet: its stored readings could not be read";

export const regimeAltGuard: Guard = async (db, value) => {
  if (value !== "on") return null;
  try {
    // rows-ok: regime_alt_reading primary key probe, LIMIT 1
    await db.execute("SELECT 1 FROM regime_alt_reading LIMIT 1");
    return null;
  } catch {
    return REGIME_ALT_REFUSAL;
  }
};
