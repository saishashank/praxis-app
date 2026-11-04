// Fixtures loader (M2 T5, TST-105, SEC-110). Real recorded responses live only in the private
// fixtures repo; CI checks it out into `fixtures/` (job `fixtures`, token FIXTURES_READ_TOKEN in
// the ci-fixtures environment) and sets PRAXIS_FIXTURES_DIR. Locally and on fork PRs the variable
// is absent and fixture-backed tests skip with the message below. Synthetic fixtures (committed in
// tests/fixtures/synthetic/) are always available.
//
// Expected layout of the fixtures repo (TODO(fixtures): confirm when the first recordings land):
//   yahoo/*.json   bars.json-shaped arrays (may include deliberately bad bars)
//   asx/*.json     response envelopes { "status": number, "headers": {...}, "body": string }
//   recorded/<market>/<day>/bars.json   a recorded trading day (record-day.mjs); the same
//                  bars.json shape, so the Yahoo checks read it too
import fs from "node:fs";
import path from "node:path";

export const FIXTURES_ENV = "PRAXIS_FIXTURES_DIR";
export const SKIP_MESSAGE = `${FIXTURES_ENV} is not set or has no usable content; real-fixture tests are skipped (they run in CI only, job "fixtures")`;

export type FixturesState = { available: true; dir: string } | { available: false; reason: string };

export function resolveFixturesDir(
  env: Record<string, string | undefined> = process.env,
): FixturesState {
  const raw = env[FIXTURES_ENV];
  if (!raw || raw.trim() === "") return { available: false, reason: SKIP_MESSAGE };
  const dir = path.resolve(raw);
  try {
    if (!fs.statSync(dir).isDirectory()) {
      return { available: false, reason: `${FIXTURES_ENV} is not a directory; ${SKIP_MESSAGE}` };
    }
    if (fs.readdirSync(dir).filter((n) => !n.startsWith(".")).length === 0) {
      return { available: false, reason: `fixtures directory is empty; ${SKIP_MESSAGE}` };
    }
  } catch {
    return { available: false, reason: `${FIXTURES_ENV} does not exist; ${SKIP_MESSAGE}` };
  }
  return { available: true, dir };
}

/** Resolve `rel` inside `dir`; refuses absolute paths and any `..` escape. */
export function safeJoin(dir: string, rel: string): string {
  if (path.isAbsolute(rel) || rel.includes("\0")) throw new Error("fixture path must be relative");
  const root = path.resolve(dir);
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error("fixture path escapes the fixtures directory");
  }
  return full;
}

/** Sorted `recorded/<market>/<day>/bars.json` paths of the recorded trading days; empty when absent. */
export function listRecordedBars(dir: string): string[] {
  const out: string[] = [];
  for (const market of subdirs(dir, "recorded")) {
    for (const day of subdirs(dir, `recorded/${market}`)) {
      const rel = `recorded/${market}/${day}/bars.json`;
      if (isFile(dir, rel)) out.push(rel);
    }
  }
  return out.sort();
}

function subdirs(dir: string, rel: string): string[] {
  try {
    return fs
      .readdirSync(safeJoin(dir, rel), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function isFile(dir: string, rel: string): boolean {
  try {
    return fs.statSync(safeJoin(dir, rel)).isFile();
  } catch {
    return false;
  }
}

/** Sorted names of `*.json` files directly inside `<dir>/<sub>`; empty when the folder is absent. */
export function listFixtures(dir: string, sub: string): string[] {
  try {
    return fs
      .readdirSync(safeJoin(dir, sub), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => `${sub}/${e.name}`)
      .sort();
  } catch {
    return [];
  }
}

export function readFixtureText(dir: string, rel: string): string {
  return fs.readFileSync(safeJoin(dir, rel), "utf8");
}

export function readFixtureJson(dir: string, rel: string): unknown {
  return JSON.parse(readFixtureText(dir, rel));
}

/** Absolute directory of the committed synthetic fixtures. */
export function syntheticDir(root: string = process.cwd()): string {
  return path.join(root, "tests", "fixtures", "synthetic");
}
