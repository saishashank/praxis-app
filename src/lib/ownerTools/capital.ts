// The Owner's own amount (M21 B1, UXN-315, D-1217): a whole number of home-currency units, 0 to 10,000,000 (0 = not set).
// Typed text only; the preference service validates it again. Commas and spaces in a typed amount are ignored.
import { REAL_CAPITAL_MAX } from "@/lib/preferences/service";

/** The whole amount of a typed value, or null when it is not a whole number in range. */
export function parseCapital(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/[,\s]/g, "");
  if (!/^[0-9]{1,8}$/.test(t)) return null;
  const n = Number(t); // money-float-ok: a whole amount of at most eight digits, bounded below
  return Number.isSafeInteger(n) && n >= 0 && n <= REAL_CAPITAL_MAX ? n : null;
}
