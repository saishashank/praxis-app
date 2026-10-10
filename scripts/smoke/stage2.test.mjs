import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sign } from './sign.mjs';
import { run } from './stage2.mjs';

const SECRET = 'a'.repeat(64);
const URL_SECRET = 'https://praxis-secret-host.vercel.app';
const NOW_MS = 1_700_000_000_000;
const env = (over = {}) => ({ SMOKE_ENV: 'staging', APP_BASE_URL: URL_SECRET, ACTIONS_HMAC_SECRET: SECRET, ...over });
const report = (over = {}) => ({
  env: 'staging',
  commit: null,
  results: [
    { name: 'AUTH_SECRET format', ok: true, detail: 'present, 64 hex' },
    { name: 'WORKER_HMAC_SECRET format', ok: false, pending: true, detail: 'not set yet' },
  ],
  ...over,
});
const fakeFetch = (status = 200, body = report(), tiStatus = 401) => {
  const f = async (url, init) => {
    f.calls.push({ url, init });
    if (String(url).endsWith('/api/test-identity/login')) return { status: tiStatus, json: async () => ({}) };
    return { status, json: async () => body };
  };
  f.calls = [];
  return f;
};
const exec = async (e, f) => {
  const lines = [];
  const code = await run([], e, f, (s) => lines.push(s), () => NOW_MS);
  return { code, text: lines.join('\n') };
};

test('sign: known-answer vector', () => {
  const nonce = '0123456789abcdef0123456789abcdef';
  const body = '{"purpose":"self-check"}';
  const h = sign(SECRET, body, 1700000000, nonce);
  const expected = createHmac('sha256', SECRET).update(`1700000000.${nonce}.${body}`).digest('hex');
  assert.equal(h['X-Praxis-Signature'], expected);
  assert.equal(expected, 'd115837af5305a21feb65b671c7f044bb5c564d701b89c5badaf99b27c1747c8');
});

test('sends a signed POST that an independent verifier accepts', async () => {
  const f = fakeFetch();
  const { code } = await exec(env(), f);
  assert.equal(code, 0);
  const { url, init } = f.calls[0];
  assert.equal(url, `${URL_SECRET}/api/internal/self-check`);
  assert.equal(init.method, 'POST');
  assert.equal(init.body, '{"purpose":"self-check"}');
  assert.ok(init.signal instanceof AbortSignal);
  const h = init.headers;
  assert.equal(h['X-Praxis-Timestamp'], '1700000000');
  assert.match(h['X-Praxis-Nonce'], /^[0-9a-f]{32}$/);
  const mac = createHmac('sha256', SECRET).update(`${h['X-Praxis-Timestamp']}.${h['X-Praxis-Nonce']}.${init.body}`).digest('hex');
  assert.equal(h['X-Praxis-Signature'], mac);
});

test('each run uses a fresh nonce', async () => {
  const a = fakeFetch();
  const b = fakeFetch();
  await exec(env(), a);
  await exec(env(), b);
  assert.notEqual(a.calls[0].init.headers['X-Praxis-Nonce'], b.calls[0].init.headers['X-Praxis-Nonce']);
});

test('pending results are shown as PENDING and do not fail the run', async () => {
  const { code, text } = await exec(env(), fakeFetch());
  assert.equal(code, 0);
  assert.match(text, /WORKER_HMAC_SECRET format\s+\| PENDING/);
  assert.match(text, /Stage 2 staging: 2\/2 passed, 1 pending/);
});

test('a failing check exits 1', async () => {
  const bad = report({ results: [{ name: 'X', ok: false, detail: 'HTTP 401' }] });
  const { code, text } = await exec(env(), fakeFetch(200, bad));
  assert.equal(code, 1);
  assert.match(text, /X\s+\| FAIL\s+\| HTTP 401/);
});

test('environment mismatch exits 1', async () => {
  const { code, text } = await exec(env({ SMOKE_ENV: 'production' }), fakeFetch());
  assert.equal(code, 1);
  assert.match(text, /ENVIRONMENT MISMATCH/);
});

test('non-200 prints only the status', async () => {
  const { code, text } = await exec(env(), fakeFetch(401, { error: 'unauthorized' }));
  assert.equal(code, 1);
  assert.equal(text, 'HTTP 401');
});

test('missing APP_BASE_URL is skipped with exit 1 and no request', async () => {
  const f = fakeFetch();
  const { code, text } = await exec(env({ APP_BASE_URL: '' }), f);
  assert.equal(code, 1);
  assert.equal(text, 'APP_BASE_URL not set — stage 2 skipped (add it to the GitHub environment)');
  assert.equal(f.calls.length, 0);
});

test('missing secret or SMOKE_ENV exits 1 without a request', async () => {
  const f = fakeFetch();
  assert.equal((await exec(env({ ACTIONS_HMAC_SECRET: undefined }), f)).code, 1);
  assert.equal((await exec(env({ SMOKE_ENV: undefined }), f)).code, 1);
  assert.equal(f.calls.length, 0);
});

test('network failure prints the error name only', async () => {
  const f = async () => {
    throw Object.assign(new Error(`boom ${URL_SECRET}`), { name: 'TimeoutError' });
  };
  const { code, text } = await exec(env(), f);
  assert.equal(code, 1);
  assert.equal(text, 'request failed: TimeoutError');
});

test('malformed response is rejected', async () => {
  assert.equal((await exec(env(), fakeFetch(200, { results: 'x' }))).code, 1);
  assert.equal((await exec(env(), fakeFetch(200, { results: [{ name: 1 }] }))).code, 1);
});

test('output never contains the secret or the URL', async () => {
  for (const f of [fakeFetch(), fakeFetch(500), fakeFetch(200, report({ env: 'production' }))]) {
    const { text } = await exec(env(), f);
    assert.ok(!text.includes(SECRET));
    assert.ok(!text.includes('praxis-secret-host'));
  }
});

test('step summary is written when GITHUB_STEP_SUMMARY is set', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'smoke2-')), 'summary.md');
  await exec(env({ GITHUB_STEP_SUMMARY: file }), fakeFetch());
  const md = readFileSync(file, 'utf8');
  assert.match(md, /### Stage 2 staging/);
  assert.match(md, /\| WORKER_HMAC_SECRET format \| PENDING \|/);
  assert.ok(!md.includes(SECRET));
});

const ti = (f) => f.calls.find((c) => c.url.endsWith('/api/test-identity/login'));

test('production: test identity login must return 404 (SEC-109)', async () => {
  const prod = report({ env: 'production' });
  const ok = fakeFetch(200, prod, 404);
  const a = await exec(env({ SMOKE_ENV: 'production' }), ok);
  assert.equal(a.code, 0);
  assert.match(a.text, /Test identity login disableds+| PASSs+| HTTP 404/);
  assert.equal(ti(ok).init.method, 'POST');
  assert.equal(ti(ok).init.body, '{}');
  assert.equal(ti(ok).init.headers['X-Praxis-Signature'], undefined);
  assert.equal(ti(ok).url, `${URL_SECRET}/api/test-identity/login`);
  for (const status of [401, 200, 500]) {
    const b = await exec(env({ SMOKE_ENV: 'production' }), fakeFetch(200, prod, status));
    assert.equal(b.code, 1);
    assert.match(b.text, new RegExp(`Test identity login disabled\s+\| FAIL\s+\| HTTP ${status}`));
  }
});

test('staging: unsigned test identity login must return 401', async () => {
  const a = await exec(env(), fakeFetch(200, report(), 401));
  assert.equal(a.code, 0);
  assert.match(a.text, /Test identity login needs signatures+| PASSs+| HTTP 401/);
  for (const status of [404, 200]) {
    const b = await exec(env(), fakeFetch(200, report(), status));
    assert.equal(b.code, 1);
    assert.match(b.text, /Test identity login needs signatures+| FAIL/);
  }
});

test('test identity probe: network failure and unknown SMOKE_ENV fail safely', async () => {
  const f = async (url) => {
    if (String(url).endsWith('/api/test-identity/login')) throw Object.assign(new Error(URL_SECRET), { name: 'TimeoutError' });
    return { status: 200, json: async () => report() };
  };
  const a = await exec(env(), f);
  assert.equal(a.code, 1);
  assert.match(a.text, /request failed: TimeoutError/);
  assert.ok(!a.text.includes('praxis-secret-host'));
  const b = await exec(env({ SMOKE_ENV: 'other' }), fakeFetch(200, report({ env: 'other' })));
  assert.equal(b.code, 1);
  assert.match(b.text, /unknown SMOKE_ENV/);
  const c = async (url) => {
    if (String(url).endsWith('/api/test-identity/login')) throw 'x';
    return { status: 200, json: async () => report() };
  };
  assert.match((await exec(env(), c)).text, /request failed: Error/);
});

test('step summary includes the test identity row', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'smoke2-')), 'summary.md');
  await exec(env({ GITHUB_STEP_SUMMARY: file }), fakeFetch());
  assert.match(readFileSync(file, 'utf8'), /| Test identity login needs signature | PASS | HTTP 401 |/);
});
