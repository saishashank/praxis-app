// Batch 2b "signals and orders" CLI (M4 T8, ARN-060, ARN-020, design 4.1). Runs in the `production`
// GitHub environment on the approved commit (SEC-108 c) from .github/workflows/arena-signals.yml.
//   node scripts/arena/signals.mjs [--date YYYY-MM-DD] [--wait-minutes N] [--phase 2b|3|learn|words|all] [--now <ISO instant>]
// --now is the simulated clock of the CI recorded day (M18 D-965); refused unless PRAXIS_ENV=recorded.
// The default phase `all` runs batch 2b and then, when 2b succeeded, batch 3 (the deterministic review
// numbers: forward signal ledger, scorecards, ARN-101 re-check, kill switch, evidence timeline; M4 T15)
// in the same job; `--phase 3` re-runs batch 3 alone for a session whose 2b has succeeded. Then come
// the A6 phases (M6 T11): `learn` (attribution, comparisons, Critic gate, Lane A, challenger steps,
// plan; no model call) and `words` (Critic wording and the R5 narrative through the router, rules-only
// until the bake-off). `all` = 2b -> 3 -> learn -> words; `learn` and `words` run on a non-trading
// day too (a reduced run), and on a missing predecessor they run partial (status degraded).
// env: TURSO_MAIN_URL, TURSO_MAIN_TOKEN, COMMIT_SHA (optional), GITHUB_OUTPUT (optional)
// All logic lives in src/lib/arena/cli.ts (bundled by ./engine.mjs). In production with
// `market.mode != 'full'` it only records a skipped run record and writes nothing to the arena or
// agent tables (D-066, BLD-024). It waits for batch 2a of the same session and never decides a past
// session. Exit 0 success or expected skip, 1 failed, 2 usage.
// D-181: after a night that includes batch 3, the published picks (AGT-113, ARN-095) follow from their
// own bundle (src/lib/picks/cli.ts): this script passes the same arguments and nothing comes back but
// an exit code, so no arena module reads picks (tests/picks/isolation.test.ts).
// M11-lite (D-485): the steelman stage follows the same way from its own bundle
// (src/lib/steelman/cli.ts) after the picks; it never fails the night (it exits 0 and says degraded).
// M22 L4 (D-1511): after the picks come, each in its own bundle and each failing soft the same way, in this order: the
// MiniLM shadow (only when its model files are present, D-1514), the steelman, the pick reflections
// (src/lib/steelman/reflectCli.ts), the Committee trial pre-registration, the Committee (src/lib/committee/cli.ts), the trial
// result (the two trial steps only when src/lib/committee/trialCli.ts exists, D-1516), the monthly CXA-007 proposals (src/lib/research/proposals/cli.ts, M23 T3), the opinion meters (src/lib/opinions/cli.ts). No stage imports another. The model
// keys (GROQ_API_KEY, GOOGLE_AI_API_KEY, OPENROUTER_API_KEY) are read only by the factory, and only for a role listed in
// llm_live_roles (empty in production until the Owner opens it after a bake-off pass).
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEngine } from "./engine.mjs";
import { parseNow } from "../e2e-day/now.mjs";

const PICKS_ENTRY = "src/lib/picks/cli.ts";
const STEELMAN_ENTRY = "src/lib/steelman/cli.ts";
const REFLECT_ENTRY = "src/lib/steelman/reflectCli.ts";
const COMMITTEE_ENTRY = "src/lib/committee/cli.ts";
const TRIAL_ENTRY = "src/lib/committee/trialCli.ts";
const OPINIONS_ENTRY = "src/lib/opinions/cli.ts";
// M23 T3 (D-1738): the monthly CXA-007 proposal job; shadow only, a no-op while R2 is not live.
const PROPOSALS_ENTRY = "src/lib/research/proposals/cli.ts";
const MINILM_ENTRY = "src/lib/llm/minilm/cli.ts";
// D-1514: where the small reader's files would sit on the runner; absent today (nothing fetches them), so the step is a no-op.
const MINILM_MODEL = "models/minilm/model.onnx";
const MINILM_VOCAB = "models/minilm/vocab.txt";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** @param {string[]} argv @param {Record<string, string | undefined>} env */
export async function run(argv0, env, deps0 = {}) {
  const sim = parseNow(argv0, env);
  if (sim.error) {
    (deps0.out ?? console.log)(`arena-2b: refused (${sim.error})`);
    return 2;
  }
  const argv = sim.argv;
  const deps = sim.nowMs ? { ...deps0, nowMs: sim.nowMs } : deps0;
  // `deps.loadEngine` lets a test break one bundle build (OPS-111 (5), D-1794); production passes nothing.
  const load = deps.loadEngine ?? loadEngine;
  const { signalsMain } = await load();
  const code = await signalsMain(argv, env, deps);
  if (code === 2) return code;
  const { picksMain } = await load(PICKS_ENTRY);
  const afterPicks = Math.max(code, await picksMain(argv, env, deps));
  // D-504: every stage after the picks is an opinion or a shadow only. A bundle that fails to build or a stage that throws
  // past its own guard is logged in one line and changes neither the exit code nor anything above, nor the stages after it.
  const soft = async (name, entry, exportName, args) => {
    try {
      const mod = await load(entry);
      await mod[exportName](args, env, deps);
    } catch (error) {
      const why = error instanceof Error ? error.name : "unknown";
      (deps.out ?? console.log)(`arena-${name}: degraded (stage not run: ${why})`);
    }
  };
  const root = deps.root ?? ROOT;
  const date = argv.indexOf("--date") >= 0 ? ["--date", argv[argv.indexOf("--date") + 1]] : [];
  if (existsSync(path.join(root, MINILM_MODEL)) && existsSync(path.join(root, MINILM_VOCAB)))
    await soft("minilm", MINILM_ENTRY, "minilmMain", [
      "shadow",
      "--model",
      path.join(root, MINILM_MODEL),
      "--vocab",
      path.join(root, MINILM_VOCAB),
      ...date,
    ]);
  await soft("steelman", STEELMAN_ENTRY, "steelmanMain", argv);
  await soft("reflect", REFLECT_ENTRY, "reflectMain", argv);
  // D-1516: the trial entry is wired only where the file exists (it arrives with task C2).
  const trial = existsSync(path.join(root, TRIAL_ENTRY));
  // D-1532: the night's own arguments follow, so the date and the replay refusal apply as for every other stage
  if (trial) await soft("trial", TRIAL_ENTRY, "trialMain", ["prereg", ...argv]);
  await soft("committee", COMMITTEE_ENTRY, "committeeMain", argv);
  if (trial) await soft("trial", TRIAL_ENTRY, "trialMain", ["result", ...argv]);
  // M23 T3 (D-1738): the monthly model-written proposals (shadow rows only), after the Committee and its trial result.
  await soft("proposals", PROPOSALS_ENTRY, "proposalsMain", argv);
  // M22 Z (D-1536): the bull and bear note meters and the promotion request come last; they print nothing on an empty night.
  await soft("opinions", OPINIONS_ENTRY, "opinionMetersMain", argv);
  return afterPicks;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await run(process.argv.slice(2), process.env));
}
