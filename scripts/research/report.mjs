// Writes a research report (M23 R1; D-1610) from a result JSON:
//   node scripts/research/report.mjs --result <result.json> [--result <more.json> ...] [--out <file>]
// With several --result files (one item, several lineages) the output is one document: a table of verdicts, then each report.
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
      if (a === "--result") (out.results ??= []).push(v);
      else out.out = v;
      i += 1;
    } else {
      throw new Error(`unknown argument ${a}`);
    }
  }
  if (out.results === undefined) throw new Error("--result <result.json> is required");
  out.result = out.results[0];
  return out;
}

/** Render a result file to text with the engine's writer (no file is written). */
export async function renderFromFile(resultPath) {
  const input = JSON.parse(readFileSync(resultPath, "utf8"));
  const engine = await loadEngine(path.join("src", "lib", "research", "report.ts"));
  return { input, text: engine.renderReport(input) };
}

/** One document from several result files of one item: a table of verdicts, then each report in the order given. */
export async function renderMany(resultPaths) {
  const parts = [];
  for (const p of resultPaths) parts.push(await renderFromFile(path.resolve(p)));
  const item = parts[0].input.item;
  if (parts.some((x) => x.input.item !== item))
    throw new Error("every result must be of the same item");
  const rows = parts.map(({ input: i }) => {
    const label = i.statistic.variantLabel ?? "-";
    return `| ${i.title} | ${i.lineage} | ${label} | ${i.verdict} | ${i.n.setups} | ${i.n.blocks} |`;
  });
  const head = [
    `# ${item} summary`,
    "",
    "| Test | Lineage | Label | Verdict | Setups | Blocks |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
  return { input: parts[0].input, text: [head, ...parts.map((x) => x.text)].join("\n---\n\n") };
}

/** Write the report; returns the path written. */
export async function writeReport(argv) {
  const args = parseArgs(argv);
  const { input, text } =
    args.results.length === 1
      ? await renderFromFile(path.resolve(args.result))
      : await renderMany(args.results);
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
