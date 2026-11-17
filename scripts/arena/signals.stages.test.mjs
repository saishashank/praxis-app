// M22 L4 (D-1511, D-1514, D-1516): the stages that follow the picks run in a fixed order, each in its own bundle, each
// failing soft (exit code and later stages unchanged), and no stage imports another. The bundles are replaced by recorders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./signals.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ENTRIES = {
  steelman: "src/lib/steelman/cli.ts",
  reflect: "src/lib/steelman/reflectCli.ts",
  committee: "src/lib/committee/cli.ts",
  trial: "src/lib/committee/trialCli.ts",
  minilm: "src/lib/llm/minilm/cli.ts",
  opinions: "src/lib/opinions/cli.ts",
  proposals: "src/lib/research/proposals/cli.ts",
};

function harness({ code = 0, breakEntry = null } = {}) {
  const calls = [];
  const loaded = [];
  const rec = (name) => async (args) => {
    calls.push([name, ...args]);
    return 0;
  };
  const loadEngine = async (entry) => {
    loaded.push(entry);
    if (entry === breakEntry) throw new SyntaxError("did not build");
    if (entry === undefined) return { signalsMain: async () => code };
    if (entry === "src/lib/picks/cli.ts") return { picksMain: rec("picks") };
    if (entry === ENTRIES.steelman) return { steelmanMain: rec("steelman") };
    if (entry === ENTRIES.reflect) return { reflectMain: rec("reflect") };
    if (entry === ENTRIES.committee) return { committeeMain: rec("committee") };
    if (entry === ENTRIES.trial) return { trialMain: rec("trial") };
    if (entry === ENTRIES.opinions) return { opinionMetersMain: rec("opinions") };
    if (entry === ENTRIES.proposals) return { proposalsMain: rec("proposals") };
    if (entry === ENTRIES.minilm) return { minilmMain: rec("minilm") };
    throw new Error(`unexpected entry ${entry}`);
  };
  return { calls, loaded, loadEngine };
}

function rootWith(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "praxis-stages-"));
  for (const f of files) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), "x");
  }
  return dir;
}

test("the stages run in order: steelman, reflections, Committee; each from its own bundle", async () => {
  const h = harness();
  const root = rootWith([]);
  try {
    const lines = [];
    const code = await run(
      ["--date", "2026-10-13"],
      {},
      { loadEngine: h.loadEngine, out: (s) => lines.push(s), root },
    );
    assert.equal(code, 0);
    assert.deepEqual(
      h.calls.map((c) => c[0]),
      ["picks", "steelman", "reflect", "committee", "proposals", "opinions"],
    );
    assert.equal(new Set(h.loaded).size, h.loaded.length, "one bundle per stage");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("each stage after the picks fails soft: one degraded line, exit code unchanged, later stages still run", async () => {
  for (const [name, exp] of [
    ["steelman", ["reflect", "committee", "proposals", "opinions"]],
    ["reflect", ["steelman", "committee", "proposals", "opinions"]],
    ["committee", ["steelman", "reflect", "proposals", "opinions"]],
    ["opinions", ["steelman", "reflect", "committee", "proposals"]],
    ["proposals", ["steelman", "reflect", "committee", "opinions"]],
  ]) {
    const h = harness({ code: 1, breakEntry: ENTRIES[name] });
    const lines = [];
    const root = rootWith([]);
    try {
      const code = await run([], {}, { loadEngine: h.loadEngine, out: (s) => lines.push(s), root });
      assert.equal(code, 1, `${name}: the batch's exit code stands`);
      assert.deepEqual(lines, [`arena-${name}: degraded (stage not run: SyntaxError)`]);
      for (const later of exp)
        assert.ok(
          h.calls.some((c) => c[0] === later),
          `${name}: ${later}`,
        );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a stage that throws at run time is soft too (D-504)", async () => {
  const h = harness();
  const base = h.loadEngine;
  const lines = [];
  const root = rootWith([]);
  try {
    const code = await run(
      [],
      {},
      {
        root,
        out: (s) => lines.push(s),
        loadEngine: async (entry) =>
          entry === ENTRIES.reflect
            ? {
                reflectMain: async () => {
                  throw new TypeError("boom");
                },
              }
            : base(entry),
      },
    );
    assert.equal(code, 0);
    assert.deepEqual(lines, ["arena-reflect: degraded (stage not run: TypeError)"]);
    assert.ok(h.calls.some((c) => c[0] === "committee"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the trial pre-registration runs before the Committee and its result after, only when its entry exists", async () => {
  const none = harness();
  const bare = rootWith([]);
  const withTrial = rootWith([ENTRIES.trial]);
  try {
    await run([], {}, { loadEngine: none.loadEngine, out: () => {}, root: bare });
    assert.ok(!none.loaded.includes(ENTRIES.trial));
    const h = harness();
    await run([], {}, { loadEngine: h.loadEngine, out: () => {}, root: withTrial });
    assert.deepEqual(
      h.calls.map((c) => c.slice(0, 2).join(" ")),
      [
        "picks",
        "steelman",
        "reflect",
        "trial prereg",
        "committee",
        "trial result",
        "proposals",
        "opinions",
      ],
    );
  } finally {
    rmSync(bare, { recursive: true, force: true });
    rmSync(withTrial, { recursive: true, force: true });
  }
});

test("the small reader's step runs only when both model files are present (D-1514)", async () => {
  const absent = harness();
  const bare = rootWith([]);
  const part = rootWith(["models/minilm/model.onnx"]);
  const full = rootWith(["models/minilm/model.onnx", "models/minilm/vocab.txt"]);
  try {
    await run([], {}, { loadEngine: absent.loadEngine, out: () => {}, root: bare });
    assert.ok(!absent.loaded.includes(ENTRIES.minilm));
    const one = harness();
    await run([], {}, { loadEngine: one.loadEngine, out: () => {}, root: part });
    assert.ok(!one.loaded.includes(ENTRIES.minilm));
    const h = harness();
    await run(
      ["--date", "2026-10-13"],
      {},
      { loadEngine: h.loadEngine, out: () => {}, root: full },
    );
    const call = h.calls.find((c) => c[0] === "minilm");
    assert.equal(call[1], "shadow");
    assert.deepEqual(call.slice(-2), ["--date", "2026-10-13"]);
    assert.equal(h.calls[1][0], "minilm", "after the picks, before the steelman");
  } finally {
    for (const d of [bare, part, full]) rmSync(d, { recursive: true, force: true });
  }
});

test("no stage entry imports another stage's entry (PRD-033)", () => {
  const names = [
    "steelman/cli",
    "steelman/reflectCli",
    "committee/cli",
    "committee/trialCli",
    "minilm/cli",
    "opinions/cli",
    "research/proposals/cli",
  ];
  for (const [stage, file] of Object.entries(ENTRIES)) {
    let text;
    try {
      text = readFileSync(path.join(repo, file), "utf8");
    } catch {
      continue; // trialCli.ts arrives with task C2
    }
    const specs = [...text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]);
    for (const spec of specs)
      for (const n of names)
        assert.ok(
          !spec.endsWith(n) &&
            !(
              spec.startsWith("./") &&
              n.split("/")[0] === path.dirname(file).split("/").pop() &&
              spec === `./${n.split("/")[1]}`
            ),
          `${stage} imports ${spec}`,
        );
  }
});
