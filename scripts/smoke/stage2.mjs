// Stage 2 (Vercel part): signed call to the self-check route (BLD-011, SEC-101, SEC-017).
// Usage: node scripts/smoke/stage2.mjs  (env: SMOKE_ENV, APP_BASE_URL, ACTIONS_HMAC_SECRET)
// Output contains only check names, PASS/FAIL/PENDING and the safe `detail` strings the route
// returns. The URL, the secret and any response body are never printed.
import { appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sign } from './sign.mjs';

const TIMEOUT_MS = 30000;
const BODY = '{"purpose":"self-check"}';
const has = (v) => typeof v === 'string' && v.trim() !== '';

// SEC-109: the staging-only test login must not exist in production (404) and must demand a
// signature on staging (401 for an unsigned call). The response body is never read or printed.
async function testIdentityProbe(env, fetchImpl) {
  const production = env.SMOKE_ENV === 'production';
  const name = production ? 'Test identity login disabled' : 'Test identity login needs signature';
  const want = production ? 404 : 401;
  if (!production && env.SMOKE_ENV !== 'staging') return { name, ok: false, detail: 'unknown SMOKE_ENV' };
  try {
    const res = await fetchImpl(`${env.APP_BASE_URL.replace(/\/+$/, '')}/api/test-identity/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { name, ok: res.status === want, detail: `HTTP ${res.status}` };
  } catch (e) {
    return { name, ok: false, detail: `request failed: ${e && typeof e.name === 'string' ? e.name : 'Error'}` };
  }
}

export async function run(argv, env, fetchImpl, out, nowMs = () => Date.now()) {
  if (!has(env.APP_BASE_URL)) {
    out('APP_BASE_URL not set — stage 2 skipped (add it to the GitHub environment)');
    return 1;
  }
  if (!has(env.ACTIONS_HMAC_SECRET) || !has(env.SMOKE_ENV)) {
    out('ACTIONS_HMAC_SECRET or SMOKE_ENV not set — stage 2 cannot run');
    return 1;
  }
  const headers = {
    'Content-Type': 'application/json',
    ...sign(env.ACTIONS_HMAC_SECRET, BODY, Math.floor(nowMs() / 1000), randomBytes(16).toString('hex')),
  };
  let report;
  try {
    const res = await fetchImpl(`${env.APP_BASE_URL.replace(/\/+$/, '')}/api/internal/self-check`, {
      method: 'POST',
      headers,
      body: BODY,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status !== 200) {
      out(`HTTP ${res.status}`);
      return 1;
    }
    report = await res.json();
  } catch (e) {
    out(`request failed: ${e && typeof e.name === 'string' ? e.name : 'Error'}`);
    return 1;
  }
  const results = Array.isArray(report?.results) ? report.results : null;
  if (!results || !results.every((r) => r && typeof r.name === 'string' && typeof r.detail === 'string')) {
    out('unexpected response');
    return 1;
  }
  const label = (r) => (r.pending ? 'PENDING' : r.ok ? 'PASS' : 'FAIL');
  const ti = await testIdentityProbe(env, fetchImpl);
  const w = Math.max(5, ti.name.length, ...results.map((r) => r.name.length));
  out(`${'CHECK'.padEnd(w)} | RESULT  | DETAIL`);
  for (const r of [...results, ti]) out(`${r.name.padEnd(w)} | ${label(r).padEnd(7)} | ${r.detail}`);
  const all = [...results, ti];
  const counted = all.filter((r) => !r.pending);
  const passed = counted.filter((r) => r.ok).length;
  const pending = all.length - counted.length;
  const envOk = report.env === env.SMOKE_ENV;
  const line = `Stage 2 ${env.SMOKE_ENV}: ${passed}/${counted.length} passed, ${pending} pending${envOk ? '' : ', ENVIRONMENT MISMATCH'}`;
  out(line);
  if (env.GITHUB_STEP_SUMMARY) {
    const md = [
      `### ${line}`, '', '| Check | Result | Detail |', '| --- | --- | --- |',
      ...all.map((r) => `| ${r.name} | ${label(r)} | ${r.detail} |`), '',
    ].join('\n');
    appendFileSync(env.GITHUB_STEP_SUMMARY, md);
  }
  return passed === counted.length && envOk ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await run(process.argv.slice(2), process.env, fetch, (s) => console.log(s)));
}
