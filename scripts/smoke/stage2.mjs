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
  const w = Math.max(5, ...results.map((r) => r.name.length));
  out(`${'CHECK'.padEnd(w)} | RESULT  | DETAIL`);
  for (const r of results) out(`${r.name.padEnd(w)} | ${label(r).padEnd(7)} | ${r.detail}`);
  const counted = results.filter((r) => !r.pending);
  const passed = counted.filter((r) => r.ok).length;
  const pending = results.length - counted.length;
  const envOk = report.env === env.SMOKE_ENV;
  const line = `Stage 2 ${env.SMOKE_ENV}: ${passed}/${counted.length} passed, ${pending} pending${envOk ? '' : ', ENVIRONMENT MISMATCH'}`;
  out(line);
  if (env.GITHUB_STEP_SUMMARY) {
    const md = [
      `### ${line}`, '', '| Check | Result | Detail |', '| --- | --- | --- |',
      ...results.map((r) => `| ${r.name} | ${label(r)} | ${r.detail} |`), '',
    ].join('\n');
    appendFileSync(env.GITHUB_STEP_SUMMARY, md);
  }
  return passed === counted.length && envOk ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await run(process.argv.slice(2), process.env, fetch, (s) => console.log(s)));
}
