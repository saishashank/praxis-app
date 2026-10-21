// The secret -> stores table (M8 T13; docs/M8_design.md section 2.4, decisions 5, 6 and 26;
// spec 10 SEC-017 table, SEC-021, SEC-101; spec 11 OPS-037, OPS-045). ONE source for:
//   - the rotation page and the emergency-rotation checklist in docs/owner-guide/M8_go_live.md
//     (generated from this file; tests/security/secretStores.test.ts keeps the guide equal to it),
//   - the Owner's per-secret expiry list (the expiry keys are the ids of CREDENTIAL_NAMES in
//     src/lib/sentinel/schema.ts, which System Health, the Ops checklist and the expiry reminder
//     email read; a test keeps the two lists equal, so they cannot disagree).
// HIGH RISK: this table drives a rotation. Names and stores only. There is NO value here, and
// there must never be one (SEC-101, SEC-103, SEC-110). Secret NAMES are public already (SEC-017).
import { CREDENTIAL_NAME_LIST, type CredentialName } from "@/lib/sentinel/schema";

export type EnvName = "production" | "staging";

/** Where a value is held. "offline" = the Owner's own safe place; "agent-config" = the build agent. */
export type StoreKind =
  "github-env" | "vercel-env" | "cloudflare-worker" | "offline" | "agent-config";

/** The ordered rotation steps (decision 26). A row's slots say in which step each store is updated. */
export const ROTATION_STEPS = [
  { id: 1, title: "Revoke the build token and remove the bot", where: "GitHub" },
  {
    id: 2,
    title: "GitHub environment secrets (deploy, production, ci-fixtures)",
    where: "GitHub",
  },
  { id: 3, title: "Turso tokens, one database at a time", where: "Turso" },
  { id: 4, title: "Vercel production environment variables", where: "Vercel" },
  { id: 5, title: "Cloudflare production Worker secrets", where: "Cloudflare" },
  { id: 6, title: "Redeploy the same approved commit and the Worker", where: "GitHub" },
  { id: 7, title: "Staging: every staging store, then redeploy staging", where: "all" },
  { id: 8, title: "Smoke tests on staging and production", where: "GitHub and System Health" },
  { id: 9, title: "Enter the new expiry dates", where: "System Health" },
] as const;
export type StepId = (typeof ROTATION_STEPS)[number]["id"];

/** One place a value is entered. `names` are the exact names used in that store. */
export interface StoreSlot {
  env: EnvName;
  store: StoreKind;
  /** The store container, in words ("GitHub environment `production`"). */
  holder: string;
  names: readonly string[];
  /** The rotation step in which this store is updated. */
  step: StepId;
}

/** A smoke check that proves the secret after a rotation. `needle` must occur in `source`. */
export interface SmokeCheck {
  runner: "stage1" | "stage2" | "vercel" | "worker";
  env: EnvName;
  /** The job (stage 1) or place (System Health block) where the result shows. */
  where: string;
  /** The check name as the run prints it. */
  name: string;
  source: string;
  needle: string;
}

export type Smoke =
  { kind: "check"; checks: readonly SmokeCheck[] } | { kind: "listed"; reason: string };

export type Expiry =
  | { tracked: true; key: CredentialName; maxAge: string }
  | { tracked: false; maxAge: string; why: string };

export type Handling = "rotate" | "revoke" | "keep" | "absent";

export interface SecretRow {
  /** SEC-017 row letter(s), or a short id for the extra rows the design adds. */
  id: string;
  /** True for rows that are not in the SEC-017 table (decision 5 adds them). */
  extra: boolean;
  title: string;
  /** What the go-live does with it: rotate (decision 5), revoke, keep or absent. */
  handling: Handling;
  /** Who issues the new value and where. */
  issuer: string;
  slots: readonly StoreSlot[];
  smoke: Smoke;
  expiry: Expiry;
  /** Plain words for the guide. */
  note?: string;
  /** The step in which the new value is created, when that is earlier than its first store. */
  issueStep?: StepId;
}

const G = "github-env" as const;
const V = "vercel-env" as const;
const W = "cloudflare-worker" as const;

const WORKER_PROD = "Cloudflare Worker `praxis-sentinel` (production)";
const WORKER_STG = "Cloudflare Worker `praxis-sentinel-staging`";
const VERCEL_PROD = "Vercel project `praxis-app`, environment variables (Production)";
const VERCEL_STG = "Vercel project `praxis-app-staging`, environment variables (Production)";
const GH = (e: string) => `GitHub environment \`${e}\``;

const S1 = "scripts/smoke/checks.mjs";
const VC = "src/lib/selfcheck/checks.ts";
const WK = "worker/src/selfcheck.ts";

const s1 = (
  env: EnvName,
  where: string,
  name: string,
  needle: string,
  source = S1,
): SmokeCheck => ({ runner: "stage1", env, where, name, source, needle });
const vc = (env: EnvName, name: string, needle: string): SmokeCheck => ({
  runner: "vercel",
  env,
  where: "Stage 2 table and System Health",
  name,
  source: VC,
  needle,
});
const wk = (env: EnvName, name: string, needle: string): SmokeCheck => ({
  runner: "worker",
  env,
  where: "System Health, Worker secrets",
  name,
  source: WK,
  needle,
});

const hmacFmt = "ACTIONS_HMAC_SECRET";
const SUITES = "scripts/smoke/suites.mjs";

/** Table order follows SEC-017; the extra rows (PII_HASH_KEY, staging Resend key) follow their kin. */
export const SECRET_ROWS: readonly SecretRow[] = [
  {
    id: "a",
    extra: false,
    title: "Build-agent token (classic personal access token of the bot account)",
    handling: "revoke",
    issuer: "GitHub, bot account (you revoke it; you never issue a new one at go-live)",
    slots: [],
    smoke: {
      kind: "listed",
      reason:
        "Revoked, not rotated: nothing to test. Proof is the bot's token page showing no token, the bot removed from Collaborators, and the first sign-off tick.",
    },
    expiry: { tracked: true, key: "a_build_agent_token", maxAge: "90 days" },
    note: "Held only in the build agent's own configuration, never in a store you manage (SEC-102).",
  },
  {
    id: "b",
    extra: false,
    title: "Worker dispatch token (fine-grained, code repo, Actions read and write)",
    handling: "rotate",
    issuer: "GitHub, your account (fine-grained token, code repo only)",
    slots: [
      {
        env: "production",
        store: W,
        holder: WORKER_PROD,
        names: ["GITHUB_DISPATCH_TOKEN"],
        step: 5,
      },
    ],
    smoke: {
      kind: "check",
      checks: [wk("production", "GITHUB_DISPATCH_TOKEN", "GITHUB_DISPATCH_TOKEN")],
    },
    expiry: { tracked: true, key: "b_worker_dispatch_token", maxAge: "1 year" },
  },
  {
    id: "b-s",
    extra: false,
    title: "Staging Worker dispatch token (separate value, same scope)",
    handling: "rotate",
    issuer: "GitHub, your account (fine-grained token, code repo only)",
    slots: [
      { env: "staging", store: W, holder: WORKER_STG, names: ["GITHUB_DISPATCH_TOKEN"], step: 7 },
    ],
    smoke: {
      kind: "listed",
      reason:
        "The staging Worker has no schedule outside a test window, so its self-check runs only then. Proof: the next staging test window shows GITHUB_DISPATCH_TOKEN as PASS on the staging System Health, or turn the staging slots on for a few minutes and read it there.",
    },
    expiry: { tracked: true, key: "b_s_staging_dispatch_token", maxAge: "1 year" },
  },
  {
    id: "c1",
    extra: false,
    title: "Session secret and CRON_SECRET (random 64 hex characters)",
    handling: "rotate",
    issuer: "You, with your password manager's generator (64 hex characters)",
    slots: [
      {
        env: "production",
        store: V,
        holder: VERCEL_PROD,
        names: ["AUTH_SECRET", "CRON_SECRET"],
        step: 4,
      },
      {
        env: "staging",
        store: V,
        holder: VERCEL_STG,
        names: ["AUTH_SECRET", "CRON_SECRET"],
        step: 7,
      },
    ],
    smoke: {
      kind: "check",
      checks: [
        vc("production", "AUTH_SECRET format", "AUTH_SECRET"),
        vc("production", "CRON_SECRET format", "CRON_SECRET"),
        vc("staging", "AUTH_SECRET format", "AUTH_SECRET"),
        vc("staging", "CRON_SECRET format", "CRON_SECRET"),
      ],
    },
    expiry: { tracked: true, key: "c1_session_cron_secret", maxAge: "1 year" },
    note: "Everyone is signed out when this changes (expected). Vercel Cron picks up the new CRON_SECRET at the redeploy.",
  },
  {
    id: "c2",
    extra: false,
    title: "Worker to Vercel signing secret (separate value per environment)",
    handling: "rotate",
    issuer: "You, with your password manager's generator (64 hex characters)",
    slots: [
      { env: "production", store: V, holder: VERCEL_PROD, names: ["WORKER_HMAC_SECRET"], step: 4 },
      { env: "production", store: W, holder: WORKER_PROD, names: ["WORKER_HMAC_SECRET"], step: 5 },
      { env: "staging", store: V, holder: VERCEL_STG, names: ["WORKER_HMAC_SECRET"], step: 7 },
      { env: "staging", store: W, holder: WORKER_STG, names: ["WORKER_HMAC_SECRET"], step: 7 },
    ],
    smoke: {
      kind: "check",
      checks: [
        vc("production", "WORKER_HMAC_SECRET format", "WORKER_HMAC_SECRET"),
        vc("staging", "WORKER_HMAC_SECRET format", "WORKER_HMAC_SECRET"),
        wk("production", "report delivered", "report delivered"),
      ],
    },
    expiry: { tracked: true, key: "c2_worker_hmac", maxAge: "1 year" },
    note: "The same value must sit in both stores of the same environment. The Worker's next self-check report is accepted only when they match.",
  },
  {
    id: "c3",
    extra: false,
    title: "Actions to Vercel signing secret (separate value per environment)",
    handling: "rotate",
    issuer: "You, with your password manager's generator (64 hex characters)",
    slots: [
      {
        env: "production",
        store: G,
        holder: GH("production"),
        names: ["ACTIONS_HMAC_SECRET_PROD"],
        step: 2,
      },
      { env: "production", store: V, holder: VERCEL_PROD, names: ["ACTIONS_HMAC_SECRET"], step: 4 },
      {
        env: "staging",
        store: G,
        holder: GH("staging"),
        names: ["ACTIONS_HMAC_SECRET_STAGING"],
        step: 7,
      },
      { env: "staging", store: V, holder: VERCEL_STG, names: ["ACTIONS_HMAC_SECRET"], step: 7 },
    ],
    smoke: {
      kind: "check",
      checks: [
        s1("production", "job production", `${hmacFmt} format`, hmacFmt, SUITES),
        s1("staging", "job staging", `${hmacFmt} format`, hmacFmt, SUITES),
        {
          runner: "stage2",
          env: "production",
          where: "Stage 2 step: a signed call that the Vercel route accepts",
          name: "Stage 2 production: n/n passed",
          source: "scripts/smoke/stage2.mjs",
          needle: "Stage 2",
        },
      ],
    },
    expiry: { tracked: true, key: "c3_actions_hmac", maxAge: "1 year" },
    note: "The GitHub name ends in _PROD or _STAGING; the Vercel name does not. The value is the same on both sides of one environment.",
  },
  {
    id: "c4",
    extra: false,
    title: "Staging test-identity signing secret (SEC-109)",
    handling: "rotate",
    issuer: "You, with your password manager's generator (64 hex characters)",
    slots: [
      {
        // the same value, for the staging E2E, ZAP and nightly jobs that sign in as the test identity (M8 T12)
        env: "staging",
        store: G,
        holder: GH("staging"),
        names: ["TEST_IDENTITY_SECRET_STAGING"],
        step: 7,
      },
      {
        env: "staging",
        store: V,
        holder: VERCEL_STG,
        names: ["TEST_IDENTITY_SECRET"],
        step: 7,
      },
    ],
    smoke: {
      kind: "check",
      checks: [vc("staging", "TEST_IDENTITY_SECRET format", "TEST_IDENTITY_SECRET")],
    },
    expiry: { tracked: true, key: "c4_test_identity_secret", maxAge: "1 year" },
    note: "Production must never hold this name. The production self-check fails if it does.",
  },
  {
    id: "d",
    extra: false,
    title: "Turso main-database tokens (one per environment per caller)",
    handling: "rotate",
    issuer: "You, in the Turso dashboard (new token per caller, then remove the old ones)",
    slots: [
      {
        env: "production",
        store: G,
        holder: GH("production"),
        names: ["TURSO_MAIN_TOKEN_PROD"],
        step: 3,
      },
      { env: "production", store: V, holder: VERCEL_PROD, names: ["TURSO_MAIN_TOKEN"], step: 4 },
      { env: "production", store: W, holder: WORKER_PROD, names: ["TURSO_MAIN_TOKEN"], step: 5 },
      {
        env: "staging",
        store: G,
        holder: GH("staging"),
        names: ["TURSO_MAIN_TOKEN_STAGING"],
        step: 7,
      },
      { env: "staging", store: V, holder: VERCEL_STG, names: ["TURSO_MAIN_TOKEN"], step: 7 },
      { env: "staging", store: W, holder: WORKER_STG, names: ["TURSO_MAIN_TOKEN"], step: 7 },
    ],
    smoke: {
      kind: "check",
      checks: [
        s1("production", "job production", "Turso DB round-trip", "Turso DB round-trip"),
        s1("staging", "job staging", "Turso DB round-trip", "Turso DB round-trip"),
        vc("production", "Turso main DB round-trip", "Turso main DB round-trip"),
        vc("staging", "Turso main DB round-trip", "Turso main DB round-trip"),
        wk("production", "TURSO_MAIN round trip", "TURSO_MAIN round trip"),
      ],
    },
    expiry: { tracked: true, key: "d_turso_main_tokens", maxAge: "1 year" },
    note: "Only the token changes. The database address (TURSO_MAIN_URL) is not a secret and stays the same unless you replace the database.",
  },
  {
    id: "e",
    extra: false,
    title: "Turso auth-database token (production and staging, separate)",
    handling: "rotate",
    issuer: "You, in the Turso dashboard",
    slots: [
      { env: "production", store: V, holder: VERCEL_PROD, names: ["TURSO_AUTH_TOKEN"], step: 4 },
      { env: "staging", store: V, holder: VERCEL_STG, names: ["TURSO_AUTH_TOKEN"], step: 7 },
    ],
    smoke: {
      kind: "check",
      checks: [
        vc("production", "Turso auth DB round-trip", "Turso auth DB round-trip"),
        vc("staging", "Turso auth DB round-trip", "Turso auth DB round-trip"),
      ],
    },
    expiry: { tracked: true, key: "e_turso_auth_token", maxAge: "1 year" },
    issueStep: 3,
    note: "Issued in step 3 together with the main-database tokens; entered in Vercel in step 4.",
  },
  {
    id: "f",
    extra: false,
    title: "Data-repo token (fine-grained, data repo only, contents read and write)",
    handling: "rotate",
    issuer: "GitHub, your account (fine-grained token, data repo only)",
    slots: [
      {
        env: "production",
        store: G,
        holder: GH("production"),
        names: ["DATA_REPO_TOKEN_PROD"],
        step: 2,
      },
    ],
    smoke: {
      kind: "check",
      checks: [s1("production", "job production", "GitHub read: data repo", "data repo", SUITES)],
    },
    expiry: { tracked: true, key: "f_data_repo_token", maxAge: "1 year" },
    note: "The stage 1 check proves read access. Write access is proven by the next backup run (Actions, Nightly backup, Run workflow).",
  },
  {
    id: "f-r",
    extra: false,
    title: "Read-only fixtures token (fine-grained, fixtures repo only, contents read)",
    handling: "rotate",
    issuer: "GitHub, your account (fine-grained token, fixtures repo only)",
    slots: [
      { env: "staging", store: G, holder: GH("staging"), names: ["FIXTURES_READ_TOKEN"], step: 2 },
      {
        env: "staging",
        store: G,
        holder: GH("ci-fixtures"),
        names: ["FIXTURES_READ_TOKEN"],
        step: 2,
      },
    ],
    smoke: {
      kind: "check",
      checks: [
        s1(
          "staging",
          "jobs staging and ci-fixtures",
          "GitHub read: fixtures repo",
          "fixtures repo",
          SUITES,
        ),
      ],
    },
    expiry: { tracked: true, key: "f_r_fixtures_read_token", maxAge: "1 year" },
  },
  {
    id: "g",
    extra: false,
    title: "Cloudflare API token (Edit Workers; a separate account per environment)",
    handling: "rotate",
    issuer: "You, in Cloudflare: one token per account (production account, staging account)",
    slots: [
      {
        env: "production",
        store: G,
        holder: GH("deploy-production"),
        names: ["CLOUDFLARE_API_TOKEN_PROD"],
        step: 2,
      },
      {
        env: "staging",
        store: G,
        holder: GH("deploy-staging"),
        names: ["CLOUDFLARE_API_TOKEN_STAGING"],
        step: 2,
      },
    ],
    smoke: {
      kind: "check",
      checks: [
        s1("production", "job deploy-production", "Cloudflare API token", "Cloudflare API token"),
        s1("staging", "job deploy-staging", "Cloudflare API token", "Cloudflare API token"),
      ],
    },
    expiry: { tracked: true, key: "g_cloudflare_api_token", maxAge: "1 year" },
    note: "Never put the production token in deploy-staging. The account ids (CLOUDFLARE_ACCOUNT_ID_*) are not secret and do not change.",
  },
  {
    id: "n",
    extra: false,
    title: "Vercel deploy token (account token for command-line deploys)",
    handling: "rotate",
    issuer: "You, in Vercel (Account Settings, Tokens)",
    slots: [
      {
        env: "production",
        store: G,
        holder: GH("deploy-production"),
        names: ["VERCEL_TOKEN_PROD"],
        step: 2,
      },
      {
        env: "staging",
        store: G,
        holder: GH("deploy-staging"),
        names: ["VERCEL_TOKEN_STAGING"],
        step: 2,
      },
    ],
    smoke: {
      kind: "check",
      checks: [s1("production", "job deploy-production", "Vercel token", "Vercel token")],
    },
    expiry: { tracked: true, key: "n_vercel_deploy_token", maxAge: "1 year" },
    note: "SEC-017 puts this token in deploy-production only. The staging name is held only if you created the staging deploy token (M1 guide, section B, on hold); skip that line if you never did.",
  },
  {
    id: "h",
    extra: false,
    title: "Resend API key, production (sending only)",
    handling: "rotate",
    issuer: "You, in Resend (new key with Sending access, then delete the old key)",
    slots: [
      {
        env: "production",
        store: G,
        holder: GH("production"),
        names: ["RESEND_API_KEY_PROD"],
        step: 2,
      },
      { env: "production", store: V, holder: VERCEL_PROD, names: ["RESEND_API_KEY"], step: 4 },
    ],
    smoke: {
      kind: "check",
      checks: [
        s1(
          "production",
          "job production (one [TEST] email)",
          "Resend test email",
          "Resend test email",
        ),
        vc("production", "RESEND_API_KEY format", "RESEND_API_KEY"),
      ],
    },
    expiry: { tracked: true, key: "h_resend_api_keys", maxAge: "1 year" },
  },
  {
    id: "h-s",
    extra: true,
    title: "Resend API key, staging (the key that can email you from the whitelisted sender)",
    handling: "rotate",
    issuer: "You, in Resend (a separate key for staging)",
    slots: [
      {
        env: "staging",
        store: G,
        holder: GH("staging"),
        names: ["RESEND_API_KEY_STAGING"],
        step: 7,
      },
      { env: "staging", store: V, holder: VERCEL_STG, names: ["RESEND_API_KEY"], step: 7 },
    ],
    smoke: {
      kind: "check",
      checks: [
        s1("staging", "job staging (one [TEST] email)", "Resend test email", "Resend test email"),
        vc("staging", "RESEND_API_KEY format", "RESEND_API_KEY"),
      ],
    },
    expiry: { tracked: true, key: "h_resend_api_keys", maxAge: "1 year" },
    note: "SEC-021 and OPS-045 add this key to the go-live list. It shares the expiry date entry of row (h): enter the earlier of the two dates.",
  },
  {
    id: "i",
    extra: false,
    title: "LLM API keys (one per provider)",
    handling: "rotate",
    issuer: "You, at each provider: Google AI Studio, Groq, OpenRouter",
    slots: [
      {
        env: "production",
        store: G,
        holder: GH("production"),
        names: ["GOOGLE_AI_API_KEY", "GROQ_API_KEY", "OPENROUTER_API_KEY"],
        step: 2,
      },
      {
        env: "production",
        store: V,
        holder: VERCEL_PROD,
        names: ["GOOGLE_AI_API_KEY", "GROQ_API_KEY", "OPENROUTER_API_KEY"],
        step: 4,
      },
    ],
    smoke: {
      kind: "check",
      checks: [
        s1("production", "job production", "Google AI key", "googleAiKey"),
        s1("production", "job production", "Groq key", "groqKey"),
        s1("production", "job production", "OpenRouter key", "openRouterKey"),
        vc("production", "Google AI key", "Google AI key"),
        vc("production", "Groq key", "Groq key"),
        vc("production", "OpenRouter key", "OpenRouter key"),
      ],
    },
    expiry: { tracked: true, key: "i_llm_api_keys", maxAge: "1 year" },
    note: "Staging holds no live LLM key (recorded responses). If you add a provider later, add it here and in the code table first.",
  },
  {
    id: "j",
    extra: false,
    title: "Google OAuth client secrets (two clients: production and staging)",
    handling: "rotate",
    issuer: "You, in Google Cloud Console (APIs and Services, Credentials), one client each",
    slots: [
      { env: "production", store: V, holder: VERCEL_PROD, names: ["AUTH_GOOGLE_SECRET"], step: 4 },
      { env: "staging", store: V, holder: VERCEL_STG, names: ["AUTH_GOOGLE_SECRET"], step: 7 },
    ],
    smoke: {
      kind: "check",
      checks: [
        vc("production", "Google OAuth client", "Google OAuth client"),
        vc("staging", "Google OAuth client", "Google OAuth client"),
      ],
    },
    expiry: { tracked: true, key: "j_google_oauth_secrets", maxAge: "1 year" },
    note: "Keep both redirect addresses unchanged (PLT-035). The client id (AUTH_GOOGLE_ID) does not change.",
  },
  {
    id: "k",
    extra: false,
    title: "Backup key pair (age): public key in two stores, private key offline only",
    handling: "keep",
    issuer: "You, offline (only on suspicion, OPS-037a)",
    slots: [
      {
        env: "production",
        store: G,
        holder: GH("production"),
        names: ["BACKUP_PUBLIC_KEY"],
        step: 2,
      },
      { env: "production", store: V, holder: VERCEL_PROD, names: ["BACKUP_PUBLIC_KEY"], step: 4 },
      {
        env: "production",
        store: "offline",
        holder: "Your offline safe place (never on GitHub, Vercel or Cloudflare)",
        names: ["BACKUP_PRIVATE_KEY"],
        step: 2,
      },
    ],
    smoke: {
      kind: "check",
      checks: [
        s1("production", "job production", "BACKUP_PUBLIC_KEY format", "BACKUP_PUBLIC_KEY"),
        vc("production", "BACKUP_PUBLIC_KEY format", "BACKUP_PUBLIC_KEY"),
      ],
    },
    expiry: {
      tracked: false,
      maxAge: "on suspicion",
      why: "A key pair does not expire. It is replaced only if you suspect the private key was exposed (OPS-037a).",
    },
    note: "NOT rotated at go-live (SEC-021): it never touched GitHub during the build. The private key is added to GitHub only as a temporary secret for a restore drill (row l).",
  },
  {
    id: "l",
    extra: false,
    title: "Temporary restore secrets: Turso platform token and the private backup key",
    handling: "absent",
    issuer:
      "You, in Turso (narrowest create-database scope, shortest expiry), only for a drill or restore",
    slots: [
      {
        env: "production",
        store: G,
        holder: `${GH("production")} (temporary)`,
        names: ["TURSO_PLATFORM_TOKEN_TEMP", "BACKUP_PRIVATE_KEY"],
        step: 2,
      },
    ],
    smoke: {
      kind: "listed",
      reason:
        "A secret that must NOT exist after use. Proof of removal: a Restore drill run with mode verify-removed ends green, and the nightly watchdog stays green (it fails while either secret is present).",
    },
    expiry: {
      tracked: false,
      maxAge: "deleted after use",
      why: "Short-lived by design; delete both secrets and revoke the token the same day.",
    },
    note: "Not rotated: it does not exist outside a drill. The go-live guide shows when to add and delete it.",
  },
  {
    id: "m",
    extra: false,
    title: "GitHub read token for release detection (fine-grained, code repo, read only)",
    handling: "rotate",
    issuer:
      "GitHub, your account (fine-grained token, code repo only; contents, actions and deployments read)",
    slots: [
      { env: "production", store: V, holder: VERCEL_PROD, names: ["GITHUB_READ_TOKEN"], step: 4 },
    ],
    smoke: {
      kind: "check",
      checks: [vc("production", "GITHUB_READ_TOKEN", "GITHUB_READ_TOKEN")],
    },
    expiry: { tracked: true, key: "m_github_read_token", maxAge: "1 year" },
  },
  {
    id: "pii",
    extra: true,
    title: "PII_HASH_KEY (keyed hash for personal data after retention; NFR-030)",
    handling: "rotate",
    issuer: "You, with your password manager's generator (64 hex characters)",
    slots: [
      {
        env: "production",
        store: G,
        holder: GH("production"),
        names: ["PII_HASH_KEY_PROD"],
        step: 2,
      },
      { env: "production", store: V, holder: VERCEL_PROD, names: ["PII_HASH_KEY"], step: 4 },
      {
        env: "staging",
        store: G,
        holder: GH("staging"),
        names: ["PII_HASH_KEY_STAGING"],
        step: 7,
      },
      { env: "staging", store: V, holder: VERCEL_STG, names: ["PII_HASH_KEY"], step: 7 },
    ],
    smoke: {
      kind: "check",
      checks: [
        s1("production", "job production", "PII_HASH_KEY format", "PII_HASH_KEY", SUITES),
        s1("staging", "job staging", "PII_HASH_KEY format", "PII_HASH_KEY", SUITES),
        vc("production", "PII_HASH_KEY format", "PII_HASH_KEY"),
        vc("staging", "PII_HASH_KEY format", "PII_HASH_KEY"),
      ],
    },
    expiry: {
      tracked: false,
      maxAge: "1 year",
      why: "The expiry list has no entry for this key yet, so no reminder is generated. Put a yearly reminder in your own calendar. Rotation does not re-hash old rows (SEC-017 s13).",
    },
    note: "Production only for rows already hashed; staging has its own value.",
  },
];

/** Secret names the workflows read that are NOT rotated (not secret values, or kept by rule). */
export const NON_ROTATING_SECRET_NAMES: Readonly<Record<string, string>> = {
  APP_BASE_URL_PROD: "Public address of the app, stored as a secret only to keep it out of logs.",
  APP_BASE_URL_STAGING: "Public address of the staging app, kept out of logs.",
  CLOUDFLARE_ACCOUNT_ID_PROD: "Account id, not a credential; changes only if the account changes.",
  CLOUDFLARE_ACCOUNT_ID_STAGING:
    "Account id, not a credential; changes only if the account changes.",
  TURSO_MAIN_URL_PROD: "Database address; changes only when the database is replaced (OPS-040).",
  TURSO_MAIN_URL_STAGING: "Database address; changes only when the database is replaced.",
  OWNER_EMAIL_PROD: "Your sign-in address; configuration, not a credential.",
  OWNER_EMAIL_STAGING: "Your sign-in address; configuration, not a credential.",
  OWNER_RECOVERY_EMAIL_PROD: "Break-glass address; configuration, not a credential (OPS-040a).",
  BACKUP_PUBLIC_KEY: "Row (k): kept at go-live, replaced only on suspicion (OPS-037a).",
};

export const rowById = (id: string): SecretRow => {
  const r = SECRET_ROWS.find((x) => x.id === id);
  if (!r) throw new Error(`no secret row ${id}`);
  return r;
};

/** The step in which a row's new value is first created and entered (its earliest slot). */
export function firstStep(r: SecretRow): StepId | null {
  if (r.handling === "revoke") return 1;
  if (r.handling !== "rotate") return null;
  if (r.issueStep !== undefined) return r.issueStep;
  return r.slots.reduce<StepId>((m, s) => (s.step < m ? s.step : m), 9);
}

export interface OrderEntry {
  /** 1-based position in the whole rotation. */
  position: number;
  step: StepId;
  row: SecretRow;
}

/**
 * Decision 26 order: by step, then SEC-017 table order. The revoked token (a) is position 1; kept
 * and absent rows (k, l) have no position.
 */
export function rotationOrder(): OrderEntry[] {
  const withStep = SECRET_ROWS.map((row, idx) => ({ row, idx, step: firstStep(row) })).filter(
    (x): x is { row: SecretRow; idx: number; step: StepId } => x.step !== null,
  );
  withStep.sort((a, b) => a.step - b.step || a.idx - b.idx);
  return withStep.map((x, i) => ({ position: i + 1, step: x.step, row: x.row }));
}

export const positionOf = (id: string): number | null =>
  rotationOrder().find((o) => o.row.id === id)?.position ?? null;

/** Secrets whose rotation is proven by a check (every rotated row must have one or a reason). */
export const rowsToRotate = (): SecretRow[] => SECRET_ROWS.filter((r) => r.handling === "rotate");

/** The credential_expiry ids a row writes to (System Health "Credential expiry dates"). */
export const trackedExpiryKeys = (): CredentialName[] =>
  [
    ...new Set(SECRET_ROWS.flatMap((r) => (r.expiry.tracked ? [r.expiry.key] : []))),
  ] as CredentialName[];

/** Every secret name held anywhere, by row (the names a stage must update). */
export const allNames = (): string[] => [
  ...new Set(SECRET_ROWS.flatMap((r) => r.slots.flatMap((s) => [...s.names]))),
];

// ---- rendering for the Owner guide (docs/owner-guide/M8_go_live.md) ----

const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
const table = (head: string[], rows: string[][]): string =>
  [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
  ].join("\n");

const names = (list: readonly string[]): string => list.map((n) => `\`${n}\``).join(", ");
const slotText = (r: SecretRow, s: StoreSlot): string =>
  `${s.env}: ${s.holder}: ${names(s.names)}${r.handling === "rotate" ? ` (step ${s.step})` : ""}`;

const smokeText = (r: SecretRow): string =>
  r.smoke.kind === "listed"
    ? `Listed, no automatic check: ${r.smoke.reason}`
    : r.smoke.checks.map((c) => `${c.env}: ${c.name} (${c.where})`).join("; ");

const expiryText = (r: SecretRow): string =>
  r.expiry.tracked ? `Yes, up to ${r.expiry.maxAge}` : `No: ${r.expiry.why}`;

const handlingText: Record<Handling, string> = {
  rotate: "Rotate",
  revoke: "Revoke",
  keep: "Keep (not rotated)",
  absent: "Absent (delete after use)",
};

export const ROTATION_START =
  "<!-- secret-table:start (generated from src/lib/security/secretStores.ts) -->";
export const ROTATION_END = "<!-- secret-table:end -->";
export const EMERGENCY_START =
  "<!-- emergency-checklist:start (generated from src/lib/security/secretStores.ts) -->";
export const EMERGENCY_END = "<!-- emergency-checklist:end -->";

const rowCells = (position: string, r: SecretRow): string[] => [
  position,
  `(${r.id})${r.extra ? " extra row" : ""}`,
  r.title,
  handlingText[r.handling],
  r.issuer,
  r.slots.length
    ? r.slots.map((s) => slotText(r, s)).join("; ")
    : "none (the build agent's own configuration)",
  smokeText(r),
  expiryText(r),
];

/** The ordered steps and the rotation table, in the order the Owner works. */
export function renderRotationBlock(): string {
  const steps = table(
    ["Step", "What you do", "Where"],
    ROTATION_STEPS.map((s) => [String(s.id), s.title, s.where]),
  );
  const rows = rotationOrder().map((o) => rowCells(String(o.position), o.row));
  const idle = SECRET_ROWS.filter((r) => firstStep(r) === null).map((r) => rowCells("none", r));
  const head = [
    "Order",
    "Row",
    "Secret",
    "Action",
    "Who issues it",
    "Where it is entered (store, name, step)",
    "Smoke check that proves it",
    "Expiry date tracked",
  ];
  return [
    ROTATION_START,
    "",
    "Steps, in order:",
    "",
    steps,
    "",
    "Secrets, in the order you work through them:",
    "",
    table(head, [...rows, ...idle]),
    "",
    ROTATION_END,
  ].join("\n");
}

/** Rows that get the generic emergency block. (a), (k) and (l) have their own text in the guide. */
export const genericEmergencyRows = (): SecretRow[] => rowsToRotate();

/** The generic emergency-rotation checklist (OPS-037): one block per secret, names and stores only. */
export function renderEmergencyBlock(): string {
  const blocks = genericEmergencyRows().map((r) => {
    const where = r.slots.map((s) => `${s.holder}: ${names(s.names)}`);
    const check =
      r.smoke.kind === "check"
        ? [...new Set(r.smoke.checks.map((c) => c.name))].join("; ")
        : "no automatic check, see the table above";
    return [
      `**(${r.id}) ${r.title}**`,
      "",
      `1. Revoke or delete the old value at the issuer: ${r.issuer}.`,
      "2. Create the new value there. Never paste it into chat, email, notes or a ticket.",
      `3. Enter it in every store, one by one: ${where.join("; ")}.`,
      "4. If a Vercel or Cloudflare store changed, redeploy the app and the Worker (same approved commit).",
      `5. Run the smoke test and read: ${check}.`,
      "6. Write the new expiry date on System Health and note the incident (date and row letter, no value).",
    ].join("\n");
  });
  return [EMERGENCY_START, "", blocks.join("\n\n"), "", EMERGENCY_END].join("\n");
}

/** Expiry-list ids (System Health, Ops checklist, reminder email) that no table row writes to: must be none. */
export const expiryKeysWithoutRow = (): CredentialName[] => {
  const tracked = new Set<CredentialName>(trackedExpiryKeys());
  return CREDENTIAL_NAME_LIST.filter((k) => !tracked.has(k));
};
