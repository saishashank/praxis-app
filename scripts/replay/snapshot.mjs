// Replay snapshot builder CLI (M4 T4; DAT-140, design 4.7). Runs in an Actions job (read-only
// database token) after the history files were downloaded from the data repo's release assets
// into one flat folder (file names as in D-065: `<source>-<yyyy>-<mm>.jsonl.gz`).
//   node scripts/replay/snapshot.mjs --from YYYY-MM-DD --to YYYY-MM-DD --history-dir <dir>
//        --out <dir> [--recent-from YYYY-MM-DD]
// Bars and announcements before --recent-from come from the history files only; the database is
// read for the recent window (default: the last ~500 sessions) plus the small tables (calendar,
// universe snapshots, index bars, confirmed corporate actions). Never a row-by-row read of the old
// price history (DAT-140). Writes snapshot.jsonl.gz and snapshot.sha256 and prints the sha.
// env: TURSO_MAIN_URL, TURSO_MAIN_TOKEN. Output: counts and the sha only.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { isRealDate } from "../../src/lib/data/backfill/rules.mjs";
import { buildSnapshot } from "../../src/lib/data/backfill/snapshotCore.mjs";
import { loadInputs } from "../../src/lib/data/backfill/snapshotLoad.mjs";

const flag = (args, name) => {
  const i = args.indexOf(name);
  return i >= 0 && typeof args[i + 1] === "string" && args[i + 1] !== "" ? args[i + 1] : null;
};

/**
 * @param {string[]} argv @param {Record<string, string | undefined>} env
 * @param {{ openDb?: (url: string, token: string | undefined) => import("@libsql/client").Client,
 *   out?: (s: string) => void }} [deps]
 * @returns {Promise<number>} exit code
 */
export async function run(argv, env, deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const from = flag(argv, "--from");
  const to = flag(argv, "--to");
  const dir = flag(argv, "--history-dir");
  const outDir = flag(argv, "--out");
  const recentFrom = flag(argv, "--recent-from") ?? undefined;
  if (!isRealDate(from) || !isRealDate(to) || from > to || dir === null || outDir === null) {
    out("replay snapshot: failed (usage: --from D --to D --history-dir <dir> --out <dir>)");
    return 1;
  }
  if (recentFrom !== undefined && !isRealDate(recentFrom)) {
    out("replay snapshot: failed (bad --recent-from)");
    return 1;
  }
  const url = env.TURSO_MAIN_URL;
  const token = env.TURSO_MAIN_TOKEN;
  if (!url || (!token && !String(url).startsWith("file:"))) {
    out("replay snapshot: failed (database not configured)");
    return 1;
  }
  const open = deps.openDb ?? ((u, authToken) => createClient({ url: u, authToken }));
  const db = open(url, token || undefined);
  try {
    const inputs = await loadInputs({
      db,
      from,
      to,
      recentFrom,
      readAsset: (name) => {
        const p = path.join(dir, name);
        return existsSync(p) ? new Uint8Array(readFileSync(p)) : null;
      },
    });
    const snap = buildSnapshot({ from, to, inputs });
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, "snapshot.jsonl.gz"), snap.bytes);
    writeFileSync(path.join(outDir, "snapshot.sha256"), `${snap.sha}\n`);
    out(`replay snapshot: ok sha=${snap.sha} ${JSON.stringify(snap.counts)}`);
    return 0;
  } catch (e) {
    // Never print a driver error: it can carry the database URL.
    out(`replay snapshot: failed (${e?.name === "SnapshotError" ? e.reason : "unexpected error"})`);
    return 1;
  } finally {
    db.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run(process.argv.slice(2), process.env).then((c) => process.exit(c));
}
