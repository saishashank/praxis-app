// Command-line entry of the LLM bake-off (M6 T15; D-112 draft). Bundled and run by
// scripts/llm/bakeoff.mjs (dispatch-only workflow llm-bakeoff.yml, `production` environment, approved
// commit). All logic lives here so the tests can call it with fakes.
//
//   bakeoff [--golden DIR] [--date YYYY-MM-DD] [--run-id ID] [--report-out FILE] [--pause-ms N]
//           [--candidate KIND:MODEL]... [--trains KIND=yes|no]... [--checked KIND=YYYY-MM-DD]...
//
// KIND is google | groq | openrouter (OpenRouter models must end in ":free", LLM-003). Without
// --candidate the run is a SELF-CHECK: a perfect oracle provider over the golden set, no network, never
// stored. A provider without `--trains KIND=no` is treated as training on prompts (facts only, cannot
// pass); without `--checked KIND=DATE` its value is undated (cannot pass, LLM-040).
// env: keys GOOGLE_AI_API_KEY / GROQ_API_KEY / OPENROUTER_API_KEY (read by the adapters at call time,
// never printed); TURSO_MAIN_URL + TURSO_MAIN_TOKEN: when the URL is set, the rows of a live run are
// written to `bakeoff_result`. Output: the markdown report only (no prompts, no model text, no keys).
// Exit codes: 0 report produced, 1 failed, 2 usage.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import {
  createOracleProvider,
  goldenProblems,
  goldenSha,
  insertBakeoffRows,
  parseGolden,
  runBakeoff,
  type BakeoffRun,
  type Candidate,
} from "./bakeoff";
import { createLiveProvider, KEY_ENV, type LiveKind, type LlmProvider } from "./providers";
import { isRetired } from "./roster";

const DEFAULT_GOLDEN = "tests/fixtures/llm/golden-zz";
const KINDS: readonly LiveKind[] = ["google", "groq", "openrouter"];
const DATE_RE = new RegExp("^\\d{4}-\\d{2}-\\d{2}$");
const LIVE_TIMEOUT_MS = 60_000; // threshold-ok: HTTP timeout per call
const DEFAULT_PAUSE_MS = 4_000; // threshold-ok: stays under free-tier request-per-minute limits

export type CliDeps = {
  readonly out?: (line: string) => void;
  readonly now?: () => Date;
  readonly openDb?: (url: string, token: string | undefined) => Client;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Replaces the live adapters (tests); never used by the real script. */
  readonly makeProvider?: (spec: {
    kind: LiveKind;
    model: string;
    trainsOnPrompts: boolean;
  }) => LlmProvider;
  readonly cwd?: string;
};

class Usage extends Error {}

function flags(args: readonly string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name && typeof args[i + 1] === "string") out.push(args[i + 1]!);
  }
  return out;
}

/** Repeated flag whose values may each hold several space separated entries (workflow inputs). */
function listFlags(args: readonly string[], name: string): string[] {
  return flags(args, name).flatMap((v) => v.split(new RegExp("\\s+")).filter((x) => x !== ""));
}

function pairs(values: readonly string[], sep: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const v of values) {
    const i = v.indexOf(sep);
    if (i <= 0) throw new Usage(`bad value ${v}`);
    m.set(v.slice(0, i), v.slice(i + 1));
  }
  return m;
}

function loadGolden(dir: string) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  if (files.length === 0) throw new Usage("no golden files");
  return parseGolden(files.map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8"))));
}

export async function bakeoffMain(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  deps: CliDeps = {},
): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  try {
    const now = (deps.now ?? (() => new Date()))();
    const date = flags(argv, "--date")[0] ?? now.toISOString().slice(0, 10); // threshold-ok: length of an ISO date YYYY-MM-DD
    if (!DATE_RE.test(date)) throw new Usage("--date must be YYYY-MM-DD");
    const goldenDir = path.resolve(
      deps.cwd ?? process.cwd(),
      flags(argv, "--golden")[0] ?? DEFAULT_GOLDEN,
    );
    const items = loadGolden(goldenDir);
    const specs = listFlags(argv, "--candidate");
    const live = specs.length > 0;
    if (live) {
      const problems = goldenProblems(items);
      if (problems.length > 0) throw new Usage(`golden set too small: ${problems.join("; ")}`);
    }
    const trains = pairs(listFlags(argv, "--trains"), "=");
    const checked = pairs(listFlags(argv, "--checked"), "=");
    for (const v of checked.values())
      if (!DATE_RE.test(v)) throw new Usage("--checked needs a date");
    const pauseMs = Number(flags(argv, "--pause-ms")[0] ?? DEFAULT_PAUSE_MS);
    if (!Number.isInteger(pauseMs) || pauseMs < 0) throw new Usage("--pause-ms must be an integer");

    const candidates: Candidate[] = [];
    if (!live) {
      candidates.push({ provider: createOracleProvider(items), trainsOnPromptsCheckedD: date });
    } else {
      for (const spec of specs) {
        const i = spec.indexOf(":");
        const kind = spec.slice(0, i) as LiveKind;
        const model = spec.slice(i + 1);
        if (i <= 0 || !KINDS.includes(kind) || model === "")
          throw new Usage(`bad candidate ${spec}`);
        if (kind === "openrouter" && !model.endsWith(":free"))
          throw new Usage("openrouter models must end in :free (LLM-003)");
        if (isRetired(kind, model))
          throw new Usage(`${kind}:${model} is retired in the LLM roster (LLM-070)`);
        const trainsOnPrompts = trains.get(kind) !== "no";
        const provider = deps.makeProvider
          ? deps.makeProvider({ kind, model, trainsOnPrompts })
          : createLiveProvider({
              kind,
              models: { R1: model, R2: model, R3: model, R5: model },
              trainsOnPrompts,
              timeoutMs: LIVE_TIMEOUT_MS,
              env,
            });
        if (!provider.available()) throw new Usage(`${kind}: ${KEY_ENV[kind]} is not set`);
        candidates.push({ provider, trainsOnPromptsCheckedD: checked.get(kind) ?? null });
      }
    }

    const runId = flags(argv, "--run-id")[0] ?? `bakeoff-${date}-${goldenSha(items).slice(0, 8)}`;
    const run: BakeoffRun = await runBakeoff({
      runId,
      date,
      items,
      candidates,
      mode: live ? "live" : "mock",
      pauseMs: live ? pauseMs : 0,
      sleep: deps.sleep ?? (live ? (ms) => new Promise((r) => setTimeout(r, ms)) : undefined),
      now: deps.now,
    });
    out(run.report);
    if (!live) out("Self-check only: oracle provider, nothing stored.");

    const reportOut = flags(argv, "--report-out")[0];
    if (reportOut) writeFileSync(reportOut, run.report);

    const url = env.TURSO_MAIN_URL;
    if (live && url && url.trim() !== "") {
      const db = (deps.openDb ?? ((u, t) => createClient({ url: u, authToken: t })))(
        url,
        env.TURSO_MAIN_TOKEN,
      );
      try {
        const n = await insertBakeoffRows(db, run.rows);
        out(`bakeoff_result: ${n} rows written (${run.rows.length} offered)`);
      } finally {
        db.close();
      }
    } else if (live) {
      out("No database URL: report printed, rows not stored.");
    }
    return 0;
  } catch (e) {
    if (e instanceof Usage) {
      out(`usage: ${e.message}`);
      return 2;
    }
    // Never print driver or provider error text (SEC-110).
    out("bakeoff: failed");
    return 1;
  }
}
