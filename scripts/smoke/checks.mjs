// Stage 1 credential smoke checks (BLD-011, SEC-101). Zero dependencies.
// Every check resolves to { name, ok, detail }.
// `detail` is a short safe string. NEVER put a response body, header, URL,
// email address, hostname or secret value into `detail`.
import { randomBytes } from 'node:crypto';

const TIMEOUT_MS = 15000;

const result = (name, ok, detail) => ({ name, ok, detail });
const has = (v) => typeof v === 'string' && v.trim() !== '';

// Run a check body; any exception becomes detail = error.name only.
async function safe(name, body) {
  try {
    return await body();
  } catch (e) {
    return result(name, false, e && typeof e.name === 'string' ? e.name : 'Error');
  }
}

function http(fetchImpl, url, init = {}) {
  return fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

export function sanitizeTableName(runId, attempt) {
  const raw = `smoke_${runId}_${attempt}`.toLowerCase();
  return raw.replace(/[^a-z0-9_]/g, '_');
}

export function toHttpsUrl(url) {
  if (typeof url !== 'string') return null;
  const m = /^(libsql|https):\/\/([^/\s]+)\/?$/.exec(url.trim());
  return m ? `https://${m[2]}` : null;
}

// Turso/libSQL Hrana-over-HTTP v2 pipeline format:
// https://docs.turso.tech/sdk/http/reference
// POST <base>/v2/pipeline, body {requests:[{type:"execute",stmt:{sql,args:[{type,value}]}},{type:"close"}]},
// reply {results:[{type:"ok",response:{type:"execute",result:{rows:[[{type,value}]]}}}, ...]}
export async function tursoRoundTrip(env, fetchImpl) {
  const name = 'Turso DB round-trip';
  return safe(name, async () => {
    if (!has(env.TURSO_MAIN_URL) || !has(env.TURSO_MAIN_TOKEN)) return result(name, false, 'missing');
    const base = toHttpsUrl(env.TURSO_MAIN_URL);
    if (!base) return result(name, false, 'malformed');
    const table = sanitizeTableName(env.GITHUB_RUN_ID ?? 'local', env.GITHUB_RUN_ATTEMPT ?? '0');
    const nonce = randomBytes(16).toString('hex');
    const requests = [
      { type: 'execute', stmt: { sql: `CREATE TABLE IF NOT EXISTS ${table} (id INTEGER PRIMARY KEY, v TEXT NOT NULL)` } },
      { type: 'execute', stmt: { sql: `INSERT INTO ${table} (v) VALUES (?)`, args: [{ type: 'text', value: nonce }] } },
      { type: 'execute', stmt: { sql: `SELECT v FROM ${table}` } },
      { type: 'execute', stmt: { sql: `DROP TABLE ${table}` } },
      { type: 'close' },
    ];
    const res = await http(fetchImpl, `${base}/v2/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TURSO_MAIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests }),
    });
    if (res.status !== 200) return result(name, false, `HTTP ${res.status}`);
    const json = await res.json();
    const results = json && json.results;
    if (!Array.isArray(results) || results.length !== requests.length) return result(name, false, 'unexpected response');
    if (!results.every((r) => r && r.type === 'ok')) return result(name, false, 'statement error');
    const rows = results[2]?.response?.result?.rows;
    const got = Array.isArray(rows) && rows[0] && rows[0][0] ? rows[0][0].value : undefined;
    if (got !== nonce) return result(name, false, 'select mismatch');
    return result(name, true, 'create/insert/select/drop ok');
  });
}

export async function resendTestEmail(env, fetchImpl) {
  const name = 'Resend test email';
  return safe(name, async () => {
    if (!has(env.RESEND_API_KEY) || !has(env.OWNER_EMAIL)) return result(name, false, 'missing');
    const which = env.SMOKE_ENV ?? 'unknown';
    const text = [
      'Praxis credential smoke test (stage 1).',
      `Environment: ${which}`,
      `Run: ${env.GITHUB_RUN_ID ?? 'local'}`,
      `Time (UTC): ${new Date().toISOString()}`,
      '',
      'No action needed.',
    ].join('\n');
    const res = await http(fetchImpl, 'https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Praxis <onboarding@resend.dev>',
        to: [env.OWNER_EMAIL],
        subject: `[TEST] Praxis credential smoke test (${which})`,
        text,
      }),
    });
    if (res.status !== 200) return result(name, false, `HTTP ${res.status}`);
    const json = await res.json();
    if (!json || typeof json.id !== 'string' || json.id === '') return result(name, false, 'no id in response');
    return result(name, true, 'sent (1 email)');
  });
}

export async function hexSecret(name, value) {
  const label = `${name} format`;
  if (!has(value)) return result(label, false, 'missing');
  if (!/^[0-9a-f]{64}$/.test(value)) return result(label, false, 'malformed');
  return result(label, true, 'present, well-formed (proven end-to-end in stage 2)');
}

export async function agePublicKey(value) {
  const label = 'BACKUP_PUBLIC_KEY format';
  if (!has(value)) return result(label, false, 'missing');
  if (!/^age1[02-9ac-hj-np-z]{58}$/.test(value)) return result(label, false, 'malformed');
  return result(label, true, 'present, well-formed age key');
}

export async function emailShape(name, value) {
  const label = `${name} format`;
  if (!has(value)) return result(label, false, 'missing');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return result(label, false, 'malformed');
  return result(label, true, 'present, looks like an email');
}

export async function githubRepoRead(token, repoFullName, label, fetchImpl) {
  const name = `GitHub read: ${label}`;
  return safe(name, async () => {
    if (!has(token)) return result(name, false, 'missing');
    if (!has(repoFullName) || !/^[\w.-]+\/[\w.-]+$/.test(repoFullName)) return result(name, false, 'malformed');
    const res = await http(fetchImpl, `https://api.github.com/repos/${repoFullName}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'praxis-smoke',
      },
    });
    return res.status === 200 ? result(name, true, 'HTTP 200') : result(name, false, `HTTP ${res.status}`);
  });
}

// Free list/identity endpoints only; never a generation call.
async function getWithKey(name, key, url, headers, fetchImpl) {
  return safe(name, async () => {
    if (!has(key)) return result(name, false, 'missing');
    const res = await http(fetchImpl, url, { headers });
    return res.status === 200 ? result(name, true, 'HTTP 200') : result(name, false, `HTTP ${res.status}`);
  });
}

export const googleAiKey = (key, f) =>
  getWithKey('Google AI key', key, 'https://generativelanguage.googleapis.com/v1beta/models', { 'x-goog-api-key': key }, f);
export const groqKey = (key, f) =>
  getWithKey('Groq key', key, 'https://api.groq.com/openai/v1/models', { Authorization: `Bearer ${key}` }, f);
export const openRouterKey = (key, f) =>
  getWithKey('OpenRouter key', key, 'https://openrouter.ai/api/v1/key', { Authorization: `Bearer ${key}` }, f);

export async function cloudflareToken(env, fetchImpl) {
  const name = 'Cloudflare API token';
  return safe(name, async () => {
    const token = env.CLOUDFLARE_API_TOKEN;
    const acct = env.CLOUDFLARE_ACCOUNT_ID;
    if (!has(token) || !has(acct)) return result(name, false, 'missing');
    if (!/^[0-9a-f]{32}$/.test(acct)) return result(name, false, 'malformed account id');
    const headers = { Authorization: `Bearer ${token}` };
    const verify = async (url) => {
      const res = await http(fetchImpl, url, { headers });
      if (res.status !== 200) return { ok: false, status: res.status };
      const json = await res.json();
      return { ok: json?.success === true && json?.result?.status === 'active', status: 200 };
    };
    const a = await verify(`https://api.cloudflare.com/client/v4/accounts/${acct}/tokens/verify`);
    if (a.ok) return result(name, true, 'active (account token)');
    const u = await verify('https://api.cloudflare.com/client/v4/user/tokens/verify');
    if (u.ok) return result(name, true, 'active (user token)');
    return result(name, false, u.status === 200 ? 'not active' : `HTTP ${u.status}`);
  });
}

export async function vercelToken(env, fetchImpl) {
  const name = 'Vercel token';
  return safe(name, async () => {
    if (!has(env.VERCEL_TOKEN)) return result(name, false, 'missing');
    const res = await http(fetchImpl, 'https://api.vercel.com/v2/user', {
      headers: { Authorization: `Bearer ${env.VERCEL_TOKEN}` },
    });
    return res.status === 200 ? result(name, true, 'HTTP 200') : result(name, false, `HTTP ${res.status}`);
  });
}
