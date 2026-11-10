// INFRA T4 (REQ\infra\INFRA_REQUIREMENT.md §8.2 item 4, §14 T4): the weekly restore drill on the
// server, into SCRATCH sqld namespaces. The same logic as scripts/backup/drill.mjs: dump ->
// gzip -> age-encrypt to a THROWAWAY key (generated in memory) -> decrypt -> restore into a fresh
// empty database -> compare per-table counts and sha256 with the source. Plus the checks sqld
// needs: `PRAGMA foreign_keys` = 1 on the scratch connection and no orphan rows
// (`PRAGMA foreign_key_check`). The scratch namespace is dropped at the end, pass or fail.
//
// Usage: node scripts/selfhost/restore-drill.mjs [--source live|synthetic|backup] [--keep]
//   live       (default) dump the live main namespace (and auth when its source is configured),
//              read-only; the plaintext lives in memory only.
//   synthetic  seeded synthetic databases (both real schemas through the real migrations); no
//              production data. Safe anywhere.
//   backup     the NEWEST real backup copy (scripts/selfhost/latest-backup.mjs rules), decrypted
//              with BACKUP_PRIVATE_KEY: proves the backups themselves restore.
//   --keep     do not drop the scratch namespaces (debugging only).
// env: SQLD_URL (base, e.g. http://sqld:8080), SQLD_ADMIN_URL (e.g. http://sqld:8081),
//      SQLD_NS_MODE (host by default here: scratch namespaces have no DNS alias), SQLD_TOKEN or
//      TURSO_MAIN_TOKEN (optional), SQLD_ADMIN_AUTH (optional);
//      live: TURSO_MAIN_URL, TURSO_MAIN_TOKEN [TURSO_AUTH_URL, TURSO_AUTH_TOKEN];
//      backup: see latest-backup.mjs.
// Output: PASS/FAIL, table and row counts. Never a URL, token, key or row content.
import { createClient } from "@libsql/client";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateIdentity, identityToRecipient } from "age-encryption";
import { NOW, seed } from "../backup/drill.mjs";
import { decryptToText, EPHEMERAL_TABLES, exportEncrypted, looksLikeAge } from "../backup/core.mjs";
import { fetchNewest, listCandidates, sourcesFromEnv } from "./latest-backup.mjs";
import {
  dropNamespace,
  ensureNamespace,
  openNamespace,
  restoreVerified,
  SqldError,
} from "./sqld.mjs";

const has = (v) => typeof v === "string" && v.trim() !== "";
const DBS = ["main", "auth"];

/**
 * Obtain the plaintext dump of one database for the chosen source.
 * @returns {Promise<{ text: string, label: string, counts?: Record<string, number>, sha256?: Record<string, string> } | null>} null = no source for this database
 */
async function sourceDump(name, kind, ctx) {
  if (kind === "synthetic") {
    const src = ctx.openLocal(`${name}-src.db`);
    await seed(src, name);
    const exp = await exportEncrypted(src, { name, createdAt: NOW, recipient: ctx.recipient });
    return { ...(await roundTrip(name, exp, ctx)), label: "synthetic" };
  }
  if (kind === "backup") {
    const { candidates } = await listCandidates(name, ctx.sources);
    if (candidates.length === 0) throw new SqldError(`${name}: no backup found`);
    const got = await fetchNewest(name, candidates, ctx.privateKey);
    return { text: got.text, label: got.source };
  }
  // live
  const url = ctx.env[name === "main" ? "TURSO_MAIN_URL" : "TURSO_AUTH_URL"];
  const token = ctx.env[name === "main" ? "TURSO_MAIN_TOKEN" : "TURSO_AUTH_TOKEN"];
  if (!has(url)) return null;
  const src = ctx.openSource(url.trim(), has(token) ? token.trim() : undefined);
  ctx.closers.push(() => src.close());
  const exp = await exportEncrypted(src, {
    name,
    createdAt: new Date(ctx.now()).toISOString(),
    recipient: ctx.recipient,
  });
  return { ...(await roundTrip(name, exp, ctx)), label: "live" };
}

/** Encrypted-export checks from drill.mjs: it is ciphertext, a wrong key fails, ephemeral rows are absent. */
async function roundTrip(name, exp, ctx) {
  if (!looksLikeAge(exp.data)) throw new SqldError(`${name}: output is not age ciphertext`);
  let wrongWorked = true;
  try {
    await decryptToText(exp.data, ctx.wrong);
  } catch {
    wrongWorked = false;
  }
  if (wrongWorked) throw new SqldError(`${name}: a different key decrypted the backup`);
  const text = await decryptToText(exp.data, ctx.identity);
  for (const t of EPHEMERAL_TABLES[name]) {
    if (text.includes(`"table":"${t}","values"`))
      throw new SqldError(`${name}: ${t} rows exported`);
  }
  return { text, counts: exp.counts, sha256: exp.sha256 };
}

/**
 * @param {string[]} argv @param {Record<string, string | undefined>} env
 * @param {{ out?: (s: string) => void, now?: () => number,
 *   openSource?: (url: string, token?: string) => import("@libsql/client").Client,
 *   scratch?: { open: (ns: string) => Promise<import("@libsql/client").Client> | import("@libsql/client").Client,
 *               create?: (ns: string) => Promise<unknown>, drop?: (ns: string) => Promise<unknown> },
 *   sources?: { s3?: any, gh?: any } }} [deps]
 * @returns {Promise<number>} exit code (0 = PASS)
 */
export async function runDrill(argv, env, deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const dir = mkdtempSync(path.join(tmpdir(), "praxis-sqld-drill-"));
  const closers = [];
  const scratchNames = [];
  let keep = false;
  const scratch = deps.scratch ?? {
    open: (ns) =>
      openNamespace({
        base: env.SQLD_URL,
        ns,
        token: has(env.SQLD_TOKEN) ? env.SQLD_TOKEN : env.TURSO_MAIN_TOKEN,
        mode: env.SQLD_NS_MODE === "subdomain" ? "subdomain" : "host",
        intMode: "bigint",
      }),
    create: (ns) => ensureNamespace(env.SQLD_ADMIN_URL, ns, { adminAuth: env.SQLD_ADMIN_AUTH }),
    drop: (ns) => dropNamespace(env.SQLD_ADMIN_URL, ns, { adminAuth: env.SQLD_ADMIN_AUTH }),
  };
  try {
    let kind = "live";
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--source" && i + 1 < argv.length) kind = argv[++i];
      else if (argv[i] === "--keep") keep = true;
      else throw new SqldError("usage: [--source live|synthetic|backup] [--keep]");
    }
    if (!["live", "synthetic", "backup"].includes(kind)) {
      throw new SqldError("usage: --source must be live, synthetic or backup");
    }
    if (!deps.scratch && (!has(env.SQLD_URL) || !has(env.SQLD_ADMIN_URL))) {
      throw new SqldError("SQLD_URL and SQLD_ADMIN_URL are not set");
    }
    const identity = await generateIdentity(); // throwaway: lives in memory only
    const ctx = {
      env,
      kind,
      identity,
      recipient: await identityToRecipient(identity),
      wrong: await generateIdentity(),
      now: deps.now ?? (() => Date.now()),
      closers,
      openSource:
        deps.openSource ??
        ((url, authToken) => createClient({ url, authToken, intMode: "bigint" })),
      openLocal: (file) => {
        const c = createClient({ url: pathToFileURL(path.join(dir, file)).href });
        closers.push(() => c.close());
        return c;
      },
      sources: deps.sources ?? sourcesFromEnv(env),
      privateKey: "",
    };
    if (kind === "backup") {
      ctx.privateKey = has(env.BACKUP_PRIVATE_KEY) ? env.BACKUP_PRIVATE_KEY.trim() : "";
      if (ctx.privateKey === "") throw new SqldError("BACKUP_PRIVATE_KEY is not set");
      if (!ctx.sources.s3 && !ctx.sources.gh) throw new SqldError("no backup source is configured");
    }

    const runId = randomBytes(4).toString("hex");
    const summary = [];
    for (const name of DBS) {
      const dump = await sourceDump(name, kind, ctx);
      if (dump === null) {
        summary.push(`${name}(skipped: no source)`);
        continue;
      }
      const ns = `drill-${runId}-${name}`;
      scratchNames.push(ns);
      if (scratch.create) await scratch.create(ns);
      const target = await scratch.open(ns);
      closers.push(() => target.close());
      const r = await restoreVerified(target, dump.text, { expectDb: name });
      if (dump.counts) {
        for (const [t, n] of Object.entries(dump.counts)) {
          if (r.counts[t] !== n) throw new SqldError(`${name}: count mismatch`);
        }
      }
      summary.push(`${name}(from ${dump.label}: tables=${r.tables} rows=${r.rows})`);
    }
    out(
      `restore-drill: PASS ${summary.join(" ")} foreign keys ON, no orphan rows, scratch ${keep ? "kept" : "dropped"}`,
    );
    return 0;
  } catch (e) {
    const msg =
      e instanceof SqldError || /^backup stream rejected:/.test(String(e?.message))
        ? e.message
        : "unexpected error";
    out(`restore-drill: FAIL (${msg})`);
    return 1;
  } finally {
    for (const c of closers) {
      try {
        c();
      } catch {
        // ignore
      }
    }
    if (!keep && scratch.drop) {
      for (const ns of scratchNames) {
        try {
          await scratch.drop(ns);
        } catch {
          out(`restore-drill: warning: scratch namespace ${ns} was not dropped`);
        }
      }
    }
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Windows may hold a lock briefly; the folder only ever held synthetic data.
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await runDrill(process.argv.slice(2), process.env);
}
