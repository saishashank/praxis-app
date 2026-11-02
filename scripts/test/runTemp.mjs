// One Temp folder per test run, removed when the run ends (Owner 2026-10-30: the tests left
// bundle-scan-*, praxis-* and hygiene-* folders in Temp). Tests keep calling os.tmpdir() /
// mkdtemp as before; the runner points TEMP, TMP and TMPDIR at a run folder first, so every
// worker and child process writes inside it, and the whole folder goes at the end, pass or fail.
// A folder that cannot be removed yet (Windows keeps a database file locked for a moment after a
// worker exits) is swept by the next run once its owning process is gone.
// Zero dependencies.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const RUN_PREFIX = "praxis-test-run-";
const TEMP_VARS = ["TEMP", "TMP", "TMPDIR"];
const RUN_NAME = new RegExp(`^${RUN_PREFIX}(\\d+)-`);

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists, owned by someone else
  }
}

function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

/** Remove run folders under `base` whose owning process has exited. Returns how many went. */
export function sweepStaleRunTemps(base = os.tmpdir()) {
  let removed = 0;
  for (const name of fs.readdirSync(base)) {
    const m = RUN_NAME.exec(name);
    if (!m || alive(Number(m[1]))) continue;
    try {
      rm(path.join(base, name));
      removed += 1;
    } catch {
      // still locked: the next run tries again
    }
  }
  return removed;
}

/** Make the run folder under the real Temp and return the env overrides that point at it. */
export function createRunTemp(base = os.tmpdir()) {
  sweepStaleRunTemps(base);
  const dir = fs.mkdtempSync(path.join(base, `${RUN_PREFIX}${process.pid}-`));
  return { dir, env: Object.fromEntries(TEMP_VARS.map((k) => [k, dir])) };
}

/** Remove the run folder. Only a run folder is accepted, so a wrong path can never empty Temp. */
export function removeRunTemp(dir) {
  if (!RUN_NAME.test(path.basename(dir))) throw new Error(`not a run folder: ${dir}`);
  try {
    rm(dir);
  } catch (e) {
    console.warn(
      `runTemp: ${dir} not removed yet (${e.code ?? e.message}); the next run sweeps it`,
    );
  }
}

/** Point this process (and everything it starts later) at a fresh run folder; returns the cleanup. */
export function useRunTemp() {
  const saved = Object.fromEntries(TEMP_VARS.map((k) => [k, process.env[k]]));
  const { dir, env } = createRunTemp();
  Object.assign(process.env, env);
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    removeRunTemp(dir);
  };
}
