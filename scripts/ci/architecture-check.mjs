// CI completeness check for docs/architecture/architecture.json (ARC-001, AT-58, D-366).
// Builds the model from the code and compares it with the committed file in both directions:
//   - an element the code has but the committed model lacks
//   - an element the committed model names that the code no longer has
// plus the generator's cross-checks, the spec-ID rule and freshness. Prints element ids only.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildModel, MODEL_PATH, render, ROOT } from "../architecture/generate.mjs";
import { validateModel } from "../architecture/schema.mjs";

/** Problems for the repo at `root`; [] when the committed model is complete and fresh. */
export function checkArchitecture(root = ROOT) {
  const { model, problems } = buildModel(root);
  const out = [...problems];
  const file = path.join(root, MODEL_PATH);
  if (!fs.existsSync(file)) return [...out, `${MODEL_PATH} is missing`];
  const text = fs.readFileSync(file, "utf8");
  let committed;
  try {
    committed = JSON.parse(text);
  } catch {
    return [...out, `${MODEL_PATH} is not valid JSON`];
  }
  out.push(...validateModel(committed));
  const have = new Set((committed.elements ?? []).map((e) => e?.id));
  const want = new Set(model.elements.map((e) => e.id));
  for (const id of want) if (!have.has(id)) out.push(`in code, missing from the model: ${id}`);
  for (const id of have) if (!want.has(id)) out.push(`in the model, gone from code: ${id}`);
  if (text !== render(model)) {
    out.push(`${MODEL_PATH} is stale. Run: node scripts/architecture/generate.mjs`);
  }
  return out;
}

export function main(root = ROOT, out = console.log) {
  const problems = checkArchitecture(root);
  if (!problems.length) {
    out("architecture-check: model complete and up to date");
    return 0;
  }
  for (const p of problems.slice(0, 40)) out(`architecture-check: ${p}`);
  if (problems.length > 40) out(`architecture-check: ... and ${problems.length - 40} more`);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
