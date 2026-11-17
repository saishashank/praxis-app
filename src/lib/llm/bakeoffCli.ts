// Command-line entry of the LLM bake-off (M6 T15; D-112 draft). Bundled and run by
// scripts/llm/bakeoff.mjs (dispatch-only workflow llm-bakeoff.yml, `production` environment, approved
// commit). All logic lives here so the tests can call it with fakes.
//
//   bakeoff [--golden DIR] [--date YYYY-MM-DD] [--run-id ID] [--report-out FILE] [--pause-ms N]
//           [--reports DIR]
//           [--candidate KIND:MODEL]... [--trains KIND=yes|no]... [--checked KIND=YYYY-MM-DD]...
//
// KIND is google | groq | openrouter (OpenRouter models must end in ":free", LLM-003).
// A candidate already run on this golden set and roster day (a committed report under --reports, default
// docs/test-reports, or a stored run) is refused (exit 2, D-1405): one run per candidate per golden version. Without
// --candidate the run is a SELF-CHECK: a perfect oracle provider over the golden set, no network, never
// stored. A provider without `--trains KIND=no` is treated as training on prompts (facts only, cannot
// pass); without `--checked KIND=DATE` its value is undated (cannot pass, LLM-040).
// env: keys GOOGLE_AI_API_KEY / GROQ_API_KEY / OPENROUTER_API_KEY (read by the adapters at call time,
// never printed); TURSO_MAIN_URL + TURSO_MAIN_TOKEN: when the URL is set, the rows of a live run are
// written to `bakeoff_result`. Output: the markdown report only (no prompts, no model text, no keys).
// Exit codes: 0 report produced, 1 failed, 2 usage.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@libsql/client";
import { scriptDb } from "@/lib/db/scriptClient.mjs";
import {
  createOracleProvider,
  goldenProblems,
  BakeoffRefused,
  goldenSha,
  insertBakeoffRows,
  parseGolden,
  priorRunsFromReport,
  runBakeoff,
  type BakeoffRun,
  type Candidate,
  type PriorRun,
} from "./bakeoff";
import { createLiveProvider, KEY_ENV, type LiveKind, type LlmProvider } from "./providers";
import { isRetired } from "./roster";

const DEFAULT_GOLDEN = "tests/fixtures/llm/golden-zz";
const KINDS: readonly string[] = ["google", "groq", "openrouter"];
const DEFAULT_REPORTS = "docs/test-reports";
const STORED_RUN_RE = new RegExp("^bakeoff-(\d{4}-\d{2}-\d{2})-([0-9a-f]{8})$");
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
  /** Earlier runs, replacing the reports folder and the stored rows (tests). */
  readonly prior?: readonly PriorRun[];
};

class Usage extends Error {}

/** The earlier runs the committed reports record (D-1405). A missing folder is no earlier run. */
function readReportRuns(dir: string): PriorRun[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".md"))
    .sort()
    .flatMap((n) => priorRunsFromReport(readFileSync(path.join(dir, n), "utf8")));
}

/**
 * The earlier runs the stored rows record. A row has no golden hash or roster day, so only a run id of the default form
 * `bakeoff-DATE-SHA8` counts, and the run's own date stands in for the roster day (D-1405).
 */
async function storedRuns(db: Client): Promise<PriorRun[]> {
  // rows-ok: one "overall" row per model per run, tens of rows over the project's life; no paging
  const res = await db.execute(
    "SELECT DISTINCT run_id, model_id FROM bakeoff_result WHERE category = 'overall'",
  );
  const out: PriorRun[] = [];
  for (const r of res.rows) {
    const m = STORED_RUN_RE.exec(String(r.run_id));
    if (m)
      out.push({
        model: String(r.model_id),
        goldenSha: m[2]!,
        rosterChecked: null,
        runDate: m[1]!,
      });
  }
  return out;
}

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
        const kind = spec.slice(0, i);
        const model = spec.slice(i + 1);
        if (i <= 0 || !KINDS.includes(kind) || model === "")
          throw new Usage(`bad candidate ${spec}`);
        if (kind === "openrouter" && !model.endsWith(":free"))
          throw new Usage("openrouter models must end in :free (LLM-003)");
        if (isRetired(kind, model))
          throw new Usage(`${kind}:${model} is retired in the LLM roster (LLM-070)`);
        const trainsOnPrompts = trains.get(kind) !== "no";
        const models = { R1: model, R2: model, R3: model, R5: model, R6: model, R7: model };
        let provider: LlmProvider;
        if (deps.makeProvider) {
          provider = deps.makeProvider({ kind: kind as LiveKind, model, trainsOnPrompts });
        } else {
          provider = createLiveProvider({
            kind: kind as LiveKind,
            models,
            trainsOnPrompts,
            timeoutMs: LIVE_TIMEOUT_MS,
            env,
          });
        }
        if (!provider.available())
          throw new Usage(`${kind}: ${KEY_ENV[kind as LiveKind]} is not set`);
        candidates.push({ provider, trainsOnPromptsCheckedD: checked.get(kind) ?? null });
      }
    }

    const runId = flags(argv, "--run-id")[0] ?? `bakeoff-${date}-${goldenSha(items).slice(0, 8)}`;
    const url = env.TURSO_MAIN_URL;
    const db =
      live && url && url.trim() !== ""
        ? (deps.openDb ?? ((u, t) => scriptDb({ url: u, token: t })))(url, env.TURSO_MAIN_TOKEN)
        : null;
    let run: BakeoffRun;
    try {
      const prior = live
        ? (deps.prior ?? [
            ...readReportRuns(
              path.resolve(
                deps.cwd ?? process.cwd(),
                flags(argv, "--reports")[0] ?? DEFAULT_REPORTS,
              ),
            ),
            ...(db ? await storedRuns(db) : []),
          ])
        : undefined;
      run = await runBakeoff({
        runId,
        date,
        items,
        candidates,
        mode: live ? "live" : "mock",
        pauseMs: live ? pauseMs : 0,
        sleep: deps.sleep ?? (live ? (ms) => new Promise((r) => setTimeout(r, ms)) : undefined),
        now: deps.now,
        prior,
      });
      out(run.report);
      if (!live) out("Self-check only: oracle provider, nothing stored.");

      const reportOut = flags(argv, "--report-out")[0];
      if (reportOut) writeFileSync(reportOut, run.report);

      if (db) {
        const n = await insertBakeoffRows(db, run.rows);
        out(`bakeoff_result: ${n} rows written (${run.rows.length} offered)`);
      } else if (live) {
        out("No database URL: report printed, rows not stored.");
      }
    } finally {
      db?.close();
    }
    return 0;
  } catch (e) {
    if (e instanceof BakeoffRefused) {
      out(`refused: ${e.message}`);
      return 2;
    }
    if (e instanceof Usage) {
      out(`usage: ${e.message}`);
      return 2;
    }
    // Never print driver or provider error text (SEC-110).
    out("bakeoff: failed");
    return 1;
  }
}
