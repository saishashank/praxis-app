import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as c from './checks.mjs';
import { run } from './stage1.mjs';

const json = (status, body) => ({ status, json: async () => body });
const throwing = (name) => async () => {
  const e = new Error('x');
  e.name = name;
  throw e;
};
const never = () => assert.fail('network call must not be made');

// ---------- Turso ----------
const tursoEnv = {
  TURSO_MAIN_URL: 'libsql://db-example.test',
  TURSO_MAIN_TOKEN: 'SECRET-VALUE-123',
  GITHUB_RUN_ID: '42',
  GITHUB_RUN_ATTEMPT: '1',
};
function tursoFake({ status = 200, mutate } = {}) {
  const calls = [];
  const f = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, init, body });
    const nonce = body.requests[1].stmt.args?.[0]?.value;
    const results = [
      { type: 'ok', response: { type: 'execute', result: { rows: [] } } },
      { type: 'ok', response: { type: 'execute', result: { rows: [] } } },
      { type: 'ok', response: { type: 'execute', result: { rows: [[{ type: 'text', value: nonce }]] } } },
      { type: 'ok', response: { type: 'execute', result: { rows: [] } } },
      { type: 'ok', response: { type: 'close' } },
    ];
    if (mutate) mutate(results);
    return json(status, { results });
  };
  f.calls = calls;
  return f;
}

test('turso: pass, sends exactly 5 requests in order with positional arg', async () => {
  const f = tursoFake();
  const r = await c.tursoRoundTrip(tursoEnv, f);
  assert.equal(r.ok, true);
  const { url, init, body } = f.calls[0];
  assert.equal(url, 'https://db-example.test/v2/pipeline');
  assert.equal(init.headers.Authorization, 'Bearer SECRET-VALUE-123');
  assert.ok(init.signal instanceof AbortSignal);
  const reqs = body.requests;
  assert.equal(reqs.length, 5);
  assert.match(reqs[0].stmt.sql, /^CREATE TABLE IF NOT EXISTS smoke_42_1 /);
  assert.match(reqs[1].stmt.sql, /^INSERT INTO smoke_42_1 \(v\) VALUES \(\?\)$/);
  assert.equal(reqs[1].stmt.args[0].type, 'text');
  assert.match(reqs[1].stmt.args[0].value, /^[0-9a-f]{32}$/);
  assert.match(reqs[2].stmt.sql, /^SELECT v FROM smoke_42_1$/);
  assert.match(reqs[3].stmt.sql, /^DROP TABLE smoke_42_1$/);
  assert.equal(reqs[4].type, 'close');
});
test('turso: https:// url accepted', async () => {
  const f = tursoFake();
  const r = await c.tursoRoundTrip({ ...tursoEnv, TURSO_MAIN_URL: 'https://db-example.test' }, f);
  assert.equal(r.ok, true);
});
test('turso: url conversion', () => {
  assert.equal(c.toHttpsUrl('libsql://a-b.example.test'), 'https://a-b.example.test');
  assert.equal(c.toHttpsUrl('https://a.example.test/'), 'https://a.example.test');
  assert.equal(c.toHttpsUrl('ftp://a.example.test'), null);
  assert.equal(c.toHttpsUrl(undefined), null);
});
test('turso: table name sanitisation', () => {
  assert.equal(c.sanitizeTableName('12;DROP', 'A-1'), 'smoke_12_drop_a_1');
});
test('turso: HTTP 401', async () => {
  const r = await c.tursoRoundTrip(tursoEnv, tursoFake({ status: 401 }));
  assert.deepEqual([r.ok, r.detail], [false, 'HTTP 401']);
});
test('turso: select mismatch', async () => {
  const f = tursoFake({ mutate: (res) => { res[2].response.result.rows = [[{ type: 'text', value: 'other' }]]; } });
  const r = await c.tursoRoundTrip(tursoEnv, f);
  assert.deepEqual([r.ok, r.detail], [false, 'select mismatch']);
});
test('turso: statement error', async () => {
  const f = tursoFake({ mutate: (res) => { res[0] = { type: 'error', error: { message: 'secret-ish' } }; } });
  const r = await c.tursoRoundTrip(tursoEnv, f);
  assert.deepEqual([r.ok, r.detail], [false, 'statement error']);
});
test('turso: missing / malformed / timeout', async () => {
  assert.equal((await c.tursoRoundTrip({ ...tursoEnv, TURSO_MAIN_TOKEN: '' }, never)).detail, 'missing');
  assert.equal((await c.tursoRoundTrip({ ...tursoEnv, TURSO_MAIN_URL: undefined }, never)).detail, 'missing');
  assert.equal((await c.tursoRoundTrip({ ...tursoEnv, TURSO_MAIN_URL: 'nonsense' }, never)).detail, 'malformed');
  assert.equal((await c.tursoRoundTrip(tursoEnv, throwing('TimeoutError'))).detail, 'TimeoutError');
});

// ---------- Resend ----------
const resendEnv = {
  RESEND_API_KEY: 'SECRET-VALUE-123', OWNER_EMAIL: 'owner@example.test',
  SMOKE_ENV: 'staging', GITHUB_RUN_ID: '42',
};
test('resend: pass and payload', async () => {
  let seen;
  const f = async (url, init) => { seen = { url, init }; return json(200, { id: 'abc' }); };
  const r = await c.resendTestEmail(resendEnv, f);
  assert.equal(r.ok, true);
  assert.equal(seen.url, 'https://api.resend.com/emails');
  const p = JSON.parse(seen.init.body);
  assert.ok(p.subject.startsWith('[TEST]'));
  assert.deepEqual(p.to, ['owner@example.test']);
  assert.ok(p.from.includes('onboarding@resend.dev'));
  assert.match(p.text, /staging/);
  assert.match(p.text, /No action needed\./);
  assert.ok(!r.detail.includes('owner@example.test'));
});
test('resend: 401, no id, missing, throw', async () => {
  assert.equal((await c.resendTestEmail(resendEnv, async () => json(401, {}))).detail, 'HTTP 401');
  assert.equal((await c.resendTestEmail(resendEnv, async () => json(200, {}))).ok, false);
  assert.equal((await c.resendTestEmail({ ...resendEnv, RESEND_API_KEY: '' }, never)).detail, 'missing');
  assert.equal((await c.resendTestEmail({ ...resendEnv, OWNER_EMAIL: '' }, never)).detail, 'missing');
  assert.equal((await c.resendTestEmail(resendEnv, throwing('TypeError'))).detail, 'TypeError');
});

// ---------- format checks ----------
test('hexSecret', async () => {
  assert.equal((await c.hexSecret('X', 'a'.repeat(64))).ok, true);
  assert.equal((await c.hexSecret('X', 'A'.repeat(64))).detail, 'malformed');
  assert.equal((await c.hexSecret('X', 'a'.repeat(63))).detail, 'malformed');
  assert.equal((await c.hexSecret('X', '')).detail, 'missing');
  assert.equal((await c.hexSecret('X', undefined)).detail, 'missing');
});
test('agePublicKey', async () => {
  assert.equal((await c.agePublicKey('age1' + 'q'.repeat(58))).ok, true);
  assert.equal((await c.agePublicKey('age1' + 'b'.repeat(58))).detail, 'malformed'); // b not in bech32
  assert.equal((await c.agePublicKey('age1short')).detail, 'malformed');
  assert.equal((await c.agePublicKey('')).detail, 'missing');
});
test('emailShape never echoes value', async () => {
  const ok = await c.emailShape('OWNER_EMAIL', 'owner@example.test');
  assert.equal(ok.ok, true);
  assert.ok(!JSON.stringify(ok).includes('owner@example.test'));
  const bad = await c.emailShape('OWNER_EMAIL', 'not-an-email');
  assert.deepEqual([bad.ok, bad.detail], [false, 'malformed']);
  assert.equal((await c.emailShape('OWNER_EMAIL', '')).detail, 'missing');
});

// ---------- GitHub / LLM / Vercel ----------
test('githubRepoRead', async () => {
  let seen;
  const f = async (url, init) => { seen = { url, init }; return json(200, {}); };
  const r = await c.githubRepoRead('SECRET-VALUE-123', 'org/repo-data', 'data repo', f);
  assert.equal(r.ok, true);
  assert.equal(r.name, 'GitHub read: data repo');
  assert.equal(seen.url, 'https://api.github.com/repos/org/repo-data');
  assert.equal(seen.init.headers['X-GitHub-Api-Version'], '2022-11-28');
  assert.equal(seen.init.headers['User-Agent'], 'praxis-smoke');
  assert.equal((await c.githubRepoRead('t', 'org/r', 'data repo', async () => json(404, {}))).detail, 'HTTP 404');
  assert.equal((await c.githubRepoRead('', 'org/r', 'data repo', never)).detail, 'missing');
  assert.equal((await c.githubRepoRead('t', 'bad', 'data repo', never)).detail, 'malformed');
  assert.equal((await c.githubRepoRead('t', 'org/r', 'data repo', throwing('TimeoutError'))).detail, 'TimeoutError');
});
test('LLM key checks', async () => {
  const urls = [];
  const f = async (url, init) => { urls.push([url, init.headers]); return json(200, {}); };
  assert.equal((await c.googleAiKey('K', f)).ok, true);
  assert.equal((await c.groqKey('K', f)).ok, true);
  assert.equal((await c.openRouterKey('K', f)).ok, true);
  assert.equal(urls[0][0], 'https://generativelanguage.googleapis.com/v1beta/models');
  assert.equal(urls[0][1]['x-goog-api-key'], 'K');
  assert.equal(urls[1][0], 'https://api.groq.com/openai/v1/models');
  assert.equal(urls[2][0], 'https://openrouter.ai/api/v1/key');
  assert.equal(urls[2][1].Authorization, 'Bearer K');
  for (const fn of [c.googleAiKey, c.groqKey, c.openRouterKey]) {
    assert.equal((await fn('K', async () => json(401, {}))).detail, 'HTTP 401');
    assert.equal((await fn('', never)).detail, 'missing');
    assert.equal((await fn('K', throwing('TypeError'))).detail, 'TypeError');
  }
});
test('vercelToken', async () => {
  const env = { VERCEL_TOKEN: 'SECRET-VALUE-123' };
  assert.equal((await c.vercelToken(env, async () => json(200, {}))).ok, true);
  assert.equal((await c.vercelToken(env, async () => json(403, {}))).detail, 'HTTP 403');
  assert.equal((await c.vercelToken({}, never)).detail, 'missing');
  assert.equal((await c.vercelToken(env, throwing('TimeoutError'))).detail, 'TimeoutError');
});

// ---------- Cloudflare ----------
const cfEnv = { CLOUDFLARE_API_TOKEN: 'SECRET-VALUE-123', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32) };
const active = { success: true, result: { status: 'active' } };
test('cloudflare: account endpoint passes', async () => {
  const urls = [];
  const f = async (url) => { urls.push(url); return json(200, active); };
  assert.equal((await c.cloudflareToken(cfEnv, f)).ok, true);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /\/accounts\/a{32}\/tokens\/verify$/);
});
test('cloudflare: account fails, user endpoint passes', async () => {
  const f = async (url) => (url.includes('/accounts/') ? json(401, {}) : json(200, active));
  const r = await c.cloudflareToken(cfEnv, f);
  assert.deepEqual([r.ok, r.detail], [true, 'active (user token)']);
});
test('cloudflare: both fail / inactive / missing / malformed / throw', async () => {
  assert.equal((await c.cloudflareToken(cfEnv, async () => json(401, {}))).detail, 'HTTP 401');
  const inactive = { success: true, result: { status: 'expired' } };
  assert.equal((await c.cloudflareToken(cfEnv, async () => json(200, inactive))).detail, 'not active');
  assert.equal((await c.cloudflareToken({ ...cfEnv, CLOUDFLARE_API_TOKEN: '' }, never)).detail, 'missing');
  assert.equal((await c.cloudflareToken({ ...cfEnv, CLOUDFLARE_ACCOUNT_ID: 'xyz' }, never)).detail, 'malformed account id');
  assert.equal((await c.cloudflareToken(cfEnv, throwing('TimeoutError'))).detail, 'TimeoutError');
});

// ---------- runner ----------
const SECRETS = {
  TURSO_MAIN_URL: 'libsql://db-example.test',
  TURSO_MAIN_TOKEN: 'SECRET-VALUE-123',
  RESEND_API_KEY: 'SECRET-VALUE-RESEND',
  OWNER_EMAIL: 'owner@example.test',
  OWNER_RECOVERY_EMAIL: 'recovery@example.test',
  ACTIONS_HMAC_SECRET: 'a'.repeat(64),
  PII_HASH_KEY: 'b'.repeat(64),
  BACKUP_PUBLIC_KEY: 'age1' + 'q'.repeat(58),
  DATA_REPO_TOKEN: 'SECRET-VALUE-DATA',
  FIXTURES_READ_TOKEN: 'SECRET-VALUE-FIX',
  GOOGLE_AI_API_KEY: 'SECRET-VALUE-G',
  GROQ_API_KEY: 'SECRET-VALUE-Q',
  OPENROUTER_API_KEY: 'SECRET-VALUE-O',
};
const runEnv = (extra = {}) => ({
  ...SECRETS, SMOKE_ENV: 'production', GITHUB_RUN_ID: '7', GITHUB_RUN_ATTEMPT: '1',
  DATA_REPO: 'org/praxis-app-data', FIXTURES_REPO: 'org/praxis-app-fixtures', ...extra,
});
function routerFetch(failHost) {
  return async (url, init) => {
    if (failHost && url.includes(failHost)) return json(401, { error: 'body with SECRET-VALUE-123' });
    if (url.includes('/v2/pipeline')) return tursoFake()(url, init);
    if (url.includes('resend.com')) return json(200, { id: 'e1' });
    return json(200, {});
  };
}
const collect = () => { const lines = []; return { lines, out: (s) => lines.push(s) }; };

test('runner: whole production suite passes and leaks nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-'));
  const summary = join(dir, 'summary.md');
  const { lines, out } = collect();
  const code = await run(['--suite', 'app-production'], runEnv({ GITHUB_STEP_SUMMARY: summary }), routerFetch(), out);
  assert.equal(code, 0);
  const all = lines.join('\n') + '\n' + readFileSync(summary, 'utf8');
  assert.match(all, /Stage 1 app-production: 11\/11 passed/);
  assert.match(all, /CHECK +\| RESULT \| DETAIL/);
  for (const v of [...Object.values(SECRETS), 'org/praxis-app', 'db-example.test', 'SECRET-VALUE']) {
    assert.ok(!all.includes(v), `output leaked a value: ${v.slice(0, 6)}...`);
  }
});
test('runner: a failure gives exit 1 and still leaks nothing', async () => {
  const { lines, out } = collect();
  const code = await run(['--suite', 'app-production'], runEnv(), routerFetch('api.groq.com'), out);
  assert.equal(code, 1);
  const all = lines.join('\n');
  assert.match(all, /Stage 1 app-production: 10\/11 passed/);
  assert.ok(!all.includes('SECRET-VALUE'));
});
test('runner: missing secrets fail without network', async () => {
  const { lines, out } = collect();
  const code = await run(['--suite', 'deploy-staging'], {}, never, out);
  assert.equal(code, 1);
  assert.match(lines.join('\n'), /missing/);
});
test('runner: unknown or missing suite gives exit 2', async () => {
  assert.equal(await run(['--suite', 'nope'], {}, never, () => {}), 2);
  assert.equal(await run([], {}, never, () => {}), 2);
  assert.equal(await run(['--suite', '__proto__'], {}, never, () => {}), 2);
});
test('runner: suites are the specified sizes', async () => {
  const sizes = {};
  for (const s of ['app-staging', 'ci-fixtures', 'deploy-production', 'deploy-staging']) {
    const { lines, out } = collect();
    await run(['--suite', s], runEnv({ CLOUDFLARE_API_TOKEN: 'T', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), VERCEL_TOKEN: 'T' }),
      async (url, init) => (url.includes('cloudflare') ? json(200, active) : routerFetch()(url, init)), out);
    sizes[s] = lines.at(-1);
  }
  assert.equal(sizes['app-staging'], 'Stage 1 app-staging: 6/6 passed');
  assert.equal(sizes['ci-fixtures'], 'Stage 1 ci-fixtures: 1/1 passed');
  assert.equal(sizes['deploy-production'], 'Stage 1 deploy-production: 2/2 passed');
  assert.equal(sizes['deploy-staging'], 'Stage 1 deploy-staging: 1/1 passed');
});
