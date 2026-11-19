// Checks the committed offline ledger (M23 A2; D-1606, D-1609): `node scripts/research/registry-check.mjs --check`
// (npm `test:research-registry`, one step of the CI `app` job). Fails on a gap or repeat in `seq`, a repeated lineage-market
// look, a frozen file that is missing, a sha that does not match its frozen file (which is also a frozen file changed after
// its entry), and, with `--against <earlier ledger file>`, any earlier entry that was changed or removed (append-only).
// Options: `--root <dir>` reads the ledger and the frozen files from another folder (a test), `--ledger <relative path>`.
// Pure reads of committed files; no network, no secrets.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEngine } from "../arena/engine.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function parseArgs(argv) {
  const out = { check: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--check") out.check = true;
    else if (a === "--root" || a === "--ledger" || a === "--against") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      out[a.slice(2)] = v;
      i += 1;
    } else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

/** The problems of the ledger under `root`, in plain words (an empty list means it is sound). */
export async function checkRegistry({ root = ROOT, ledger, against } = {}) {
  const lib = await loadEngine(path.join("src", "lib", "research", "ledgerFile.ts"));
  const rel = ledger ?? lib.LEDGER_PATH;
  const read = (p) => {
    if (path.isAbsolute(p) || p.split(/[\\/]/).includes("..")) return null;
    const f = path.join(root, p);
    return existsSync(f) ? readFileSync(f, "utf8") : null;
  };
  const text = read(rel);
  if (text === null) return [`the ledger ${rel} is missing`];
  let parsed;
  try {
    parsed = lib.parseLedger(text);
  } catch (e) {
    return [`the ledger cannot be read: ${e.message}`];
  }
  const problems = lib.checkLedger(parsed.entries, read);
  if (against !== undefined) {
    const prev = readFileSync(path.resolve(against), "utf8");
    problems.push(...lib.appendOnlyProblems(lib.parseLedger(prev).entries, parsed.entries));
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    if (!args.check)
      throw new Error(
        "usage: registry-check.mjs --check [--root <dir>] [--ledger <path>] [--against <file>]",
      );
    const problems = await checkRegistry({
      root: args.root,
      ledger: args.ledger,
      against: args.against,
    });
    if (problems.length > 0) {
      for (const p of problems) console.error(`registry-check: ${p}`);
      process.exit(1);
    }
    console.log("registry-check: the offline ledger is sound");
  })().catch((e) => {
    console.error(`registry-check: ${e.message}`);
    process.exit(1);
  });
}
