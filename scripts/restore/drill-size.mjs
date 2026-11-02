// Production-size restore drill (V1-S5, D-716; OPS-040, NFR-004 RTO <= 4 h). SYNTHETIC rows only:
// builds a main database through the real migrations, fills price_bar with N synthetic bars (the
// production table is about 490k rows after D-199 and the largest), dumps it page by page, parses
// and restores the stream into a fresh database in bounded batches, and compares every table's count
// and sha256. Prints the timings and a plain PASS / FAIL. Nothing is read from production and
// nothing leaves the temp folder; no network, no key.
//
//   node scripts/restore/drill-size.mjs --rows 500000 [--chunk 1000] [--max-seconds 3600]
//
// `--rows` defaults to 500000 (production size). The scheduled restore-drill workflow keeps using
// the real-key drill (drill-turso.mjs); this script is the size check that runs on the build
// machine / in the monthly drill job so the restore time is known BEFORE it is needed.
import { createClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadMigrations, migrateUp } from "../../src/lib/db/migrate-core.mjs";
import {
  dumpDatabase,
  parseBackup,
  restoreDatabase,
  RESTORE_CHUNK_STATEMENTS,
} from "../backup/core.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const NOW = "2026-01-02T03:04:05.678Z";
export const DEFAULT_ROWS = 500_000;
const SEED_BATCH = 2_000;

/** @param {string[]} argv */
export function parseArgs(argv) {
  const out = { rows: DEFAULT_ROWS, chunk: RESTORE_CHUNK_STATEMENTS, maxSeconds: 3600 };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = Number(argv[i + 1]);
    if (!Number.isInteger(v) || v < 1) throw new Error(`bad value for ${k}`);
    if (k === "--rows") out.rows = v;
    else if (k === "--chunk") out.chunk = v;
    else if (k === "--max-seconds") out.maxSeconds = v;
    else throw new Error(`unknown option ${k}`);
  }
  return out;
}

const isoDay = (i) => new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10);

/** Fill price_bar with `rows` unique synthetic bars (code x day), in write batches. */
async function seed(db, rows) {
  let made = 0;
  let code = 0;
  while (made < rows) {
    const stmts = [];
    for (; stmts.length < SEED_BATCH && made < rows; made++) {
      const c = made % 1000; // 1000 codes
      const day = Math.floor(made / 1000);
      code = c;
      const px = Math.round((10 + (c % 50) + Math.sin(day / 7) * 2) * 100) / 100;
      stmts.push({
        sql: `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
              VALUES ('AU', ?, ?, ?, ?, ?, ?, ?, 'synthetic', ?, ?)`,
        args: [
          `S${String(code).padStart(4, "0")}`,
          isoDay(day),
          px,
          px + 0.1,
          px - 0.1,
          px,
          1000 + day,
          NOW,
          NOW,
        ],
      });
    }
    await db.batch(stmts, "write");
  }
}

/**
 * @param {string[]} argv @param {{ out?: (l: string) => void, now?: () => number }} [io]
 * @returns {Promise<number>} exit code
 */
export async function run(argv, io = {}) {
  const out = io.out ?? ((l) => console.log(l));
  const now = io.now ?? (() => Date.now());
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    out(`drill-size: FAIL ${e.message}`);
    return 2;
  }
  const dir = mkdtempSync(path.join(tmpdir(), "praxis-drill-size-"));
  const url = (n) => pathToFileURL(path.join(dir, n)).href;
  const src = createClient({ url: url("source.db") });
  const dst = createClient({ url: url("target.db") });
  try {
    await migrateUp(src, await loadMigrations(path.join(root, "db", "migrations", "main")));
    let t = now();
    await seed(src, args.rows);
    out(`seed     ${args.rows} price_bar rows        ${((now() - t) / 1000).toFixed(1)} s`);
    t = now();
    const dump = await dumpDatabase(src, { name: "main", createdAt: NOW });
    const dumpS = (now() - t) / 1000;
    out(
      `dump     ${(dump.text.length / 1e6).toFixed(1)} MB                    ${dumpS.toFixed(1)} s`,
    );
    t = now();
    parseBackup(dump.text);
    out(`parse                                 ${((now() - t) / 1000).toFixed(1)} s`);
    t = now();
    const result = await restoreDatabase(dst, dump.text, { chunkStatements: args.chunk });
    const restoreS = (now() - t) / 1000;
    const same = Object.keys(dump.counts).every(
      (n) => dump.counts[n] === result.counts[n] && dump.sha256[n] === result.sha256[n],
    );
    out(`restore  chunk ${args.chunk} statements            ${restoreS.toFixed(1)} s`);
    // Rough RTO projection: restore time scales with rows; production main DB holds about 490k bars.
    out(`rows/s   ${Math.round(args.rows / Math.max(restoreS, 0.001))}`);
    const ok = same && restoreS <= args.maxSeconds;
    out(
      `drill-size: ${ok ? "PASS" : "FAIL"} rows=${args.rows} checksums ${same ? "identical" : "DIFFER"} restore ${restoreS.toFixed(1)} s (limit ${args.maxSeconds} s)`,
    );
    return ok ? 0 : 1;
  } catch (e) {
    out(`drill-size: FAIL ${String(e?.message ?? "unexpected error").slice(0, 120)}`);
    return 1;
  } finally {
    try {
      src.close();
      dst.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Windows may hold the files briefly; the OS temp folder is cleaned later.
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
