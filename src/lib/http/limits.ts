// Single accessor for rate-limit settings (SEC-014). Uses the registry default for now; it can
// switch to the main-DB config store later without touching callers.
import { CONFIG_KEYS } from "@/lib/config/keys";

export type RateLimits = {
  signin_per_min_ip: number;
  writes_per_min_user: number;
  exports_per_hour_user: number;
};

export function getRateLimits(): RateLimits {
  return CONFIG_KEYS.rate_limits.default;
}

export function getSessionMaxAgeSec(): number {
  return CONFIG_KEYS.session_lifetime_days.default * 86400;
}
