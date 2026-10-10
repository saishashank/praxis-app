// Single accessor for rate-limit and session settings (SEC-014, PLT-033). Both are synchronous
// because the proxy gate and Auth.js claim checks call them synchronously: they return the
// configured value once the in-process cache is warm (60 s, refreshed in the background) and the
// registry default until then, or when the database cannot be read (PLT-041).
// Each value is sanity-checked again here, so a bad stored row can never weaken a limit to
// something unusable; it falls back to the default.
import { CONFIG_KEYS } from "@/lib/config/keys";
import { peekConfig } from "@/lib/config/runtime";

export type RateLimits = {
  signin_per_min_ip: number;
  writes_per_min_user: number;
  exports_per_hour_user: number;
};

const positiveInt = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 1 ? v : fallback;

// SEC-014 states maximums ("sign-in callback ≤ 10/min per IP; write endpoints ≤ 60/min per user;
// exports ≤ 5/hour per user"): a stored value may tighten a limit but never loosen it.
const SEC014_MAX: RateLimits = {
  signin_per_min_ip: 10,
  writes_per_min_user: 60,
  exports_per_hour_user: 5,
};

export function getRateLimits(): RateLimits {
  const d = CONFIG_KEYS.rate_limits.default;
  const v = peekConfig("rate_limits") as Partial<Record<keyof RateLimits, unknown>> | null;
  const pick = (k: keyof RateLimits) => Math.min(positiveInt(v?.[k], d[k]), SEC014_MAX[k]);
  return {
    signin_per_min_ip: pick("signin_per_min_ip"),
    writes_per_min_user: pick("writes_per_min_user"),
    exports_per_hour_user: pick("exports_per_hour_user"),
  };
}

// SEC-010: never longer than 14 days, whatever is stored.
export function getSessionMaxAgeSec(): number {
  const days = positiveInt(
    peekConfig("session_lifetime_days"),
    CONFIG_KEYS.session_lifetime_days.default,
  );
  return Math.min(days, 14) * 86400;
}
