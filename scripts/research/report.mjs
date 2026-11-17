// Writes a research report (M23 R1; D-1610) from a result JSON:
//   node scripts/research/report.mjs --result <result.json> [--out <file>]
// The result JSON has the shape of `ReportInput` in src/lib/research/report.ts. The default output is
// docs/test-reports/<item>.md in the repo; `--out` names another file. The input file may live anywhere (the offline
// runner writes it outside the repo); only the rendered text is written, and the writer refuses a verdict outside
// PASS / NULL / INCONCLUSIVE, a bad sha and any text that looks like a private path. No network, no secrets.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEngine } from "../arena/engine.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--result" || a === "--out") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      out[a.slice(2)] = v;
      i += 1;
    } else {
      throw new Error(`unknown argument ${a}`);
    }
  }
  if (out.result === undefined) throw new Error("--result <result.json> is required");
  return out;
}

/** Render a result file to text with the engine's writer (no file is written). */
export async function renderFromFile(resultPath) {
  const input = JSON.parse(readFileSync(resultPath, "utf8"));
  const engine = await loadEngine(path.join("src", "lib", "research", "report.ts"));
  return { input, text: engine.renderReport(input) };
}

/** Write the report; returns the path written. */
export async function writeReport(argv) {
  const args = parseArgs(argv);
  const { input, text } = await renderFromFile(path.resolve(args.result));
  if (!/^[A-Za-z0-9._-]+$/.test(input.item))
    throw new Error("item must be a plain file-name token");
  const target = path.resolve(
    args.out ?? path.join(ROOT, "docs", "test-reports", `${input.item}.md`),
  );
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text, "utf8");
  return target;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeReport(process.argv.slice(2)).then(
    (target) => {
      console.log(`report written: ${path.relative(ROOT, target)}`);
    },
    (e) => {
      console.error(`report: ${e.message}`);
      process.exit(1);
    },
  );
}
