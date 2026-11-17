// M22 L4 (D-1412, D-1513): the model keys are NOT in .github/workflows/arena-signals.yml today. The production job is locked to a
// stored copy (M8 T9) and changes only with the Owner's approval, which is asked for in the final pull request: the three secret
// names are added to the signals step and the lock re-stored at merge time (pending Owner approval). Until then the night is
// rules-only (the factory reports no_key). Checked by parsing the YAML (no GitHub, no secrets).
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./workflow-checks.mjs";
import { extractJobBlock, readLocked } from "./prod-job-lock.mjs";

const w = load("arena-signals");
const KEYS = ["GOOGLE_AI_API_KEY", "GROQ_API_KEY", "OPENROUTER_API_KEY"];

test("no model key is named anywhere in arena-signals.yml (pending Owner approval, D-1513)", () => {
  for (const k of KEYS) assert.ok(!w.text.includes(k), k);
  assert.doesNotMatch(w.text, /CF_WORKERS_AI_TOKEN|CF_ACCOUNT_ID/);
});

test("the production job is still the stored copy, and holds no model key", () => {
  assert.equal(extractJobBlock(w.text, "production"), readLocked("arena-signals"));
  assert.ok(!JSON.stringify(w.wf.jobs).match(/GROQ|GOOGLE_AI|OPENROUTER/));
  assert.equal(w.wf.env, undefined);
});
