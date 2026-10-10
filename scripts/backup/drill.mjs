// Restore drill, build phase (TST-108, PLT-022, NFR-004, AT-04). Usage: node scripts/backup/drill.mjs
// "During the build (M1-M7) ... the drill job generates a fresh throwaway key pair inside the
// run": this script generates a throwaway age identity in memory, builds small SYNTHETIC
// databases (both real schemas via the real migrations, plus fake rows), then for each:
// dump -> gzip -> encrypt to the throwaway recipient -> decrypt -> restore into a fresh empty
// local libSQL file -> compare per-table counts and sha256 with the source. It also proves that a
// wrong key cannot decrypt and that a tampered stream is refused. No production data, no
// secrets, no network; the throwaway key exists only in memory. Prints PASS or FAIL.
import { createClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateIdentity, identityToRecipient } from "age-encryption";
import { loadMigrations, migrateUp } from "../../src/lib/db/migrate-core.mjs";
import {
  decryptToText,
  EPHEMERAL_TABLES,
  exportEncrypted,
  looksLikeAge,
  restoreDatabase,
} from "./core.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const NOW = "2026-01-02T03:04:05.678Z";
const MARKER = "DRILL-MARKER-8f3a1c"; // must never be readable in the ciphertext

async function seed(db, name) {
  await migrateUp(db, await loadMigrations(path.join(root, "db", "migrations", name)));
  await db.execute(
    "CREATE TABLE drill_misc (id INTEGER PRIMARY KEY, label TEXT, n INTEGER, r REAL, b BLOB, big TEXT)",
  );
  const blob = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  await db.execute({
    sql: "INSERT INTO drill_misc (label, n, r, b, big) VALUES (?, ?, ?, ?, ?)",
    args: [`${MARKER} Zoë 日本語 \u{1F642} "quoted" \\ back\nline`, 42, 3.25, blob, null],
  });
  await db.execute({
    sql: "INSERT INTO drill_misc (label, n, r, b, big) VALUES (?, ?, ?, ?, ?)",
    args: [null, -7, null, new Uint8Array(0), "x".repeat(5000)],
  });
  if (name === "main") {
    await db.execute({
      sql: `INSERT INTO run_record (job, concurrency_key, started_at, status) VALUES ('drill', ?, ?, 'success')`,
      args: ["drill:1", NOW],
    });
    await db.execute({
      sql: "INSERT INTO app_log (at, level, source, message) VALUES (?, 'info', 'drill', ?)",
      args: [NOW, `${MARKER} log`],
    });
    await db.execute({
      sql: "INSERT INTO request_nonce (nonce, expires_at) VALUES (?, 4102444800)",
      args: ["a".repeat(32)],
    });
  } else {
    await db.execute({
      sql: `INSERT INTO app_user (email, name, role, status, created_at, updated_at)
            VALUES (?, ?, 'owner', 'active', ?, ?)`,
      args: [`drill-owner@example.test`, `${MARKER} Zoë`, NOW, NOW],
    });
    await db.execute({
      sql: `INSERT INTO audit_event (at, action, ip, prev_hmac, row_hmac) VALUES (?, 'drill', NULL, ?, ?)`,
      args: [NOW, "0".repeat(64), "1".repeat(64)],
    });
  }
}

/**
 * @param {(line: string) => void} [out]
 * @returns {Promise<number>} exit code (0 = PASS)
 */
export async function runDrill(out = (s) => console.log(s)) {
  const dir = mkdtempSync(path.join(tmpdir(), "praxis-drill-"));
  const clients = [];
  const open = (file) => {
    const c = createClient({ url: pathToFileURL(path.join(dir, file)).href });
    clients.push(c);
    return c;
  };
  try {
    const identity = await generateIdentity(); // throwaway: lives in memory only
    const recipient = await identityToRecipient(identity);
    const wrong = await generateIdentity();
    const summary = [];

    for (const name of ["main", "auth"]) {
      const src = open(`${name}-src.db`);
      await seed(src, name);
      const exp = await exportEncrypted(src, { name, createdAt: NOW, recipient });

      if (!looksLikeAge(exp.data)) throw new Error(`${name}: output is not age ciphertext`);
      if (Buffer.from(exp.data).includes(MARKER)) throw new Error(`${name}: ciphertext leaks text`);
      let wrongWorked = true;
      try {
        await decryptToText(exp.data, wrong);
      } catch {
        wrongWorked = false;
      }
      if (wrongWorked) throw new Error(`${name}: a different key decrypted the backup`);

      const text = await decryptToText(exp.data, identity);
      for (const t of EPHEMERAL_TABLES[name]) {
        if (text.includes(`"table":"${t}","values"`))
          throw new Error(`${name}: ${t} rows exported`);
      }
      let tamperRefused = false;
      try {
        await restoreDatabase(
          open(`${name}-tamper.db`),
          text.replace(MARKER, "DRILL-MARKER-000000"),
        );
      } catch {
        tamperRefused = true;
      }
      if (!tamperRefused) throw new Error(`${name}: a tampered stream was accepted`);

      const restored = await restoreDatabase(open(`${name}-restored.db`), text);
      let rows = 0;
      for (const table of exp.tables) {
        if (restored.counts[table] !== exp.counts[table])
          throw new Error(`${name}: count mismatch`);
        if (restored.sha256[table] !== exp.sha256[table])
          throw new Error(`${name}: checksum mismatch`);
        rows += exp.counts[table];
      }
      summary.push(`${name}(tables=${exp.tables.length} rows=${rows})`);
    }
    out(`drill: PASS ${summary.join(" ")}`);
    return 0;
  } catch (e) {
    out(`drill: FAIL (${e instanceof Error ? e.message : "unexpected error"})`);
    return 1;
  } finally {
    for (const c of clients) c.close();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Windows may hold a lock briefly; the folder only ever contained synthetic data.
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await runDrill());
}
