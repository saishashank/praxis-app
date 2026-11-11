// The steelman's reader list, generated from the import graph (OPS-111 (9), D-977). Every source file
// outside src/lib/steelman that imports a steelman module is a "reader"; the list is stored in
// tests/security/steelman-readers.json and tests/security/steelmanBoundary.test.ts compares the live graph
// to it, so a new reader shows up as a reviewed diff of that file instead of a hand-kept set (the M11-lite
// residual 9). The forbidden-importer checks (arena, night, learning, pick writers ...) stay in the test.
//   node scripts/ci/steelman-readers.mjs            write the list
//   node scripts/ci/steelman-readers.mjs --check    exit 1 when the stored list differs from the graph
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const MANIFEST = "tests/security/steelman-readers.json";
const posix = (p) => p.split(path.sep).join("/");

const IMPORT_RE =
  /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;

export function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== ".next") walk(full, out);
    } else if (/\.(ts|tsx|mjs)$/.test(e.name)) out.push(full);
  }
  return out;
}

/** Repo-relative path (no extension) of an import specifier, or the bare package name. */
export function resolveSpec(file, spec) {
  if (spec.startsWith("@/")) return `src/${spec.slice(2)}`;
  if (spec.startsWith("."))
    return posix(path.relative(ROOT, path.resolve(path.dirname(file), spec)));
  return spec;
}

/** @param {string} src file text @returns {string[]} import specifiers */
export const specifiers = (src) => [...src.matchAll(IMPORT_RE)].map((m) => m[1] ?? m[2] ?? m[3]);

/** The sorted repo-relative files outside src/lib/steelman that import a steelman module. */
export function readers(root = ROOT) {
  const out = [];
  for (const f of walk(path.join(root, "src"))) {
    const rel = posix(path.relative(root, f));
    if (rel.startsWith("src/lib/steelman/")) continue;
    if (
      specifiers(fs.readFileSync(f, "utf8")).some((s) =>
        resolveSpec(f, s).startsWith("src/lib/steelman/"),
      )
    ) {
      out.push(rel);
    }
  }
  return out.sort();
}

export const render = (list) => `${JSON.stringify({ readers: list }, null, 2)}\n`;

function main(argv) {
  const text = render(readers());
  const file = path.join(ROOT, MANIFEST);
  if (argv.includes("--check")) {
    const have = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (have !== text) {
      console.log(
        `steelman-readers: ${MANIFEST} is stale. Run: node scripts/ci/steelman-readers.mjs`,
      );
      return 1;
    }
    console.log("steelman-readers: up to date");
    return 0;
  }
  fs.writeFileSync(file, text);
  console.log(`steelman-readers: wrote ${MANIFEST}`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
