// Restore drill and guarded restore against Turso (TST-108, OPS-040, NFR-004, AT-04, AT-30;
// M8 design 2.5, decision 4). Run by .github/workflows/restore-drill.yml in the `production` (or,
// for the synthetic build-phase drill, `staging`) environment. HIGH-RISK: backups, keys, data.
//
// Subcommands (first argument), all configured by environment variables only:
//   guard        refuse unless the temporary secrets this mode needs are present (names only).
//   run          mode=drill: restore the latest encrypted backups into THROWAWAY Turso databases
//                (created with the temporary platform token (l)), verify checksums, replay the
//                check cohort, delete the databases. mode=restore: the same into NEW databases that
//                are KEPT, only with the explicit confirmation input.
//   cleanup      remove any plaintext temp folder (the run keeps plaintext in memory only).
//   final-check  FAIL while the temporary private-key secret or token (l) still exists.
//
// env (run): MODE drill|restore, KEY_MODE real|throwaway, BACKUP_ENV production|staging,
//   TARGETS main|auth|both, BACKUP_TAG (empty = latest), CONFIRM (restore: must be RESTORE),
//   TURSO_ORG, TURSO_GROUP, TURSO_PLATFORM_TOKEN_TEMP, and for KEY_MODE=real: BACKUP_PRIVATE_KEY,
//   DATA_REPO (`<owner>/<repo>-data`), DATA_REPO_TOKEN.
// KEY_MODE=throwaway (build phase): SYNTHETIC data only, a throwaway key generated in memory; no
//   production data, no private key, no data-repo token.
// Output (stdout and job summary): table names, counts, PASS/FAIL, elapsed time, the names of
//   databases that were NOT deleted. Never a URL, token, key, path or row content: every line also
//   passes through a scrubber that blanks any secret value this process holds.
import { createClient } from "@libsql/client";
import { appendFileSync, existsSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assetName,
  decryptToText,
  looksLikeAge,
  parseBackup,
  restoreDatabase,
} from "../backup/core.mjs";
import { AssetError, createBackupReader, TAG_RE } from "./backupAssets.mjs";
import { barsFromValues, checkCohort } from "./cohortCheck.mjs";
import { createTursoPlatform, throwawayName, TursoError } from "./turso-platform.mjs";

export const RTO_MS = 4 * 60 * 60 * 1000; // NFR-004
export const SPILL_DIR = "praxis-restore"; // folder under $RUNNER_TEMP removed by `cleanup`
const KEY_SECRET = "BACKUP_PRIVATE_KEY";
const TOKEN_SECRET = "TURSO_PLATFORM_TOKEN_TEMP";
const has = (v) => typeof v === "string" && v.trim() !== "";
const pick = (v, allowed, dflt) => {
  const s = has(v) ? v.trim() : dflt;
  return allowed.includes(s) ? s : null;
};

class DrillError extends Error {}
const refuse = (why) => {
  throw new DrillError(why);
};

/**
 * Validate the configuration. Throws DrillError (fixed messages) on anything unsafe.
 * @param {Record<string, string | undefined>} env
 */
export function parseConfig(env) {
  const mode = pick(env.MODE, ["drill", "restore"], "");
  if (!mode) refuse("mode must be drill or restore");
  const keyMode = pick(env.KEY_MODE, ["real", "throwaway"], "real");
  const backupEnv = pick(env.BACKUP_ENV, ["production", "staging"], "production");
  const targets = pick(env.TARGETS, ["main", "auth", "both"], "both");
  if (!keyMode || !backupEnv || !targets) refuse("an input has an unknown value");
  const tag = has(env.BACKUP_TAG) ? env.BACKUP_TAG.trim() : "";
  if (tag !== "" && !TAG_RE.test(tag)) refuse("backup must be empty or backup-YYYY-MM-DD");
  if (keyMode === "real" && backupEnv !== "production") {
    refuse("the real key and real backups are used in the production environment only");
  }
  if (mode === "restore") {
    if (keyMode !== "real") refuse("restore needs the real backup, not the throwaway key");
    if ((env.CONFIRM ?? "").trim() !== "RESTORE") {
      refuse("restore refused: the confirm input must be exactly RESTORE");
    }
  }
  if (!has(env.TURSO_ORG)) refuse("TURSO_ORG is not set");
  if (!has(env[TOKEN_SECRET])) refuse(`${TOKEN_SECRET} is missing`);
  if (keyMode === "real") {
    if (!has(env[KEY_SECRET])) refuse(`${KEY_SECRET} is missing`);
    if (!has(env.DATA_REPO) || !has(env.DATA_REPO_TOKEN)) refuse("data repo access is missing");
  }
  return {
    mode,
    keyMode,
    backupEnv,
    targets: targets === "both" ? ["main", "auth"] : [targets],
    tag,
    org: env.TURSO_ORG.trim(),
    group: has(env.TURSO_GROUP) ? env.TURSO_GROUP.trim() : "default",
    platformToken: env[TOKEN_SECRET].trim(),
    privateKey: keyMode === "real" ? env[KEY_SECRET] : "",
    dataRepo: (env.DATA_REPO ?? "").trim(),
    dataRepoToken: (env.DATA_REPO_TOKEN ?? "").trim(),
  };
}

/** The age secret key line from a key file or secret value, or null. */
export function extractIdentity(value) {
  for (const line of String(value).split(/\r?\n/)) {
    const t = line.trim();
    if (/^AGE-SECRET-KEY-1[0-9A-Z]{20,}$/.test(t)) return t;
  }
  return null;
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {(line: string) => void} out
 * @returns {number} exit code
 */
export function guard(env, out = console.log) {
  const mode = (env.MODE ?? "").trim();
  const keyMode = (env.KEY_MODE ?? "real").trim() || "real";
  const missing = [];
  if (!has(env[TOKEN_SECRET])) missing.push(TOKEN_SECRET);
  if (keyMode === "real" && !has(env[KEY_SECRET])) missing.push(KEY_SECRET);
  if (mode === "restore" && (env.CONFIRM ?? "").trim() !== "RESTORE") {
    out("guard: FAIL restore refused: the confirm input must be exactly RESTORE");
    return 1;
  }
  const outputs = [
    `key=${has(env[KEY_SECRET]) ? "present" : "missing"}`,
    `token=${has(env[TOKEN_SECRET]) ? "present" : "missing"}`,
  ];
  if (has(env.GITHUB_OUTPUT)) appendFileSync(env.GITHUB_OUTPUT, `${outputs.join("\n")}\n`);
  if (missing.length > 0) {
    out(
      `guard: FAIL missing secret(s): ${missing.join(", ")}. Add them as temporary secrets first.`,
    );
    return 1;
  }
  out(`guard: ok (${outputs.join(", ")})`);
  return 0;
}

/**
 * Last step (SEC-017 (l), TST-108, OPS-040 step 4): FAIL while either temporary secret exists.
 * @param {Record<string, string | undefined>} env
 * @param {(line: string) => void} out
 * @returns {number}
 */
export function finalCheck(env, out = console.log) {
  const still = [KEY_SECRET, TOKEN_SECRET].filter((n) => has(env[n]));
  if (still.length > 0) {
    out(
      `final-check: FAIL temporary secret still present: ${still.join(", ")}. Delete it in the GitHub environment (and revoke the token at Turso), then dispatch again with mode verify-removed.`,
    );
    return 1;
  }
  out("final-check: PASS no temporary restore secret is present");
  return 0;
}

/** Remove the plaintext temp folder (defence in depth: the run itself writes no plaintext file). */
export function cleanup(env, out = console.log) {
  const base = has(env.RUNNER_TEMP) ? env.RUNNER_TEMP : "";
  if (base !== "") {
    const dir = path.join(base, SPILL_DIR);
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      out("cleanup: FAIL could not remove the temp folder");
      return 1;
    }
  }
  out("cleanup: ok");
  return 0;
}

const fmtElapsed = (ms) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};

/**
 * @param {Record<string, string | undefined>} env
 * @param {{
 *   out?: (s: string) => void,
 *   now?: () => number,
 *   platform?: ReturnType<typeof createTursoPlatform>,
 *   openDb?: (url: string, token: string) => import("@libsql/client").Client,
 *   reader?: ReturnType<typeof createBackupReader>,
 *   synthetic?: () => Promise<{ identity: string, cipher: Record<string, Uint8Array> }>,
 *   suffix?: () => string,
 * }} [deps]
 * @returns {Promise<number>} exit code
 */
export async function run(env, deps = {}) {
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const secrets = new Set();
  const scrub = (s) => {
    let t = String(s);
    for (const v of secrets) if (v.length >= 4) t = t.split(v).join("***");
    return t;
  };
  const rawOut = deps.out ?? ((s) => console.log(s));
  const out = (s) => rawOut(scrub(s));
  for (const n of [KEY_SECRET, TOKEN_SECRET, "DATA_REPO_TOKEN"]) {
    if (has(env[n])) for (const part of env[n].split(/\s+/)) secrets.add(part);
  }
  const created = [];
  let platform;
  let ok = false;
  let cfg;
  try {
    cfg = parseConfig(env);
    platform =
      deps.platform ??
      createTursoPlatform({ org: cfg.org, token: cfg.platformToken, group: cfg.group });
    const openDb = deps.openDb ?? ((url, authToken) => createClient({ url, authToken }));
    const suffix = deps.suffix ?? (() => randomBytes(4).toString("hex"));

    // Phase A: obtain, decrypt and VERIFY everything before any database is created.
    let identity;
    let cipher;
    let backupDate;
    if (cfg.keyMode === "throwaway") {
      const synth = await (
        deps.synthetic ?? (async () => (await import("./synthetic.mjs")).buildSynthetic())
      )();
      identity = synth.identity;
      cipher = synth.cipher;
      backupDate = "synthetic";
      out("source: synthetic build-phase data, throwaway key (no production data)");
    } else {
      identity = extractIdentity(cfg.privateKey);
      if (!identity) refuse("the private key secret is not an age secret key");
      secrets.add(identity);
      const reader =
        deps.reader ?? createBackupReader({ repo: cfg.dataRepo, token: cfg.dataRepoToken });
      const names = {};
      for (const db of cfg.targets) names[db] = (tag) => assetName(db, tag.slice("backup-".length));
      const got = await reader.fetchBackup({ tag: cfg.tag, names });
      cipher = got.data;
      backupDate = got.tag.slice("backup-".length);
      out(`source: ${got.tag}`);
    }
    const parsedBy = {};
    const textBy = {};
    for (const db of cfg.targets) {
      const bytes = cipher[db];
      if (!bytes || !looksLikeAge(bytes)) refuse(`${db}: the backup is not an age file`);
      let text;
      try {
        text = await decryptToText(bytes, identity);
      } catch {
        return refuse(`${db}: decryption failed (wrong key or damaged file)`);
      }
      const parsed = parseBackup(text); // throws "backup stream rejected: <class>" on a bad checksum
      if (parsed.meta.db !== db) refuse(`${db}: the file is the ${parsed.meta.db} database`);
      parsedBy[db] = parsed;
      textBy[db] = text;
      const rows = parsed.meta.tables.reduce((n, t) => n + parsed.end.counts[t], 0);
      out(`verify ${db}: tables=${parsed.meta.tables.length} rows=${rows} checksums PASS`);
    }

    // Phase B: create, restore, verify, (drill) cohort check.
    let allOk = true;
    for (const db of cfg.targets) {
      const parsed = parsedBy[db];
      const prefix = cfg.mode === "drill" ? "drill" : "restore";
      const dbSuffix =
        cfg.mode === "drill" ? suffix() : `${backupDate.replaceAll("-", "")}${suffix()}`;
      const name = throwawayName(db, dbSuffix, prefix);
      const info = await platform.createDatabase(name);
      created.push({ db, name });
      secrets.add(info.url);
      const dbToken = await platform.createDatabaseToken(name, "1h");
      secrets.add(dbToken);
      const client = openDb(info.url, dbToken);
      try {
        const result = await restoreDatabase(client, textBy[db]);
        let same = true;
        for (const t of parsed.meta.tables) {
          if (
            result.counts[t] !== parsed.end.counts[t] ||
            result.sha256[t] !== parsed.end.sha256[t]
          ) {
            same = false;
          }
        }
        out(
          `restore ${db}: ${same ? "PASS" : "FAIL"} tables=${parsed.meta.tables.length} (counts and sha256 compared)`,
        );
        allOk &&= same;
        if (db === "main" && cfg.mode === "drill") {
          const bars = parsed.data.get("price_bar");
          const res = bars
            ? await checkCohort({ expectedBars: barsFromValues(bars.rows, 6), db: client })
            : { ok: false, days: 0, reason: "no price_bar table in the backup" };
          out(
            `cohort ${db}: ${res.ok ? "PASS NAV identical" : `FAIL ${res.reason}`} sessions=${res.days}`,
          );
          allOk &&= res.ok;
        }
      } finally {
        try {
          client.close();
        } catch {
          // ignore
        }
      }
    }
    ok = allOk;
  } catch (e) {
    const known =
      e instanceof DrillError ||
      e instanceof TursoError ||
      e instanceof AssetError ||
      /^backup stream rejected:/.test(String(e?.message));
    out(`run: FAIL ${known ? e.message : "unexpected error"}`);
  }

  // Cleanup: drill always deletes; restore keeps the new databases only after a full success.
  let leftover = [];
  if (platform && created.length > 0 && (cfg?.mode === "drill" || !ok)) {
    for (const c of created) {
      let gone = false;
      for (let attempt = 0; attempt < 3 && !gone; attempt++) {
        try {
          await platform.deleteDatabase(c.name);
          gone = true;
        } catch {
          // retry
        }
      }
      if (!gone) leftover.push(c.name);
    }
    out(
      `delete: ${created.length - leftover.length}/${created.length} throwaway databases deleted`,
    );
    if (leftover.length > 0) {
      ok = false;
      out(
        `delete: FAIL delete these databases by hand in the Turso dashboard: ${leftover.join(", ")}`,
      );
    }
  } else if (created.length > 0) {
    out(`restore: new database(s) kept: ${created.map((c) => `${c.db}=${c.name}`).join(", ")}`);
    out(
      "restore: next, create tokens in the Turso dashboard (OPS-040 step 3); never through a log",
    );
  }
  const elapsed = now() - started;
  out(
    `${cfg?.mode ?? "run"}: ${ok ? "PASS" : "FAIL"} elapsed ${fmtElapsed(elapsed)} (RTO 4h: ${elapsed <= RTO_MS ? "within" : "EXCEEDED"})`,
  );
  return ok ? 0 : 1;
}

/** CLI entry: writes every (scrubbed) line to stdout and the job summary. */
export async function main(argv, env) {
  const summary = has(env.GITHUB_STEP_SUMMARY) ? env.GITHUB_STEP_SUMMARY : "";
  const out = (line) => {
    console.log(line);
    if (summary) {
      try {
        appendFileSync(summary, `${line}\n`);
      } catch {
        // the summary is a convenience
      }
    }
  };
  switch (argv[0]) {
    case "guard":
      return guard(env, out);
    case "final-check":
      return finalCheck(env, out);
    case "cleanup":
      return cleanup(env, out);
    case "run":
      return run(env, { out });
    default:
      out("usage: drill-turso.mjs guard|run|cleanup|final-check");
      return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}
