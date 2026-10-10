// Stage 1 runner. Usage: node scripts/smoke/stage1.mjs --suite <name>
// Never echoes any environment value; output contains only check names,
// pass/fail and the safe `detail` strings from checks.mjs.
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SUITES } from './suites.mjs';

export async function run(argv, env, fetchImpl, out) {
  const i = argv.indexOf('--suite');
  const suite = i >= 0 ? argv[i + 1] : undefined;
  if (!suite || !Object.hasOwn(SUITES, suite)) {
    out(`Unknown or missing suite. Known suites: ${Object.keys(SUITES).join(', ')}`);
    return 2;
  }
  const results = [];
  for (const check of SUITES[suite]) {
    try {
      results.push(await check(env, fetchImpl));
    } catch (e) {
      results.push({ name: 'check', ok: false, detail: e && typeof e.name === 'string' ? e.name : 'Error' });
    }
  }
  const w = Math.max(5, ...results.map((r) => r.name.length));
  out(`${'CHECK'.padEnd(w)} | RESULT | DETAIL`);
  for (const r of results) out(`${r.name.padEnd(w)} | ${(r.ok ? 'PASS' : 'FAIL').padEnd(6)} | ${r.detail}`);
  const passed = results.filter((r) => r.ok).length;
  const line = `Stage 1 ${suite}: ${passed}/${results.length} passed`;
  out(line);
  if (env.GITHUB_STEP_SUMMARY) {
    const md = [
      `### ${line}`, '', '| Check | Result | Detail |', '| --- | --- | --- |',
      ...results.map((r) => `| ${r.name} | ${r.ok ? 'PASS' : 'FAIL'} | ${r.detail} |`), '',
    ].join('\n');
    appendFileSync(env.GITHUB_STEP_SUMMARY, md);
  }
  return passed === results.length ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await run(process.argv.slice(2), process.env, fetch, (s) => console.log(s)));
}
