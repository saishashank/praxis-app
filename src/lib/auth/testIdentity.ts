// Staging-only test-identity login: the runtime guard (SEC-109, TST-113). Opus reviews every line.
//
// The route answers 404 unless ALL of these independent signals say "this is not production":
//   1. TEST_IDENTITY_SECRET is a valid secret (64 lowercase hex). Only the staging Vercel
//      environment holds it (SEC-017 c4); production never does.
//   2. BACKUP_PUBLIC_KEY is absent: production holds it (SEC-017 k, D-029).
//   3. OWNER_RECOVERY_EMAIL is absent: production holds it (D-010, SEC-017 k).
//   4. NODE_ENV is not "development" (unless a test passes allowDevelopment).
// A mistake that puts the secret into production still leaves signals 2 and 3 closed, and the
// production smoke test (scripts/smoke/stage2.mjs) asserts the route returns 404 there.
//
// Compile-out (TST-113): one shared build of a public repo serves both environments, so the code
// cannot be removed from the production bundle. The guard is a runtime check, the route module
// loads the login logic by dynamic import only after the guard passes, and production holds no
// TEST_IDENTITY_SECRET (decision D-039).
import { isValidSecret } from "@/lib/security/hmac";

export type TestIdentityEnv = Record<string, string | undefined>;

const has = (v: string | undefined): boolean => typeof v === "string" && v.trim() !== "";

// Informational only (never used to enable anything): evaluated at module load.
export const TEST_IDENTITY_BUILD: boolean = process.env.TEST_IDENTITY_SECRET ? true : false;

export function testIdentityEnabled(
  env: TestIdentityEnv,
  opts: { allowDevelopment?: boolean } = {},
): boolean {
  if (!isValidSecret(env.TEST_IDENTITY_SECRET)) return false;
  if (has(env.BACKUP_PUBLIC_KEY)) return false;
  if (has(env.OWNER_RECOVERY_EMAIL)) return false;
  if (env.NODE_ENV === "development" && opts.allowDevelopment !== true) return false;
  return true;
}

// Only reserved test domains: addresses ending in .test or .invalid (RFC 2606 / 6761).
const TEST_EMAIL = /^[^\s@]+@[^\s@]+\.(?:test|invalid)$/;
export const isTestEmail = (email: string): boolean => TEST_EMAIL.test(email);
