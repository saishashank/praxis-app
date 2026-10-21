// Shared assertions for the M8 T12 workflow tests (staging-e2e-day, zap-baseline, nightly,
// mutation). Zero network, zero secrets: the YAML is parsed and checked as text. Not a test file
// itself (the node:test glob only takes *.test.mjs).
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const SHA_USES = /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/;

export function load(name) {
  const text = readFileSync(path.join(root, ".github/workflows", `${name}.yml`), "utf8");
  return { text, wf: yaml.load(text) };
}

const allUses = () => {
  const dir = path.join(root, ".github/workflows");
  const set = new Set();
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".yml"))) {
    for (const m of readFileSync(path.join(dir, f), "utf8").matchAll(
      /uses:\s*(\S+@[0-9a-f]{40})/g,
    )) {
      set.add(m[1]);
    }
  }
  return set;
};

export const stepsOf = (wf) => Object.values(wf.jobs).flatMap((j) => j.steps ?? []);

/** Rules every new workflow follows (SEC-107, SEC-110, decision 40). */
export function assertHardened(name, { text, wf }) {
  assert.deepEqual(wf.permissions, {}, `${name}: top-level permissions must be empty`);
  assert.doesNotMatch(text, /pull_request_target/);
  assert.doesNotMatch(text, /continue-on-error/);
  assert.doesNotMatch(text, /upload-artifact|download-artifact|actions\/cache/);
  assert.equal(wf.env === undefined || !JSON.stringify(wf.env).includes("secrets."), true);
  const known = allUses();
  for (const [id, job] of Object.entries(wf.jobs)) {
    assert.ok(job.permissions, `${name}/${id}: explicit job permissions`);
    for (const [scope, level] of Object.entries(job.permissions)) {
      assert.equal(level, "read", `${name}/${id}: ${scope} must be read`);
      assert.ok(
        ["contents", "actions"].includes(scope),
        `${name}/${id}: unexpected scope ${scope}`,
      );
    }
    assert.ok(job["timeout-minutes"] > 0, `${name}/${id}: timeout`);
    assert.equal(
      JSON.stringify(job.env ?? {}).includes("secrets."),
      false,
      `${name}/${id}: job env`,
    );
    for (const s of job.steps) {
      if (s.uses) {
        assert.match(s.uses, SHA_USES, `${name}/${id}: ${s.uses}`);
        assert.ok(
          known.has(s.uses),
          `${name}: ${s.uses} is not an SHA already used by another workflow`,
        );
      }
      if (s.run) {
        assert.doesNotMatch(
          s.run,
          /\$\{\{/,
          `${name}/${id}: expression inside run: ${s.name ?? ""}`,
        );
        assert.doesNotMatch(s.run, /\bsecrets\b/, `${name}/${id}: secrets in run`);
        assert.doesNotMatch(s.run, /npm (install|i)\b/, `${name}/${id}: npm ci only`);
        assert.doesNotMatch(s.run, /pip install/, `${name}/${id}: no pip install`);
        assert.doesNotMatch(s.run, /curl|wget/, `${name}/${id}: no downloads`);
      }
      assert.equal(
        JSON.stringify(s.with ?? {}).includes("secrets."),
        false,
        `${name}/${id}: secret in with:`,
      );
    }
  }
}

/** Secrets: only in `env:` of the named steps; returns the {step name -> secret names} map. */
export function secretsByStep(wf) {
  const out = {};
  for (const job of Object.values(wf.jobs)) {
    for (const s of job.steps) {
      const names = Object.values(s.env ?? {})
        .map((v) => /secrets\.(\w+)/.exec(String(v))?.[1])
        .filter(Boolean);
      if (names.length) out[s.name ?? s.uses] = names.sort();
      // nothing but env: may carry a secret
      const rest = { ...s, env: undefined };
      assert.equal(
        JSON.stringify(rest).includes("secrets."),
        false,
        `secret outside env: ${s.name}`,
      );
    }
  }
  return out;
}

/** No step prints a URL, and the summary text holds no URL-shaped literal. */
export function assertNoUrlOutput(text) {
  const echoes = text.split("\n").filter((l) => /\becho\b|GITHUB_STEP_SUMMARY/.test(l));
  for (const l of echoes) assert.doesNotMatch(l, /https?:\/\//, l);
}
