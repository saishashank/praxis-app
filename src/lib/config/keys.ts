// Typed registry of configuration keys (spec ch.15). Values are stored as JSON in config_version.
// Spec refs cite spec/15_configuration_reference.md line numbers.

export type ConfigKeyDef = {
  default: unknown;
  unit: string;
  editable: "O" | "fixed"; // O = Owner-editable
  ref: string;
  // Returns an error text for an invalid value, or null. `get` reads another key's effective value.
  validate: (v: unknown, get: (key: ConfigKey) => Promise<unknown>) => Promise<string | null>;
};

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const intRange =
  (min: number, max = Infinity) =>
  async (v: unknown) =>
    isInt(v) && v >= min && v <= max ? null : `must be a whole number from ${min} to ${max}`;

function exactKeys(v: unknown, keys: string[]): v is Record<string, unknown> {
  return isObj(v) && Object.keys(v).sort().join() === [...keys].sort().join();
}

const never = async () => "this setting is fixed";

export const CONFIG_KEYS = {
  // Line 145: retention (logs 30 d, runs 180 d, news 400 d), Edit O, no bounds given; DAT-142.
  retention_logs_days: {
    default: 30,
    unit: "days",
    editable: "O",
    ref: "DAT-142",
    validate: intRange(1),
  },
  retention_runs_days: {
    default: 180,
    unit: "days",
    editable: "O",
    ref: "DAT-142",
    validate: intRange(1),
  },
  retention_news_days: {
    default: 400,
    unit: "days",
    editable: "O",
    ref: "DAT-142",
    validate: intRange(1),
  },
  // Line 146: backup retention 14 daily / 8 weekly / 12 monthly, Edit O; PLT-022b.
  backup_retention: {
    default: { daily: 14, weekly: 8, monthly: 12 },
    unit: "copies",
    editable: "O",
    ref: "PLT-022b",
    validate: async (v) =>
      exactKeys(v, ["daily", "weekly", "monthly"]) &&
      Object.values(v).every((x) => isInt(x) && x >= 1)
        ? null
        : "daily, weekly and monthly must each be a whole number of at least 1",
  },
  // Line 143: storage_warn_gb 2.5 GB, O; DAT-141.
  storage_warn_gb: {
    default: 2.5,
    unit: "GB",
    editable: "O",
    ref: "DAT-141",
    validate: async (v, get) => {
      if (!isNum(v) || v <= 0) return "must be greater than 0";
      const ceiling = await get("storage_ceiling_gb");
      return isNum(ceiling) && v > ceiling ? "must not exceed the storage ceiling" : null;
    },
  },
  // Line 144: storage_ceiling_gb 3 GB, O; DAT-141.
  storage_ceiling_gb: {
    default: 3,
    unit: "GB",
    editable: "O",
    ref: "DAT-141",
    validate: async (v, get) => {
      if (!isNum(v) || v <= 0) return "must be greater than 0";
      const warn = await get("storage_warn_gb");
      return isNum(warn) && v < warn ? "must not be below the storage warning" : null;
    },
  },
  // Line 155: quota thresholds 70/90/95% per period, O; PLT-051.
  quota_thresholds: {
    default: { notice: 0.7, alert: 0.9, degrade: 0.95 },
    unit: "fraction",
    editable: "O",
    ref: "PLT-051",
    validate: async (v) => {
      if (!exactKeys(v, ["notice", "alert", "degrade"])) return "needs notice, alert and degrade";
      const { notice, alert, degrade } = v;
      return isNum(notice) &&
        isNum(alert) &&
        isNum(degrade) &&
        notice > 0 &&
        notice < alert &&
        alert < degrade &&
        degrade <= 1
        ? null
        : "must satisfy 0 < notice < alert < degrade <= 1";
    },
  },
  // Line 160: session_lifetime 14 days, O; PLT-033; SEC-010 lifetime <= 14 days.
  session_lifetime_days: {
    default: 14,
    unit: "days",
    editable: "O",
    ref: "PLT-033",
    validate: intRange(1, 14),
  },
  // Line 161: sign-in 10/min/IP, writes 60/min/user, exports 5/h/user, O; SEC-014.
  rate_limits: {
    default: { signin_per_min_ip: 10, writes_per_min_user: 60, exports_per_hour_user: 5 },
    unit: "count",
    editable: "O",
    ref: "SEC-014",
    validate: async (v) =>
      exactKeys(v, ["signin_per_min_ip", "writes_per_min_user", "exports_per_hour_user"]) &&
      Object.values(v).every((x) => isInt(x) && x >= 1)
        ? null
        : "every limit must be a whole number of at least 1",
  },
  // Line 162: hmac_max_age 300 s, Edit "-" (fixed); SEC-017.
  hmac_max_age_s: {
    default: 300,
    unit: "s",
    editable: "fixed",
    ref: "SEC-017",
    validate: never,
  },
  // Line 175: token_warning_days 14 / 7 / 2, O; SEC-021.
  token_warning_days: {
    default: [14, 7, 2],
    unit: "days",
    editable: "O",
    ref: "SEC-021",
    validate: async (v) =>
      Array.isArray(v) &&
      v.length > 0 &&
      v.every((x, i) => isInt(x) && x >= 1 && (i === 0 || x < v[i - 1]))
        ? null
        : "must be a non-empty, strictly descending list of whole days",
  },
  // Line 166: what_if_daily_limit_per_user 5, bounds 0-20, O; ROL-102a.
  what_if_daily_limit_per_user: {
    default: 5,
    unit: "count per user",
    editable: "O",
    ref: "ROL-102a",
    validate: intRange(0, 20),
  },
  // Line 156: sentinel_blind_alert 15 min, O; PLT-018.
  sentinel_blind_alert_min: {
    default: 15,
    unit: "min",
    editable: "O",
    ref: "PLT-018",
    validate: intRange(1),
  },
  // Line 142: turso ceilings (storage 3 GB, writes 6M/month, reads 300M/month, staging <= 15%); DAT-141.
  turso_writes_ceiling_month: {
    default: 6_000_000,
    unit: "rows/month",
    editable: "O",
    ref: "DAT-141",
    validate: intRange(1),
  },
  turso_reads_ceiling_month: {
    default: 300_000_000,
    unit: "rows/month",
    editable: "O",
    ref: "DAT-141",
    validate: intRange(1),
  },
  turso_staging_share: {
    default: 0.15,
    unit: "fraction",
    editable: "O",
    ref: "DAT-141",
    validate: async (v) =>
      isNum(v) && v > 0 && v <= 1 ? null : "must be greater than 0 and at most 1",
  },
  // Line 154: actions_minutes_soft_ceiling 3,000/month, O; PLT-014 (warns only, PLT-051).
  actions_minutes_soft_ceiling: {
    default: 3000,
    unit: "min/month",
    editable: "O",
    ref: "PLT-014",
    validate: intRange(1),
  },
  // Line 187: llm_daily_budget_total 150,000 tokens, bounds 75,000-225,000, O; LLM-050.
  llm_daily_budget_total: {
    default: 150_000,
    unit: "tokens/day",
    editable: "O",
    ref: "LLM-050",
    validate: intRange(75_000, 225_000),
  },
  // Architect decision 8 (D-057): ch.15 has no Yahoo throttle row (spec gap, M2_requirements s4);
  // Owner-editable, bounds 10-500. Used by scripts/ingest/yahoo_fetch.py (DAT-120, DAT-103).
  yahoo_chunk_size: {
    default: 100,
    unit: "tickers/request",
    editable: "O",
    ref: "DAT-120",
    validate: intRange(10, 500),
  },
  // Architect decision 8 (D-057): minimum pause between Yahoo chunk requests, bounds 1-60.
  yahoo_min_gap_s: {
    default: 5,
    unit: "s",
    editable: "O",
    ref: "DAT-120",
    validate: intRange(1, 60),
  },
  // NFR-030 / DAT-142: email and name are hashed 90 days after revocation. Fixed, not in ch.15.
  pii_hash_after_revocation_days: {
    default: 90,
    unit: "days",
    editable: "fixed",
    ref: "NFR-030",
    validate: never,
  },
} satisfies Record<string, ConfigKeyDef>;

export type ConfigKey = keyof typeof CONFIG_KEYS;

export function isConfigKey(k: string): k is ConfigKey {
  return Object.prototype.hasOwnProperty.call(CONFIG_KEYS, k);
}

// Display metadata for the Owner Configuration page (UX-116). Kept apart from CONFIG_KEYS so the
// registry itself stays a pure description of values and validators.
export type ConfigArea = "Retention" | "Quotas" | "Sessions & limits" | "Backups" | "Other";
export type ConfigInput = "int" | "number" | "list" | "object";
export type ConfigMeta = { label: string; area: ConfigArea; bounds: string; input: ConfigInput };

export const CONFIG_AREAS: ConfigArea[] = [
  "Retention",
  "Quotas",
  "Sessions & limits",
  "Backups",
  "Other",
];

export const CONFIG_META: Record<ConfigKey, ConfigMeta> = {
  retention_logs_days: {
    label: "Keep application logs for",
    area: "Retention",
    bounds: "whole days, at least 1",
    input: "int",
  },
  retention_runs_days: {
    label: "Keep job run records for",
    area: "Retention",
    bounds: "whole days, at least 1",
    input: "int",
  },
  retention_news_days: {
    label: "Keep news items for",
    area: "Retention",
    bounds: "whole days, at least 1",
    input: "int",
  },
  pii_hash_after_revocation_days: {
    label: "Hash a revoked user's email and name after",
    area: "Retention",
    bounds: "fixed",
    input: "int",
  },
  backup_retention: {
    label: "Backups kept (daily, weekly, monthly)",
    area: "Backups",
    bounds: "each a whole number, at least 1",
    input: "object",
  },
  storage_warn_gb: {
    label: "Database storage warning",
    area: "Quotas",
    bounds: "above 0, not above the storage ceiling",
    input: "number",
  },
  storage_ceiling_gb: {
    label: "Database storage ceiling",
    area: "Quotas",
    bounds: "above 0, not below the storage warning",
    input: "number",
  },
  quota_thresholds: {
    label: "Quota notice, alert and degrade levels",
    area: "Quotas",
    bounds: "0 < notice < alert < degrade <= 1",
    input: "object",
  },
  turso_writes_ceiling_month: {
    label: "Database writes ceiling",
    area: "Quotas",
    bounds: "whole number, at least 1",
    input: "int",
  },
  turso_reads_ceiling_month: {
    label: "Database reads ceiling",
    area: "Quotas",
    bounds: "whole number, at least 1",
    input: "int",
  },
  turso_staging_share: {
    label: "Staging share of the database limits",
    area: "Quotas",
    bounds: "above 0, at most 1",
    input: "number",
  },
  actions_minutes_soft_ceiling: {
    label: "GitHub Actions soft ceiling",
    area: "Quotas",
    bounds: "whole number, at least 1",
    input: "int",
  },
  llm_daily_budget_total: {
    label: "Daily LLM token budget",
    area: "Quotas",
    bounds: "75,000 to 225,000",
    input: "int",
  },
  session_lifetime_days: {
    label: "Sign-in session lifetime",
    area: "Sessions & limits",
    bounds: "1 to 14 days",
    input: "int",
  },
  rate_limits: {
    label: "Rate limits (sign-ins, writes, exports)",
    area: "Sessions & limits",
    bounds: "each a whole number, at least 1",
    input: "object",
  },
  hmac_max_age_s: {
    label: "Signed-request maximum age",
    area: "Sessions & limits",
    bounds: "fixed",
    input: "int",
  },
  token_warning_days: {
    label: "Token expiry warnings (days before)",
    area: "Other",
    bounds: "strictly descending whole days",
    input: "list",
  },
  what_if_daily_limit_per_user: {
    label: "What-if runs per user per day",
    area: "Other",
    bounds: "0 to 20",
    input: "int",
  },
  sentinel_blind_alert_min: {
    label: "Sentinel blind alert after",
    area: "Other",
    bounds: "whole minutes, at least 1",
    input: "int",
  },
  yahoo_chunk_size: {
    label: "Yahoo tickers per request",
    area: "Other",
    bounds: "whole number, 10 to 500",
    input: "int",
  },
  yahoo_min_gap_s: {
    label: "Pause between Yahoo requests",
    area: "Other",
    bounds: "whole seconds, 1 to 60",
    input: "int",
  },
};
