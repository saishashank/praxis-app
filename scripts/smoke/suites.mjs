// Suites for stage 1. Each entry is (env, fetchImpl) => Promise<{name, ok, detail}>.
import {
  tursoRoundTrip, resendTestEmail, hexSecret, agePublicKey, emailShape,
  githubRepoRead, googleAiKey, groqKey, openRouterKey, cloudflareToken, vercelToken,
} from './checks.mjs';

const turso = (e, f) => tursoRoundTrip(e, f);
const resend = (e, f) => resendTestEmail(e, f);
const ownerEmail = (e) => emailShape('OWNER_EMAIL', e.OWNER_EMAIL);
const hmac = (e) => hexSecret('ACTIONS_HMAC_SECRET', e.ACTIONS_HMAC_SECRET);
const pii = (e) => hexSecret('PII_HASH_KEY', e.PII_HASH_KEY);
const fixturesRead = (e, f) => githubRepoRead(e.FIXTURES_READ_TOKEN, e.FIXTURES_REPO, 'fixtures repo', f);

export const SUITES = {
  'app-production': [
    turso, resend, ownerEmail, hmac, pii,
    (e) => agePublicKey(e.BACKUP_PUBLIC_KEY),
    (e) => emailShape('OWNER_RECOVERY_EMAIL', e.OWNER_RECOVERY_EMAIL),
    (e, f) => githubRepoRead(e.DATA_REPO_TOKEN, e.DATA_REPO, 'data repo', f),
    (e, f) => googleAiKey(e.GOOGLE_AI_API_KEY, f),
    (e, f) => groqKey(e.GROQ_API_KEY, f),
    (e, f) => openRouterKey(e.OPENROUTER_API_KEY, f),
  ],
  'app-staging': [turso, resend, ownerEmail, hmac, pii, fixturesRead],
  'ci-fixtures': [fixturesRead],
  'deploy-production': [(e, f) => cloudflareToken(e, f), (e, f) => vercelToken(e, f)],
  'deploy-staging': [(e, f) => cloudflareToken(e, f)],
};
