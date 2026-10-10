// TST-122: the generated route / server-action list must match the tested list.
// Generated list: src/app/**/route.ts (URL path + exported HTTP methods) and every exported async
// function of a file with a top-level "use server" directive. Tested list: tests/routes/manifest.json.
// Zero dependencies. Usage: node scripts/ci/route-coverage.mjs [repoRoot]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "coverage"]);
const SOURCE_RE = /\.(ts|tsx|js|jsx|mjs)$/;

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const posix = (p) => p.split(path.sep).join("/");

export function routeMethods(src) {
  const code = stripComments(src);
  const found = new Set();
  for (const m of METHODS) {
    const fn = new RegExp(`export\\s+(?:async\\s+)?function\\s+${m}\\b`);
    const cst = new RegExp(`export\\s+const\\s+${m}\\b`);
    if (fn.test(code) || cst.test(code)) found.add(m);
  }
  for (const match of code.matchAll(/export\s+const\s*\{([^}]*)\}\s*=/g)) {
    for (const part of match[1].split(",")) {
      const name = part.split(":").pop().trim();
      if (METHODS.includes(name)) found.add(name);
    }
  }
  return METHODS.filter((m) => found.has(m));
}

export function hasUseServer(src) {
  // The directive must come before any other statement (comments allowed).
  const head = stripComments(src).trimStart();
  return /^(["'])use server\1\s*;?/.test(head);
}

export function actionNames(src) {
  const code = stripComments(src);
  const names = new Set();
  for (const m of code.matchAll(/export\s+async\s+function\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*async\b/g)) {
    names.add(m[1]);
  }
  return [...names].sort();
}

/** URL path for src/app/<segments>/route.ts: route groups "(x)" are dropped. */
export function urlPathFor(relDirFromApp) {
  const segs = relDirFromApp
    .split("/")
    .filter((s) => s && !(s.startsWith("(") && s.endsWith(")")) && !s.startsWith("@"));
  return "/" + segs.join("/");
}

/** Returns Map<id, { kind, mention }>; mention is the text a covering test file must contain. */
export function generate(root) {
  const appDir = path.join(root, "src", "app");
  const list = new Map();
  for (const file of walk(path.join(root, "src"))) {
    const rel = posix(path.relative(root, file));
    if (!SOURCE_RE.test(file)) continue;
    const src = fs.readFileSync(file, "utf8");
    if (/^route\.(ts|js|mjs|tsx|jsx)$/.test(path.basename(file)) && file.startsWith(appDir)) {
      const dirFromApp = posix(path.relative(appDir, path.dirname(file)));
      const url = urlPathFor(dirFromApp);
      const mention = url.slice(1);
      for (const method of routeMethods(src)) {
        list.set(`${method} ${url}`, { kind: "route", mention });
      }
    } else if (hasUseServer(src)) {
      for (const name of actionNames(src)) {
        list.set(`action ${rel}#${name}`, { kind: "action", mention: name });
      }
    }
  }
  return list;
}

export function check(root, manifest) {
  const problems = [];
  const generated = generate(root);
  const entries = manifest && typeof manifest.routes === "object" ? manifest.routes : {};
  for (const id of generated.keys()) {
    if (!entries[id]) problems.push(`untested: ${id} is not in the manifest`);
  }
  for (const [id, entry] of Object.entries(entries)) {
    const gen = generated.get(id);
    if (!gen) {
      problems.push(`stale: manifest entry ${id} no longer exists in the code`);
      continue;
    }
    const tests = Array.isArray(entry?.tests) ? entry.tests : [];
    if (tests.length === 0) problems.push(`no tests: ${id} lists no test files`);
    const covered = [];
    for (const t of tests) {
      const full = path.join(root, t);
      if (!fs.existsSync(full)) {
        problems.push(`missing file: ${id} references ${t}, which does not exist`);
        continue;
      }
      covered.push(fs.readFileSync(full, "utf8"));
    }
    // Auth.js-owned routes have no app-level test that names the path; file existence is checked.
    if (entry?.owner === "auth.js" || covered.length === 0) continue;
    if (!covered.some((text) => text.includes(gen.mention))) {
      problems.push(`not mentioned: no test file of ${id} contains "${gen.mention}"`);
    }
  }
  return { problems, generated: generated.size, listed: Object.keys(entries).length };
}

function main() {
  const root = path.resolve(process.argv[2] ?? ".");
  const manifestPath = path.join(root, "tests", "routes", "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    console.error(`route-coverage: cannot read ${posix(path.relative(root, manifestPath))}`);
    process.exit(1);
  }
  const { problems, generated, listed } = check(root, manifest);
  if (problems.length > 0) {
    for (const p of problems) console.error(`route-coverage: ${p}`);
    console.error(`route-coverage: FAILED (${problems.length} problem(s))`);
    process.exit(1);
  }
  console.log(`route-coverage: ok (${generated} routes/actions generated, ${listed} in manifest)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
