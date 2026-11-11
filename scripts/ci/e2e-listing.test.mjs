// M18 D3 (TST-134, D-966, AT-85): every written e2e spec runs in CI, in exactly one lane. The `e2e` job of
// ci.yml names every spec file in a lane step; this test parses the workflow and fails when
//   - a file in e2e/ is in no lane step (it would never run),
//   - a file is in two lane steps (it would run twice, with two scenarios),
//   - a listed file does not exist,
//   - a `playwright test` step names no file (an implicit "run everything" hides unlisted specs),
//   - a spec states a lane (requireScenario / requireEnv) that is not the lane that lists it, or
//   - a spec still skips (test.skip), which is how a mis-listed spec used to pass silently.
// The checker is a pure function so the self-test can plant a file without touching the repository:
// a planted `e2e/zz-planted.spec.ts` fails it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SPEC = /e2e\/[\w.-]+\.spec\.ts/g;

/**
 * @param {{ specFiles: string[], ciText: string, readFile: (rel: string) => string, pkg: { scripts: Record<string,string> } }} i
 * @returns {string[]} problems (empty = the listing is complete and consistent)
 */
export function checkE2eListing({ specFiles, ciText, readFile, pkg }) {
  const problems = [];
  const steps = yaml.load(ciText)?.jobs?.e2e?.steps ?? [];
  /** @type {Map<string, { step: string, scenario: string, env: Record<string, unknown> }[]>} */
  const listed = new Map();
  for (const s of steps) {
    const run = typeof s.run === "string" ? s.run : "";
    if (!run) continue;
    let text = run;
    let scenario = String(s.env?.E2E_SCENARIO ?? "empty");
    let env = { ...(s.env ?? {}) };
    // `npm run <script>` -> the script file it starts, one level (test:lighthouse names its spec there)
    for (const m of run.matchAll(/npm run ([\w:.-]+)/g)) {
      const cmd = pkg.scripts[m[1]] ?? "";
      const file = /node (scripts\/[\w./-]+\.mjs)/.exec(cmd)?.[1];
      if (file) {
        const body = readFile(file);
        text += `\n${body}`;
        const sc = /E2E_SCENARIO: "(\w+)"/.exec(body)?.[1];
        if (sc) scenario = sc;
        for (const v of body.matchAll(/\b(LIGHTHOUSE|E2E_WALK)\s*:/g))
          env = { ...env, [v[1]]: "1" };
      }
    }
    const files = [...new Set(text.match(SPEC) ?? [])];
    if (/playwright test/.test(run) && files.length === 0) {
      problems.push(`step "${s.name}" runs playwright test without naming a spec file`);
    }
    for (const f of files) {
      if (!listed.has(f)) listed.set(f, []);
      listed.get(f).push({ step: String(s.name ?? run), scenario, env });
    }
  }
  const onDisk = new Set(specFiles);
  for (const f of specFiles) {
    const where = listed.get(f) ?? [];
    if (where.length === 0)
      problems.push(`${f} is in no lane step of the e2e job (it would never run)`);
    if (where.length > 1) {
      problems.push(
        `${f} is in ${where.length} lane steps (${where.map((w) => w.step).join(" | ")})`,
      );
    }
  }
  for (const f of listed.keys()) {
    if (!onDisk.has(f)) problems.push(`${f} is listed in the e2e job but does not exist`);
  }
  // the lane a spec states is the lane that lists it
  for (const f of specFiles) {
    const where = listed.get(f);
    if (!where || where.length !== 1) continue;
    const src = readFile(f);
    if (/\btest\.skip\(/.test(src))
      problems.push(`${f} skips (test.skip): use requireScenario so a wrong lane fails`);
    // a spec that states no scenario seeds itself and runs in any lane; one that states it must be in it
    const want = /requireScenario\("(\w+)"/.exec(src)?.[1] ?? null;
    if (want !== null && want !== where[0].scenario) {
      problems.push(`${f} needs scenario ${want} but its lane step runs ${where[0].scenario}`);
    }
    for (const m of src.matchAll(/requireEnv\("(\w+)"/g)) {
      if (!(m[1] in where[0].env))
        problems.push(`${f} needs ${m[1]} but its lane step does not set it`);
    }
  }
  return problems;
}

const real = () => ({
  specFiles: readdirSync(path.join(root, "e2e"))
    .filter((n) => n.endsWith(".spec.ts"))
    .map((n) => `e2e/${n}`)
    .sort(),
  ciText: readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8"),
  readFile: (rel) => readFileSync(path.join(root, rel), "utf8"),
  pkg: JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")),
});

test("every spec file in e2e/ is in exactly one lane step of the e2e job, in the lane it states", () => {
  const i = real();
  assert.ok(i.specFiles.length >= 28, "the e2e folder is read");
  assert.deepEqual(checkE2eListing(i), []);
});

test("self-test: a planted unlisted spec file fails the listing (AT-85)", () => {
  const i = real();
  const problems = checkE2eListing({
    ...i,
    specFiles: [...i.specFiles, "e2e/zz-planted.spec.ts"],
    readFile: (rel) => (rel === "e2e/zz-planted.spec.ts" ? "" : i.readFile(rel)),
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /e2e\/zz-planted\.spec\.ts is in no lane step/);
});

test("self-test: a file listed in two lanes, a listed file that is missing and a bare playwright run each fail", () => {
  const i = real();
  const twice = i.ciText.replace(
    "run: npx playwright test e2e/screens.spec.ts --project=screens",
    "run: npx playwright test e2e/screens.spec.ts e2e/home.spec.ts --project=screens",
  );
  assert.notEqual(twice, i.ciText);
  assert.match(
    checkE2eListing({ ...i, ciText: twice }).join("\n"),
    /e2e\/home\.spec\.ts is in 2 lane steps/,
  );
  const missing = checkE2eListing({
    ...i,
    specFiles: i.specFiles.filter((f) => f !== "e2e/shell.spec.ts"),
  });
  assert.match(
    missing.join("\n"),
    /e2e\/shell\.spec\.ts is listed in the e2e job but does not exist/,
  );
  const bare = i.ciText.replace(
    "run: npx playwright test e2e/screens.spec.ts --project=screens",
    "run: npx playwright test --project=screens",
  );
  const p = checkE2eListing({ ...i, ciText: bare }).join("\n");
  assert.match(p, /runs playwright test without naming a spec file/);
  assert.match(p, /e2e\/screens\.spec\.ts is in no lane step/);
});

test("self-test: a spec in the wrong lane, one that needs an unset variable and one that skips each fail", () => {
  const i = real();
  // m11l needs the rich scenario: move it to the populated lane step
  const moved = i.ciText
    .replace("e2e/m11l-steelman.spec.ts e2e/m13l-experts.spec.ts", "e2e/m13l-experts.spec.ts")
    .replace(
      "run: npx playwright test e2e/readability.spec.ts --project=desktop",
      "run: npx playwright test e2e/readability.spec.ts e2e/m11l-steelman.spec.ts --project=desktop",
    );
  assert.match(
    checkE2eListing({ ...i, ciText: moved }).join("\n"),
    /m11l-steelman\.spec\.ts needs scenario rich but its lane step runs populated/,
  );
  const noWalk = i.ciText.replace(/ {10}E2E_WALK: .*\n/, "");
  assert.notEqual(noWalk, i.ciText);
  assert.match(
    checkE2eListing({ ...i, ciText: noWalk }).join("\n"),
    /walks\.spec\.ts needs E2E_WALK but its lane step does not set it/,
  );
  const skipping = checkE2eListing({
    ...i,
    readFile: (rel) =>
      rel === "e2e/shell.spec.ts" ? `${i.readFile(rel)}\ntest.skip(true, "x");` : i.readFile(rel),
  });
  assert.match(skipping.join("\n"), /e2e\/shell\.spec\.ts skips/);
});

test("the lanes: empty, populated, rich and walks, with the Lighthouse script counted through npm run", () => {
  const i = real();
  const steps = yaml
    .load(i.ciText)
    .jobs.e2e.steps.filter((s) => s.run && /playwright|lighthouse/.test(s.run));
  const scenarios = new Set(steps.map((s) => String(s.env?.E2E_SCENARIO ?? "populated")));
  assert.deepEqual([...scenarios].sort(), ["empty", "populated", "rich"]);
  assert.equal(yaml.load(i.ciText).jobs.e2e["timeout-minutes"], 30);
  const rich = steps.find((s) => s.env?.E2E_STATES === "all");
  assert.equal(rich.env.E2E_SCENARIO, "rich");
  assert.ok(
    steps.some((s) => s.env?.E2E_WALK_ONLY && String(s.env.E2E_WALK).includes("runner.temp")),
  );
  // lighthouse.spec.ts is listed through its npm script (scripts/ci/lighthouse.mjs names it)
  assert.deepEqual(checkE2eListing(i), []);
  assert.match(
    readFileSync(path.join(root, "scripts/ci/lighthouse.mjs"), "utf8"),
    /e2e\/lighthouse\.spec\.ts/,
  );
});
