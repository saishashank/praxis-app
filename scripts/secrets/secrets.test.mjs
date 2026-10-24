// The secrets tool (D-176): plan, store commands and the CLI with a fake runner (no store is touched).
import assert from "node:assert/strict";
import { test } from "node:test";
import { CHECKS, logicalName, planUpdate } from "./plan.mjs";
import { loadRows, main, parseCli } from "./secrets.mjs";
import { DEFAULT_TARGETS, parseNames, redact, writeSteps } from "./stores.mjs";

const rows = loadRows();
const targets = {
  ...DEFAULT_TARGETS,
  vercel: { teamId: "team_x", projects: { production: "prj_p", staging: "prj_s" } },
};

function fakeIo(answers = [], results = () => ({ code: 0, stdout: "", stderr: "" })) {
  const lines = [];
  const calls = [];
  return {
    lines,
    calls,
    io: {
      out: (s) => lines.push(s),
      rows,
      targets,
      prompter: { ask: async () => answers.shift() ?? "", close: () => {} },
      run: async (step, opts = {}) => {
        calls.push({ step, input: opts.input });
        return results(step);
      },
    },
  };
}

test("logical names drop the GitHub environment suffix", () => {
  assert.equal(logicalName("ACTIONS_HMAC_SECRET_PROD"), "ACTIONS_HMAC_SECRET");
  assert.equal(logicalName("WORKER_HMAC_SECRET"), "WORKER_HMAC_SECRET");
});

test("the worker preset is one value per name, written to every place that holds it", () => {
  const { groups } = planUpdate(rows, ["worker"]);
  assert.ok(groups.length >= 3);
  for (const g of groups) assert.equal(g.env, "production");
  const turso = groups.find((g) => g.logical === "TURSO_MAIN_URL");
  assert.deepEqual(
    turso.writes.map((w) => w.store),
    ["cloudflare-worker"],
  );
});

test("a generated row is made here unless --paste", () => {
  const made = planUpdate(rows, ["c2"]).groups;
  assert.ok(made.length > 0);
  for (const g of made) assert.equal(g.source, "generate");
  for (const g of planUpdate(rows, ["c2"], { paste: true }).groups) assert.equal(g.source, "paste");
});

test("--only narrows the stores; an unknown word is refused", () => {
  const { groups } = planUpdate(rows, ["turso-main-url"], { env: "all", stores: ["github-env"] });
  assert.ok(groups.length === 2);
  for (const g of groups) for (const w of g.writes) assert.equal(w.store, "github-env");
  assert.throws(() => planUpdate(rows, ["NOPE_NOT_A_SECRET"]), /unknown secret/);
});

test("value checks", () => {
  assert.ok(CHECKS.hex64("a".repeat(64)));
  assert.ok(!CHECKS.hex64("A".repeat(64)));
  assert.ok(CHECKS["libsql-url"]("libsql://praxis-main-x.turso.io"));
  assert.ok(!CHECKS.any("two words"));
});

test("store commands never carry the value as an argument", () => {
  const writes = [
    { store: "github-env", env: "production", githubEnv: "production", name: "X_PROD" },
    { store: "vercel-env", env: "staging", name: "X" },
    { store: "cloudflare-worker", env: "production", name: "X" },
  ];
  for (const w of writes) {
    const steps = writeSteps(w, targets);
    assert.ok(steps.some((s) => s.stdin));
    for (const s of steps) assert.ok(!s.args.includes("SECRET-VALUE"));
  }
  const v = writeSteps(writes[1], targets).at(-1);
  assert.equal(v.env.VERCEL_PROJECT_ID, "prj_s");
  assert.throws(
    () => writeSteps(writes[1], { ...targets, vercel: { teamId: null, projects: {} } }),
    /targets file/,
  );
});

test("names are read from list output; values are redacted", () => {
  assert.deepEqual(parseNames("github-env", 'x\n[{"name":"A"},{"name":"B"}]'), ["A", "B"]);
  assert.deepEqual(parseNames("vercel-env", " A   Encrypted  Production\n AB  x", ["A", "B"]), [
    "A",
  ]);
  assert.equal(redact("token abcd1234 failed abcd1234", ["abcd1234"]), "token *** failed ***");
});

test("parseCli", () => {
  const o = parseCli(["set", "b", "--env", "staging", "--only", "github,worker", "--dry-run"]);
  assert.equal(o.command, "set");
  assert.deepEqual(o.words, ["b"]);
  assert.deepEqual(o.stores, ["github-env", "cloudflare-worker"]);
  assert.throws(() => parseCli(["set", "b", "--env", "prod"]), /--env/);
  assert.throws(() => parseCli(["set", "b", "--only", "turso"]), /--only/);
});

test("set --dry-run prints the plan and runs nothing", async () => {
  const f = fakeIo();
  assert.equal(await main(["set", "worker", "--dry-run"], f.io), 0);
  assert.equal(f.calls.length, 0);
  assert.ok(f.lines.some((l) => l.includes("WORKER_HMAC_SECRET")));
});

test("set writes a generated value on stdin to every place and never prints it", async () => {
  const f = fakeIo(["yes"]);
  assert.equal(await main(["set", "c2"], f.io), 0);
  const inputs = f.calls.filter((c) => c.input).map((c) => c.input);
  assert.ok(inputs.length >= 2);
  assert.ok(inputs.every((v) => v === inputs[0] && /^[0-9a-f]{64}$/.test(v)));
  assert.ok(!f.lines.join("\n").includes(inputs[0]));
  for (const c of f.calls) assert.ok(!c.step.args.includes(inputs[0]));
});

test("set stops when the Owner does not answer yes", async () => {
  const f = fakeIo(["no"]);
  assert.equal(await main(["set", "c2"], f.io), 1);
  assert.equal(f.calls.length, 0);
});

test("a pasted value is checked; a failing store is reported without the value", async () => {
  const value = "re_GoodLookingKey123";
  const f = fakeIo(["yes", "not a key", value, value], (step) =>
    step.cmd === "gh"
      ? { code: 1, stdout: "", stderr: `HTTP 403 for ${value}` }
      : { code: 0, stdout: "", stderr: "" },
  );
  const code = await main(["set", "RESEND_API_KEY", "--env", "all"], f.io);
  const text = f.lines.join("\n");
  assert.ok(text.includes("does not look like"));
  assert.ok(!text.includes(value));
  if (text.includes("FAILED")) assert.equal(code, 1);
});

test("list --check marks present and missing names", async () => {
  const f = fakeIo([], (step) =>
    step.cmd === "gh"
      ? { code: 0, stdout: '[{"name":"TURSO_MAIN_URL_PROD"}]', stderr: "" }
      : {
          code: 1,
          stdout: "",
          stderr: "",
        },
  );
  await main(["list", "--check", "--only", "github"], f.io);
  const text = f.lines.join("\n");
  assert.ok(text.includes("✓ GitHub env production: TURSO_MAIN_URL_PROD"));
  assert.ok(text.includes("✗ "));
});
