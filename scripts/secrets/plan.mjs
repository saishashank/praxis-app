// Plans one secret update for the Owner's secrets tool (scripts/secrets/secrets.mjs): which values
// are needed and every place each one is written. Pure: no process, no network and never a value.
// The rows are the secret -> stores table in src/lib/security/secretStores.ts (the one source the
// rotation guide is generated from) plus CONFIG_ROWS below, the non-secret settings that live in
// the same stores. A "group" is ONE value: one logical name in one environment, written to every
// store that holds it. GitHub names end in _PROD / _STAGING; Vercel and Worker names do not.

/** Short store names on the command line -> StoreKind in secretStores.ts. */
export const STORE_ALIASES = {
  github: "github-env",
  vercel: "vercel-env",
  worker: "cloudflare-worker",
};

/** Rows whose values are random 64 hex characters: the tool makes them unless --paste is given. */
export const GENERATED_ROWS = new Set(["c1", "c2", "c3", "c4", "pii"]);

const WORKER_PROD = "Cloudflare Worker `praxis-sentinel` (production)";
const WORKER_STG = "Cloudflare Worker `praxis-sentinel-staging`";
const VERCEL_PROD = "Vercel project `praxis-app`, environment variables (Production)";
const VERCEL_STG = "Vercel project `praxis-app-staging`, environment variables (Production)";
const GH = (e) => `GitHub environment \`${e}\``;
const slot = (env, store, holder, names) => ({ env, store, holder, names });

/** Settings that are not credentials but sit in the same stores (NON_ROTATING_SECRET_NAMES). */
export const CONFIG_ROWS = [
  {
    id: "turso-main-url",
    title: "Turso main-database address (libsql://...)",
    handling: "config",
    issuer: "Turso dashboard: the database page shows the URL",
    slots: [
      slot("production", "github-env", GH("production"), ["TURSO_MAIN_URL_PROD"]),
      slot("production", "vercel-env", VERCEL_PROD, ["TURSO_MAIN_URL"]),
      slot("production", "cloudflare-worker", WORKER_PROD, ["TURSO_MAIN_URL"]),
      slot("staging", "github-env", GH("staging"), ["TURSO_MAIN_URL_STAGING"]),
      slot("staging", "vercel-env", VERCEL_STG, ["TURSO_MAIN_URL"]),
      slot("staging", "cloudflare-worker", WORKER_STG, ["TURSO_MAIN_URL"]),
    ],
  },
  {
    id: "turso-auth-url",
    title: "Turso auth-database address (libsql://...)",
    handling: "config",
    issuer: "Turso dashboard: the database page shows the URL",
    slots: [
      slot("production", "vercel-env", VERCEL_PROD, ["TURSO_AUTH_URL"]),
      slot("staging", "vercel-env", VERCEL_STG, ["TURSO_AUTH_URL"]),
    ],
  },
  {
    id: "app-base-url",
    title: "Public address of the app (https://..., no path)",
    handling: "config",
    issuer: "Vercel: the project's production domain",
    slots: [
      slot("production", "github-env", GH("production"), ["APP_BASE_URL_PROD"]),
      slot("production", "vercel-env", VERCEL_PROD, ["APP_BASE_URL"]),
      slot("staging", "github-env", GH("staging"), ["APP_BASE_URL_STAGING"]),
      slot("staging", "vercel-env", VERCEL_STG, ["APP_BASE_URL"]),
    ],
  },
  {
    id: "owner-email",
    title: "Your sign-in email address",
    handling: "config",
    issuer: "You",
    slots: [
      slot("production", "github-env", GH("production"), ["OWNER_EMAIL_PROD"]),
      slot("production", "vercel-env", VERCEL_PROD, ["OWNER_EMAIL"]),
      slot("staging", "github-env", GH("staging"), ["OWNER_EMAIL_STAGING"]),
      slot("staging", "vercel-env", VERCEL_STG, ["OWNER_EMAIL"]),
    ],
  },
  {
    id: "owner-recovery-email",
    title: "Break-glass recovery email address",
    handling: "config",
    issuer: "You",
    slots: [
      slot("production", "github-env", GH("production"), ["OWNER_RECOVERY_EMAIL_PROD"]),
      slot("production", "vercel-env", VERCEL_PROD, ["OWNER_RECOVERY_EMAIL"]),
    ],
  },
  {
    id: "google-oauth-id",
    title: "Google OAuth client id (not secret; the secret is row j)",
    handling: "config",
    issuer: "Google Cloud Console, APIs and Services, Credentials",
    slots: [
      slot("production", "vercel-env", VERCEL_PROD, ["AUTH_GOOGLE_ID"]),
      slot("staging", "vercel-env", VERCEL_STG, ["AUTH_GOOGLE_ID"]),
    ],
  },
  {
    id: "cloudflare-account-id",
    title: "Cloudflare account id (one account per environment)",
    handling: "config",
    issuer: "Cloudflare dashboard: the id in the address bar",
    slots: [
      slot("production", "github-env", GH("deploy-production"), ["CLOUDFLARE_ACCOUNT_ID_PROD"]),
      slot("staging", "github-env", GH("deploy-staging"), ["CLOUDFLARE_ACCOUNT_ID_STAGING"]),
    ],
  },
];

/** Named bundles. `stores` narrows a pick to some stores (e.g. only the Worker's copy). */
export const PRESETS = {
  worker: {
    title:
      "Production Worker: dispatch token, Worker signing secret (Worker and Vercel), Turso address and token on the Worker",
    env: "production",
    picks: [
      { sel: "b" },
      { sel: "c2" },
      { sel: "d", stores: ["cloudflare-worker"] },
      { sel: "turso-main-url", stores: ["cloudflare-worker"] },
    ],
  },
};

/** WORKER_HMAC_SECRET, ACTIONS_HMAC_SECRET_PROD -> ACTIONS_HMAC_SECRET. */
export const logicalName = (name) => name.replace(/_(PROD|STAGING)$/, "");

/** The value checks, by logical name. The first match wins; `any` = one token, no spaces. */
const CHECK_RULES = [
  [
    /^(GITHUB_DISPATCH_TOKEN|DATA_REPO_TOKEN|FIXTURES_READ_TOKEN|GITHUB_READ_TOKEN)$/,
    "github-token",
  ],
  [/^(TURSO_MAIN_TOKEN|TURSO_AUTH_TOKEN|TURSO_PLATFORM_TOKEN_TEMP)$/, "jwt"],
  [/^TURSO_(MAIN|AUTH)_URL$/, "libsql-url"],
  [/^APP_BASE_URL$/, "https-origin"],
  [/EMAIL$/, "email"],
  [/^RESEND_API_KEY$/, "resend-key"],
  [/^BACKUP_PUBLIC_KEY$/, "age-public-key"],
];

export const CHECKS = {
  hex64: (v) => /^[0-9a-f]{64}$/.test(v),
  "github-token": (v) => /^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test(v),
  jwt: (v) => /^[\w-]+\.[\w-]+\.[\w-]+$/.test(v),
  "libsql-url": (v) => /^libsql:\/\/[a-z0-9.-]+$/i.test(v),
  "https-origin": (v) => /^https:\/\/[a-z0-9.-]+$/i.test(v),
  email: (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v),
  "resend-key": (v) => /^re_[A-Za-z0-9_]+$/.test(v),
  "age-public-key": (v) => /^age1[0-9a-z]{20,}$/.test(v),
  any: (v) => v.length > 0 && !/\s/.test(v),
};

export function checkFor(rowId, logical) {
  if (GENERATED_ROWS.has(rowId)) return "hex64";
  for (const [re, kind] of CHECK_RULES) if (re.test(logical)) return kind;
  return "any";
}

/** The GitHub environment named in a slot holder ("GitHub environment `production`"). */
export function githubEnvOf(holder) {
  const m = /`([^`]+)`/.exec(holder);
  if (!m) throw new Error(`no environment name in "${holder}"`);
  return m[1];
}

function writesOf(s) {
  return s.names.map((name) => {
    const w = { store: s.store, env: s.env, name };
    if (s.store === "github-env") w.githubEnv = githubEnvOf(s.holder);
    return w;
  });
}

/** Expand command-line words into picks: a preset, a row id or a stored name. */
export function resolvePicks(words, rows, stores) {
  const picks = [];
  for (const word of words) {
    const preset = PRESETS[word];
    if (preset) {
      for (const p of preset.picks) picks.push({ ...p, env: preset.env, from: word });
      continue;
    }
    if (rows.some((r) => r.id === word)) {
      picks.push({ sel: word, stores });
      continue;
    }
    const logical = logicalName(word);
    const hit = rows.some((r) =>
      r.slots.some((s) => s.names.some((n) => logicalName(n) === logical)),
    );
    if (!hit)
      throw new Error(
        `unknown secret "${word}": use a row id, a preset or a stored name (see list)`,
      );
    picks.push({ sel: word, byName: logical, stores });
  }
  return picks;
}

/**
 * The update plan. `env` is production, staging or all (a preset brings its own). Returns
 * { groups, skipped }: each group is one value and the writes it goes to.
 */
export function planUpdate(rows, words, { env = "production", stores, paste = false } = {}) {
  const groups = new Map();
  const skipped = [];
  for (const pick of resolvePicks(words, rows, stores)) {
    const wantEnv = pick.env ?? env;
    const matched = pick.byName
      ? rows.filter((r) => r.slots.some((s) => s.names.some((n) => logicalName(n) === pick.byName)))
      : rows.filter((r) => r.id === pick.sel);
    for (const row of matched) {
      if (row.slots.length === 0) {
        skipped.push({ rowId: row.id, reason: `${row.handling}: not held in any store` });
        continue;
      }
      for (const s of row.slots) {
        if (wantEnv !== "all" && s.env !== wantEnv) continue;
        if (s.store === "offline" || s.store === "agent-config") {
          skipped.push({ rowId: row.id, reason: `${s.names.join(", ")}: ${s.holder}` });
          continue;
        }
        if (pick.stores && !pick.stores.includes(s.store)) continue;
        for (const w of writesOf(s)) {
          const logical = logicalName(w.name);
          if (pick.byName && logical !== pick.byName) continue;
          const key = `${s.env}:${logical}`;
          let g = groups.get(key);
          if (!g) {
            const check = checkFor(row.id, logical);
            g = {
              key,
              env: s.env,
              logical,
              rowId: row.id,
              title: row.title,
              issuer: row.issuer,
              source: GENERATED_ROWS.has(row.id) && !paste ? "generate" : "paste",
              check,
              expiryKey: row.expiry?.tracked ? row.expiry.key : null,
              writes: [],
            };
            groups.set(key, g);
          }
          const id = `${w.store}|${w.githubEnv ?? ""}|${w.env}|${w.name}`;
          if (!g.writes.some((x) => `${x.store}|${x.githubEnv ?? ""}|${x.env}|${x.name}` === id)) {
            g.writes.push(w);
          }
        }
      }
    }
  }
  return { groups: [...groups.values()], skipped };
}

/** One line per write, for the plan print-out (names and places only). */
export function describeWrite(w) {
  if (w.store === "github-env") return `GitHub env ${w.githubEnv}: ${w.name}`;
  if (w.store === "vercel-env")
    return `Vercel ${w.env === "production" ? "praxis-app" : "praxis-app-staging"}: ${w.name}`;
  if (w.store === "cloudflare-worker") {
    return `Cloudflare ${w.env === "production" ? "praxis-sentinel" : "praxis-sentinel-staging"}: ${w.name}`;
  }
  return `${w.store}: ${w.name}`;
}
