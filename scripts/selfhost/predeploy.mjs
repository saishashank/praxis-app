// INFRA T7 (REQ\infra\INFRA_REQUIREMENT.md §10, §11.3-11.4, §12 R6/R8): `praxis deploy <sha>` with the pre-deploy
// check. Runs on the Linux host (deploy.sh calls it); node builtins only, no repo checkout and no npm packages.
// Everything that touches the outside world goes through injected functions (docker runner, file access, mail,
// sleep, clock), so the whole flow is tested with a fake docker (tests/selfhost/deploy.test.ts).
//
//   node predeploy.mjs <sha> [--wait] [--no-pull] [--skip-zap] [--data auto|backup|snapshot|none]
//   node predeploy.mjs --rollback [--skip-check] [--wait]
//   node predeploy.mjs --ci --web-image <ref> --jobs-image <ref> [--skip-zap]     (check only, branch CI)
//
// Flow (all steps idempotent; a failed run can simply be run again):
//   1 validate the 40-hex SHA (or read deployed.prev.json for --rollback); refuse while a job runs (--wait: poll 30 min)
//   2 pull praxis-web and praxis-jobs for the SHA, record the DIGESTS; every later step uses image@sha256:...
//   3 check: project "praxis-check" (own sqld on a throwaway volume, no public port, no clock, EMAIL_LIVE=0):
//       data   last night's backup restored (needs BACKUP_PRIVATE_KEY in the caller's environment, never stored);
//              when the key is not on the box: a live snapshot of prod sqld (read-only on prod), and it says so
//       migrate the copy (main, auth), start web, smoke test (scripts/selfhost/smoke.mjs), ZAP baseline scan
//   4 pass: wait for no running job, snapshot prod (always, local), try the bucket/repo backup, migrate prod,
//       restart web, then clock; record deployed.json (previous kept as deployed.prev.json); prune old images
//     fail: stop, tear the check down, prod untouched, email the Owner, exit 1
//   5 the check project and its volume are ALWAYS torn down (finally)
// Branch CI (--ci, no registry, no prod, no email): the check against locally built images, e.g.
//   node scripts/selfhost/predeploy-ci-env.mjs "$RUNNER_TEMP/env"          (throwaway env files)
//   PRAXIS_ENV_DIR="$RUNNER_TEMP/env" PRAXIS_COMPOSE_DIR=deploy/selfhost PRAXIS_SCRIPTS_DIR=scripts/selfhost //   PRAXIS_CHECK_TMP="$RUNNER_TEMP/check" node scripts/selfhost/predeploy.mjs --ci //     --web-image ghcr.io/saishashank/praxis-web:ci --jobs-image ghcr.io/saishashank/praxis-jobs:ci [--skip-zap]
// exit 0 = the check passed, 1 = it failed. A deliberately broken web image must exit 1 (see the T7 report).
// Exit codes: 0 deployed (or check passed with --ci), 1 check or deploy failed, 2 usage, 3 refused (a job is running).
// Output: step names, PASS/FAIL, counts. Never a secret, URL, token or log body. Migrations are forward-only: a rollback
// across a migration needs docs/runbooks/rollback-v2.md (the rolled-back images run with MIGRATE_ALLOW_NEWER=1).
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EXIT = { OK: 0, FAILED: 1, USAGE: 2, BUSY: 3 };
export const SHA_RE = /^[0-9a-f]{40}$/;
/** ZAP image, pinned by digest: the same one .github/workflows/zap-baseline.yml uses (D-814). */
export const ZAP_IMAGE =
  "ghcr.io/zaproxy/zaproxy@sha256:030d3df57735dacbb83464854758e674dd9ad01d79d12a129a8e58b1fd384238";
const ZAP_IMAGE_RE = /^ghcr\.io\/zaproxy\/zaproxy@sha256:[0-9a-f]{64}$/;
const IMAGE_RE = /^[a-z0-9][a-z0-9./_-]*(?::[\w.-]+)?(?:@sha256:[0-9a-f]{64})?$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const DAY_MS = 86_400_000;
const WAIT_LIMIT_MS = 30 * 60_000; // threshold-ok: INFRA §10, "--wait polls up to 30 minutes"
const POLL_MS = 15_000;
const KEEP_IMAGES_MS = 30 * DAY_MS; // INFRA §10: images are kept for 30 days
const KEEP_SNAPSHOTS = 3; // plaintext pre-deploy snapshots on the host (INF-D: off-box backups are the long-term copies)
const STALE_LOCK_MS = 3 * 3_600_000;
const HEALTH_JS =
  "fetch('http://127.0.0.1:9100/health').then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>process.exit(1))";
const SHOW = /^(smoke|migrate|latest-backup|predeploy-copy)/;

export class DeployError extends Error {
  constructor(step, message, exit = EXIT.FAILED) {
    super(message);
    this.step = step;
    this.exit = exit;
  }
}

export const shortSha = (s) => String(s).slice(0, 12);
const tail = (s, n = 10) =>
  String(s ?? "")
    .split("\n")
    .map((l) => l.trimEnd().slice(0, 200))
    .filter(Boolean)
    .slice(-n);

/** ZAP verdict from a traditional JSON report: rule id, name, risk, count only (never URLs, evidence, cookies). */
export function zapVerdict(report) {
  const rules = new Map();
  for (const site of Array.isArray(report?.site) ? report.site : []) {
    for (const a of Array.isArray(site?.alerts) ? site.alerts : []) {
      const rule = String(a.pluginid ?? a.alertRef ?? "").split("-")[0];
      if (!/^\d{1,7}$/.test(rule)) continue;
      const code = Number(a.riskcode);
      const cur = rules.get(rule) ?? {
        rule,
        name: String(a.name ?? a.alert ?? "")
          .replace(/https?:\/\/\S+/gi, "")
          .replace(/[|<>`\r\n]/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 80),
        risk: ["Informational", "Low", "Medium", "High"][code] ?? "Informational",
        high: code >= 3,
        count: 0,
      };
      cur.count += Number(a.count) || (Array.isArray(a.instances) ? a.instances.length : 1);
      rules.set(rule, cur);
    }
  }
  const list = [...rules.values()];
  return { fail: list.some((r) => r.high), rules: list };
}

/** Replace or append KEY=value lines of a dotenv text; other lines are kept as they are. */
export function setEnvLines(text, values) {
  const lines = String(text).split("\n");
  const seen = new Set();
  const out = lines.map((l) => {
    const m = /^([A-Z][A-Z0-9_]*)=/.exec(l);
    if (m && m[1] in values) {
      seen.add(m[1]);
      return `${m[1]}=${values[m[1]]}`;
    }
    return l;
  });
  while (out.length && out[out.length - 1] === "") out.pop();
  for (const [k, v] of Object.entries(values)) if (!seen.has(k)) out.push(`${k}=${v}`);
  return `${out.join("\n")}\n`;
}

/** Plain KEY=value parser (no expansion); only used to read non-secret names out of jobs.env for the mail. */
export function parseEnv(text) {
  const out = {};
  for (const l of String(text).split("\n")) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(l.trim());
    if (m) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

/**
 * Run the deploy (or only the check). See the header.
 * @param {{ mode: "deploy" | "rollback", sha?: string, wait?: boolean, noPull?: boolean, skipZap?: boolean,
 *   skipCheck?: boolean, checkOnly?: boolean, noNotify?: boolean, data?: "auto" | "backup" | "snapshot" | "none",
 *   images?: { web: string, jobs: string }, registry?: string, zapImage?: string,
 *   dirs: { compose: string, env: string, state: string, backups: string, check: string, scripts: string },
 *   waitLimitMs?: number, pollMs?: number }} cfg
 * @param {{ sh: (cmd: string, args: string[], o?: { env?: Record<string, string> }) => { code: number, stdout: string, stderr: string },
 *   fsx: { read: (p: string) => string | null, write: (p: string, text: string, mode?: number) => void,
 *          exists: (p: string) => boolean, mkdirp: (p: string, mode?: number) => void, rm: (p: string) => void,
 *          rename: (a: string, b: string) => void, mkTmp: (prefix: string) => string, lock: (p: string) => (() => void) },
 *   notify: (subject: string, text: string) => Promise<string>, sleep: (ms: number) => Promise<void>,
 *   now: () => number, log: (line: string) => void, hasEnv: (name: string) => boolean }} deps
 * @returns {Promise<{ code: number, ok: boolean, steps: { name: string, ok: boolean, detail: string }[], sha: string,
 *   failedStep: string | null, dataSource: string | null }>}
 */
export async function runDeploy(cfg, deps) {
  const { sh, fsx } = deps;
  const dirs = cfg.dirs;
  const registry = cfg.registry ?? "ghcr.io/saishashank";
  const zapImage = cfg.zapImage ?? ZAP_IMAGE;
  const waitLimit = cfg.waitLimitMs ?? WAIT_LIMIT_MS;
  const pollMs = cfg.pollMs ?? POLL_MS;
  const steps = [];
  const j = (...p) => path.posix.join(...p.map((x) => String(x).replace(/\\/g, "/")));
  const rec = (name, ok, detail = "") => {
    steps.push({ name, ok, detail });
    deps.log(`deploy: ${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  };
  const note = (line) => deps.log(`deploy:      ${line}`);
  const fail = (step, msg, exit = EXIT.FAILED) => {
    throw new DeployError(step, msg, exit);
  };

  const state = {
    sha: cfg.sha ?? "",
    web: null,
    jobs: null,
    dataSource: null,
    rollbackAcrossMigrations: cfg.mode === "rollback",
  };
  const checkProject = "praxis-check";
  const prodProject = "praxis-prod";
  const jobsEnvFile = j(dirs.env, "jobs.env");
  const result = (code, failedStep = null) => ({
    code,
    ok: code === 0,
    steps,
    sha: state.sha,
    failedStep,
    dataSource: state.dataSource,
  });

  // ---- docker helpers ---------------------------------------------------------------------------------------------
  const docker = (args, env) => sh("docker", args, env ? { env } : undefined);
  const imageEnv = () => ({
    PRAXIS_WEB_IMAGE: state.web.ref,
    PRAXIS_JOBS_IMAGE: state.jobs.ref,
    PRAXIS_SHA: state.sha,
    PRAXIS_ENV_DIR: dirs.env,
  });
  const checkCompose = (args) =>
    docker(
      ["compose", "-p", checkProject, "-f", j(dirs.compose, "docker-compose.check.yml"), ...args],
      imageEnv(),
    );
  const prodCompose = (args, withImages = true) =>
    docker(
      [
        "compose",
        "-p",
        prodProject,
        "-f",
        j(dirs.compose, "docker-compose.prod.yml"),
        "--env-file",
        j(dirs.compose, ".env"),
        ...args,
      ],
      withImages && state.web ? imageEnv() : undefined,
    );
  /** One-off container from an image, hardened, on a compose network. Output lines of our scripts are logged. */
  const util = (name, net, image, cmd, o = {}) => {
    const args = ["run", "--rm", "--network", net, "--read-only", "--tmpfs", "/tmp"];
    args.push("--cap-drop", "ALL", "--security-opt", "no-new-privileges");
    if (o.user) args.push("--user", o.user);
    if (o.entrypoint) args.push("--entrypoint", o.entrypoint);
    if (o.envFile) args.push("--env-file", o.envFile);
    for (const [k, v] of Object.entries(o.env ?? {})) args.push("-e", `${k}=${v}`);
    for (const k of o.pass ?? []) if (deps.hasEnv(k)) args.push("-e", k); // value read from our environment by docker
    for (const m of o.mounts ?? []) args.push("-v", m);
    args.push(image, ...cmd);
    const r = docker(args);
    for (const l of tail(r.stdout, 40)) if (SHOW.test(l)) note(l);
    if (r.code !== 0) {
      // Only our own status lines (SHOW) and the exit code: a container's raw stderr can carry an env value or a URL.
      for (const l of tail(r.stderr || r.stdout, 40)) if (SHOW.test(l)) note(l);
      fail(
        name,
        `${cmd[0] === "node" ? path.posix.basename(cmd[1] ?? "") : cmd[0]} exited with ${r.code}`,
      );
    }
    return r;
  };
  const copyScript = j(dirs.scripts, "predeploy-copy.mjs");
  const copyMount = `${copyScript}:/app/scripts/selfhost/predeploy-copy.mjs:ro`;
  const checkEnv = () => ({
    // The check sqld, by its compose network aliases; nothing of prod is reachable from these values.
    TURSO_MAIN_URL: "http://main.sqld:8080",
    TURSO_AUTH_URL: "http://auth.sqld:8080",
    SQLD_URL: "http://sqld:8080",
    SQLD_ADMIN_URL: "http://sqld:8081",
    SQLD_NS_MODE: "subdomain",
    EMAIL_LIVE: "0",
    EMAIL_PROVIDER: "mock",
    CLOCK_ENABLED: "0",
    ...(state.rollbackAcrossMigrations ? { MIGRATE_ALLOW_NEWER: "1" } : {}),
  });

  // ---- running jobs -----------------------------------------------------------------------------------------------
  /** @returns {{ known: boolean, jobs: string[] }} */
  const runningJobs = () => {
    const ps = prodCompose(["ps", "-q", "clock"], false);
    // a failing `compose ps` is a failure, not "idle" (N11); an empty answer = no clock container yet
    if (ps.code !== 0) fail("prod: idle", `docker compose ps exited with ${ps.code}`);
    if (ps.stdout.trim() === "") return { known: true, jobs: [] };
    const r = prodCompose(["exec", "-T", "clock", "node", "-e", HEALTH_JS], false);
    try {
      const h = JSON.parse(r.stdout);
      if (!Array.isArray(h.running)) throw new Error("shape");
      return { known: true, jobs: h.running.map((x) => `${x.job}#${x.id}`) };
    } catch {
      return { known: false, jobs: [] };
    }
  };
  const waitIdle = async (step, allowWait) => {
    const start = deps.now();
    for (;;) {
      const r = runningJobs();
      if (!r.known) {
        note(
          "the clock health could not be read: treating it as idle (the clock is probably down)",
        );
        return;
      }
      if (r.jobs.length === 0) return;
      if (!allowWait) {
        fail(
          step,
          `a job is running (${r.jobs.join(", ")}); run again later or use --wait`,
          EXIT.BUSY,
        );
      }
      if (deps.now() - start >= waitLimit) {
        fail(step, `a job is still running after ${Math.round(waitLimit / 60_000)} min`, EXIT.BUSY);
      }
      note(`waiting for ${r.jobs.join(", ")} to finish`);
      await deps.sleep(pollMs);
    }
  };

  // ---- images -----------------------------------------------------------------------------------------------------
  const resolveImage = (which, tagOrRef, recorded) => {
    const repo = `${registry}/praxis-${which}`;
    if (cfg.images) {
      const ref = cfg.images[which];
      if (!IMAGE_RE.test(ref)) fail("pull", `bad ${which} image reference`, EXIT.USAGE);
      return { repo, ref, digest: null };
    }
    if (recorded) {
      const r = docker(["pull", recorded.ref]);
      if (r.code !== 0)
        fail("pull", `praxis-${which} ${shortSha(state.sha)} is gone and cannot be pulled`);
      return { repo, ref: recorded.ref, digest: recorded.digest };
    }
    const tag = `${repo}:${tagOrRef}`;
    if (!cfg.noPull) {
      const r = docker(["pull", tag]);
      if (r.code !== 0) fail("pull", `praxis-${which}:${shortSha(tagOrRef)} could not be pulled`);
    }
    const insp = docker(["image", "inspect", "--format", "{{json .RepoDigests}}", tag]);
    if (insp.code !== 0) fail("pull", `praxis-${which}:${shortSha(tagOrRef)} is not on this host`);
    let digest = null;
    try {
      const d = JSON.parse(insp.stdout.trim());
      const hit = (Array.isArray(d) ? d : []).find((x) => String(x).startsWith(`${repo}@`));
      digest = hit ? String(hit).slice(repo.length + 1) : null;
    } catch {
      /* no digest */
    }
    if (digest !== null && !DIGEST_RE.test(digest)) digest = null;
    if (digest === null) {
      if (!cfg.noPull)
        fail("pull", `praxis-${which}: no registry digest recorded for the pulled image`);
      return { repo, ref: tag, digest: null }; // local image (branch CI): the tag is all there is
    }
    return { repo, ref: `${repo}@${digest}`, digest };
  };

  // ---- the check --------------------------------------------------------------------------------------------------
  const teardownCheck = (zapDir) => {
    const d = checkCompose(["down", "-v", "--remove-orphans"]);
    for (const p of [zapDir, dirs.check]) if (p) fsx.rm(p);
    rec(
      "check: teardown",
      d.code === 0,
      d.code === 0 ? "project, volume and scratch files removed" : "docker compose down failed",
    );
  };

  const runCheck = async () => {
    let zapDir = null;
    try {
      checkCompose(["down", "-v", "--remove-orphans"]); // a stale check from a killed run
      fsx.rm(dirs.check);
      fsx.mkdirp(dirs.check, 0o700);

      const up = checkCompose(["up", "-d", "--wait", "--wait-timeout", "180", "sqld"]);
      if (up.code !== 0) fail("check: sqld", "the check database did not become healthy");
      rec("check: sqld up", true, "throwaway volume, no public port");

      // data: last night's backup, else a live snapshot of prod (read-only on prod)
      const want = cfg.data ?? "auto";
      const haveKey = deps.hasEnv("BACKUP_PRIVATE_KEY");
      let source = want === "auto" ? (haveKey ? "backup" : "snapshot") : want;
      if (want === "auto" && !haveKey) {
        note(
          "BACKUP_PRIVATE_KEY is not on the box: the check data is a live snapshot of prod sqld, not last night's backup",
        );
      }
      const loadBackup = () =>
        util(
          "check: data",
          "praxis-check",
          state.jobs.ref,
          ["node", "scripts/selfhost/latest-backup.mjs", "--db", "both", "--restore"],
          {
            envFile: jobsEnvFile,
            env: checkEnv(),
            pass: ["BACKUP_PRIVATE_KEY"],
          },
        );
      const loadSnapshot = () => {
        const snap = j(dirs.check, "snapshot");
        fsx.mkdirp(snap, 0o700);
        util(
          "check: data (snapshot of prod)",
          "praxis-prod",
          state.jobs.ref,
          ["node", "scripts/selfhost/predeploy-copy.mjs", "dump", "--out", "/snap"],
          {
            envFile: jobsEnvFile,
            user: "0:0",
            mounts: [`${snap}:/snap`, copyMount],
          },
        );
        util(
          "check: data (load)",
          "praxis-check",
          state.jobs.ref,
          ["node", "scripts/selfhost/predeploy-copy.mjs", "load", "--in", "/snap"],
          {
            envFile: jobsEnvFile,
            env: checkEnv(),
            user: "0:0",
            mounts: [`${snap}:/snap`, copyMount],
          },
        );
      };
      if (source === "backup") {
        try {
          loadBackup();
        } catch (e) {
          if (want !== "auto" || !(e instanceof DeployError)) throw e;
          note(
            "last night's backup could not be restored: falling back to a live snapshot of prod",
          );
          checkCompose(["down", "-v", "--remove-orphans"]);
          const again = checkCompose(["up", "-d", "--wait", "--wait-timeout", "180", "sqld"]);
          if (again.code !== 0) fail("check: sqld", "the check database did not become healthy");
          source = "snapshot";
          loadSnapshot();
        }
      } else if (source === "snapshot") {
        loadSnapshot();
      } else if (source !== "none") {
        fail("check: data", "bad --data value", EXIT.USAGE);
      }
      state.dataSource = source;
      rec(
        "check: data",
        true,
        source === "none"
          ? "empty database (schema from migrations only)"
          : source === "backup"
            ? "last night's backup"
            : "live snapshot of prod",
      );

      for (const db of ["main", "auth"]) {
        util(
          `check: migrate ${db}`,
          "praxis-check",
          state.jobs.ref,
          ["node", "scripts/db/migrate.mjs", "--db", db, "--target", "sqld"],
          {
            envFile: jobsEnvFile,
            env: checkEnv(),
          },
        );
      }
      rec("check: migrations on the copy", true);

      const web = checkCompose(["up", "-d", "--wait", "--wait-timeout", "180", "web"]);
      if (web.code !== 0)
        fail("check: web", "the web container of the check did not become healthy");
      rec("check: web up", true);

      util("check: smoke", "praxis-check", state.web.ref, ["/smoke.mjs", "http://web:3000"], {
        entrypoint: "node",
        mounts: [`${j(dirs.scripts, "smoke.mjs")}:/smoke.mjs:ro`],
        pass: ["SMOKE_SESSION_COOKIE"],
      });
      rec(
        "check: smoke test",
        true,
        deps.hasEnv("SMOKE_SESSION_COOKIE")
          ? "signed in"
          : "public pages and sign-in gate (no session cookie)",
      );

      if (cfg.skipZap) {
        rec("check: ZAP", true, "skipped by --skip-zap");
      } else {
        if (!ZAP_IMAGE_RE.test(zapImage))
          fail("check: ZAP", "the ZAP image must be pinned by digest", EXIT.USAGE);
        zapDir = fsx.mkTmp("praxis-zap-");
        const z = docker([
          "run",
          "--rm",
          "--network",
          "praxis-check",
          "-v",
          `${zapDir}:/zap/wrk:rw`,
          "-u",
          "zap",
          zapImage,
          "zap-baseline.py",
          "-t",
          "http://web:3000",
          "-J",
          "zap.json",
          "-I",
        ]);
        // ZAP exits 1 or 2 for findings; only a missing report is a failure of the scan itself.
        const text = fsx.read(j(zapDir, "zap.json"));
        let report = null;
        try {
          report = text === null ? null : JSON.parse(text);
        } catch {
          /* unreadable */
        }
        if (report === null) fail("check: ZAP", `the scan produced no report (exit ${z.code})`);
        const v = zapVerdict(report);
        for (const r of v.rules) note(`ZAP ${r.rule} ${r.risk} x${r.count} ${r.name}`);
        if (v.fail)
          fail(
            "check: ZAP",
            `FAIL-level alert(s): ${v.rules
              .filter((r) => r.high)
              .map((r) => r.rule)
              .join(", ")}`,
          );
        rec("check: ZAP baseline", true, `${v.rules.length} rule(s), none at FAIL level`);
      }
    } finally {
      teardownCheck(zapDir);
    }
  };

  // ---- production -------------------------------------------------------------------------------------------------
  const readJson = (p) => {
    const t = fsx.read(p);
    if (t === null) return null;
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  };
  const deployedPath = j(dirs.state, "deployed.json");
  const prevPath = j(dirs.state, "deployed.prev.json");
  const envPath = j(dirs.compose, ".env");

  const applyEnvFile = (web, jobs, sha) => {
    const text = setEnvLines(fsx.read(envPath) ?? "", {
      PRAXIS_SHA: sha,
      PRAXIS_WEB_IMAGE: web,
      PRAXIS_JOBS_IMAGE: jobs,
    });
    fsx.write(envPath, text, 0o644);
  };

  const prodPhase = async (previous) => {
    await waitIdle("prod: idle", cfg.wait === true);

    // the local snapshot always happens (never skipped, never replaced by the remote copy)
    const stamp = new Date(deps.now()).toISOString().replace(/[:.]/g, "-");
    const snapDir = j(dirs.backups, `pre-deploy-${shortSha(state.sha)}-${stamp}`);
    // Dumped into a .tmp folder and renamed only when complete: a failed dump leaves nothing that counts as a snapshot.
    const snapTmp = `${snapDir}.tmp`;
    fsx.mkdirp(dirs.backups, 0o700);
    fsx.mkdirp(snapTmp, 0o700);
    try {
      util(
        "prod: snapshot",
        "praxis-prod",
        state.jobs.ref,
        ["node", "scripts/selfhost/predeploy-copy.mjs", "dump", "--out", "/snap"],
        {
          envFile: jobsEnvFile,
          user: "0:0",
          mounts: [`${snapTmp}:/snap`, copyMount],
        },
      );
    } catch (e) {
      fsx.rm(snapTmp);
      throw e;
    }
    fsx.rename(snapTmp, snapDir);
    rec("prod: local snapshot", true, snapDir);

    // the bucket/repo backup through the running clock, when it is configured; not fatal (the snapshot exists)
    const b = prodCompose(["exec", "-T", "clock", "node", "clock/cli.mjs", "backup-now"], false);
    rec(
      "prod: bucket/repo backup",
      true,
      b.code === 0
        ? "backup job done"
        : "skipped: not configured or the clock is down (local snapshot exists)",
    );

    for (const db of ["main", "auth"]) {
      util(
        `prod: migrate ${db}`,
        "praxis-prod",
        state.jobs.ref,
        ["node", "scripts/db/migrate.mjs", "--db", db, "--target", "sqld"],
        {
          envFile: jobsEnvFile,
          env: state.rollbackAcrossMigrations ? { MIGRATE_ALLOW_NEWER: "1" } : {},
        },
      );
    }
    rec("prod: migrations", true);

    applyEnvFile(state.web.ref, state.jobs.ref, state.sha);
    const revert = () => {
      if (!previous) return "no previous deploy recorded: nothing to go back to";
      applyEnvFile(previous.web.ref, previous.jobs.ref, previous.sha);
      const env = {
        PRAXIS_WEB_IMAGE: previous.web.ref,
        PRAXIS_JOBS_IMAGE: previous.jobs.ref,
        PRAXIS_SHA: previous.sha,
        PRAXIS_ENV_DIR: dirs.env,
      };
      const r = docker(
        [
          "compose",
          "-p",
          prodProject,
          "-f",
          j(dirs.compose, "docker-compose.prod.yml"),
          "--env-file",
          envPath,
          "up",
          "-d",
          "--no-deps",
          "web",
          "clock",
        ],
        env,
      );
      return r.code === 0
        ? `containers put back on ${shortSha(previous.sha)}`
        : "putting the previous containers back failed too";
    };
    const web = prodCompose(["up", "-d", "--no-deps", "--wait", "--wait-timeout", "180", "web"]);
    if (web.code !== 0)
      fail("prod: web", `the new web container did not become healthy; ${revert()}`);
    rec("prod: web restarted", true);

    await waitIdle("prod: clock idle", true).catch(() =>
      note("a job is still running after the wait; restarting the clock anyway"),
    );
    const clock = prodCompose([
      "up",
      "-d",
      "--no-deps",
      "--wait",
      "--wait-timeout",
      "180",
      "clock",
    ]);
    if (clock.code !== 0)
      fail("prod: clock", `the new clock container did not become healthy; ${revert()}`);
    rec("prod: clock restarted", true);
    prodCompose(["up", "-d", "--no-deps", "caddy"]); // idempotent; picks up a changed Caddyfile

    if (previous && previous.sha !== state.sha)
      fsx.write(prevPath, `${JSON.stringify(previous, null, 2)}\n`, 0o644);
    const now = {
      sha: state.sha,
      deployedAt: new Date(deps.now()).toISOString(),
      web: { ref: state.web.ref, digest: state.web.digest },
      jobs: { ref: state.jobs.ref, digest: state.jobs.digest },
    };
    const tmp = `${deployedPath}.tmp`;
    fsx.write(tmp, `${JSON.stringify(now, null, 2)}\n`, 0o644);
    fsx.rename(tmp, deployedPath);
    rec("prod: recorded", true, `${shortSha(state.sha)} in deployed.json`);
    pruneSnapshots();
  };

  // The pre-deploy snapshots are plaintext copies of prod: keep only the newest KEEP_SNAPSHOTS.
  const pruneSnapshots = () => {
    if (typeof fsx.list !== "function") return;
    const stampOf = (n) => n.replace(/^pre-deploy-[0-9a-z-]*?-(\d{4}-\d{2}-\d{2}T)/, "$1");
    const snaps = fsx
      .list(dirs.backups)
      .filter((n) => n.startsWith("pre-deploy-") && !n.endsWith(".tmp"))
      .sort((a, b) => stampOf(b).localeCompare(stampOf(a)));
    for (const n of snaps.slice(KEEP_SNAPSHOTS)) fsx.rm(j(dirs.backups, n));
    // a .tmp left by a killed deploy is not a snapshot
    for (const n of fsx.list(dirs.backups)) {
      if (n.startsWith("pre-deploy-") && n.endsWith(".tmp")) fsx.rm(j(dirs.backups, n));
    }
    rec(
      "prod: snapshots",
      true,
      `${Math.min(snaps.length, KEEP_SNAPSHOTS)} kept, ${Math.max(0, snaps.length - KEEP_SNAPSHOTS)} removed`,
    );
  };

  const prune = (keep) => {
    const r = docker([
      "image",
      "ls",
      "--digests",
      "--format",
      "{{json .}}",
      "--filter",
      `reference=${registry}/praxis-*`,
    ]);
    if (r.code !== 0) return rec("prune", true, "skipped: could not list images");
    let removed = 0;
    for (const line of r.stdout.split("\n").filter(Boolean)) {
      let i;
      try {
        i = JSON.parse(line);
      } catch {
        continue;
      }
      const ref =
        i.Tag && i.Tag !== "<none>" ? `${i.Repository}:${i.Tag}` : `${i.Repository}@${i.Digest}`;
      const byDigest = `${i.Repository}@${i.Digest}`;
      if (keep.has(byDigest) || keep.has(ref)) continue;
      const created = Date.parse(
        String(i.CreatedAt ?? "")
          .slice(0, 19)
          .replace(" ", "T") + "Z",
      );
      if (Number.isNaN(created) || deps.now() - created < KEEP_IMAGES_MS) continue;
      if (docker(["image", "rm", ref]).code === 0) removed++;
    }
    rec(
      "prune",
      true,
      `${removed} image(s) older than 30 days removed (current and previous kept)`,
    );
  };

  // ---- the flow ---------------------------------------------------------------------------------------------------
  let release = null;
  let checkPassed = false;
  try {
    // 1 validate
    let recorded = null;
    if (cfg.images) {
      state.sha = state.sha || "ci-local";
    } else if (cfg.mode === "rollback") {
      const prev = readJson(prevPath);
      if (!prev || !SHA_RE.test(String(prev.sha)) || !prev.web?.ref || !prev.jobs?.ref) {
        fail(
          "validate",
          "no usable deployed.prev.json: there is nothing to roll back to",
          EXIT.USAGE,
        );
      }
      recorded = prev;
      state.sha = prev.sha;
    } else if (!SHA_RE.test(state.sha)) {
      fail(
        "validate",
        "the SHA must be the full 40-character commit id (lower-case hex)",
        EXIT.USAGE,
      );
    }
    rec(
      "validate",
      true,
      cfg.mode === "rollback"
        ? `rollback to ${shortSha(state.sha)} (deployed.prev.json)`
        : shortSha(state.sha),
    );

    if (!cfg.checkOnly) release = fsx.lock(j(dirs.state, "deploy.lock"));
    if (!cfg.checkOnly) await waitIdle("busy", cfg.wait === true);
    if (!cfg.checkOnly) rec("no job is running", true);

    // 2 images by digest
    state.web = resolveImage("web", state.sha, recorded?.web);
    state.jobs = resolveImage("jobs", state.sha, recorded?.jobs);
    rec(
      "images",
      true,
      `web ${state.web.digest ?? "local tag"}, jobs ${state.jobs.digest ?? "local tag"}`,
    );

    // 3 the check (always torn down inside)
    if (cfg.skipCheck) {
      if (cfg.mode !== "rollback")
        fail("check", "--skip-check is only allowed with --rollback", EXIT.USAGE);
      rec("check", true, "SKIPPED by --skip-check (rollback)");
    } else {
      await runCheck();
      checkPassed = true;
    }
    if (cfg.checkOnly) {
      rec("check passed", true, "--check-only: prod not touched");
      return result(EXIT.OK);
    }

    // 4 production
    await prodPhase(readJson(deployedPath));
    prune(
      new Set([
        state.web.ref,
        state.jobs.ref,
        ...[readJson(prevPath)].filter(Boolean).flatMap((p) => [p.web?.ref, p.jobs?.ref]),
      ]),
    );
    rec("deployed", true, shortSha(state.sha));
    return result(EXIT.OK);
  } catch (e) {
    const step = e instanceof DeployError ? e.step : "unexpected";
    const msg = e instanceof DeployError ? e.message : "unexpected error";
    const exit = e instanceof DeployError ? e.exit : EXIT.FAILED;
    rec(step, false, msg);
    if (exit === EXIT.FAILED && !cfg.noNotify && !cfg.checkOnly) {
      const phase = checkPassed ? "the deploy (the check had passed)" : "the pre-deploy check";
      const prodNote = checkPassed
        ? "Prod may be partly changed: see the step list on the server (praxis deploy log)."
        : "Prod was not touched.";
      let sent = "failed";
      try {
        sent = await deps.notify(
          `[Praxis] Deploy of ${shortSha(state.sha)} stopped at ${step}`,
          `${phase} stopped at step "${step}": ${msg}.\n${prodNote}\nSteps:\n${steps.map((s) => `${s.ok ? "ok  " : "FAIL"} ${s.name}`).join("\n")}\n`,
        );
      } catch {
        /* never throws out of the failure path */
      }
      note(`Owner email: ${sent}`);
    }
    return result(exit, step);
  } finally {
    if (release) release();
    try {
      fsx.mkdirp(dirs.state, 0o755);
      fsx.write(
        j(dirs.state, "last-deploy.log"),
        `${steps.map((s) => `${s.ok ? "ok  " : "FAIL"} ${s.name}${s.detail ? `: ${s.detail}` : ""}`).join("\n")}\n`,
        0o644,
      );
    } catch {
      /* the log file is a convenience */
    }
  }
}

// ---- real dependencies ----------------------------------------------------------------------------------------------
export function realDeps(env = process.env, dirs = parseArgs([], env).cfg.dirs) {
  const sh = (cmd, args, o = {}) => {
    const r = spawnSync(cmd, args, {
      encoding: "utf8",
      env: { ...env, ...(o.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
      timeout: 60 * 60_000,
    });
    return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  const fsx = {
    read: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
    write: (p, text, mode = 0o644) => {
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, text, { mode });
    },
    exists: (p) => existsSync(p),
    mkdirp: (p, mode = 0o755) => mkdirSync(p, { recursive: true, mode }),
    rm: (p) => rmSync(p, { recursive: true, force: true }),
    list: (p) => (existsSync(p) ? readdirSync(p) : []),
    rename: (a, b) => renameSync(a, b),
    mkTmp: (prefix) => {
      const d = mkdtempSync(path.join(tmpdir(), prefix));
      chmodSync(d, 0o777); // threshold-ok: the zap user in the container must be able to write the report
      return d;
    },
    lock: (p) => {
      mkdirSync(path.dirname(p), { recursive: true });
      const take = () => writeFileSync(p, `${process.pid}\n`, { flag: "wx" });
      try {
        take();
      } catch {
        let age = 0;
        try {
          age = Date.now() - statSync(p).mtimeMs;
        } catch {
          /* gone */
        }
        if (age < STALE_LOCK_MS)
          throw new DeployError("lock", "another deploy is running (state/deploy.lock)", EXIT.BUSY);
        rmSync(p, { force: true });
        take();
      }
      return () => rmSync(p, { force: true });
    },
  };
  const notify = async (subject, text) => {
    // Owner only, through Resend (the adapter the app and the watchdog use: same endpoint and sender).
    const e = parseEnv(fsx.read(path.join(dirs.env, "jobs.env")) ?? "");
    const key = (e.RESEND_API_KEY ?? "").trim();
    const to = (e.OWNER_EMAIL ?? "").trim();
    if ((e.EMAIL_PROVIDER ?? "").trim().toLowerCase() !== "resend" || !key || !to)
      return "skipped (email is not configured)";
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: "Praxis <onboarding@resend.dev>", to: [to], subject, text }),
        signal: AbortSignal.timeout(30_000),
      });
      return res.status === 200 ? "sent" : `failed (HTTP ${res.status})`;
    } catch {
      return "failed";
    }
  };
  return {
    sh,
    fsx,
    notify,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    log: (l) => console.log(l),
    hasEnv: (n) => typeof env[n] === "string" && env[n] !== "",
  };
}

const USAGE = `usage: praxis deploy <40-hex sha> [--wait] [--no-pull] [--skip-zap] [--data auto|backup|snapshot|none]
       praxis deploy --rollback [--skip-check] [--wait]
       predeploy.mjs --ci --web-image <ref> --jobs-image <ref> [--skip-zap]`;

/** Parse argv into a config (pure; tested). Returns { error } on bad usage. */
export function parseArgs(argv, env = process.env) {
  const root = env.PRAXIS_ROOT ?? "/srv/praxis";
  // docker -v wants absolute host paths: a relative PRAXIS_*_DIR (branch CI) is resolved here (found by real Docker).
  const abs = (p) => (path.isAbsolute(p) ? p : path.resolve(p));
  const cfg = {
    mode: "deploy",
    // PRAXIS_REGISTRY (also read by deploy.sh) moves the image registry: branch CI deploys from a local registry:2.
    ...(env.PRAXIS_REGISTRY ? { registry: env.PRAXIS_REGISTRY } : {}),
    dirs: {
      compose: abs(env.PRAXIS_COMPOSE_DIR ?? `${root}/compose`),
      env: abs(env.PRAXIS_ENV_DIR ?? `${root}/env`),
      state: abs(env.PRAXIS_STATE_DIR ?? `${root}/state`),
      backups: abs(env.PRAXIS_BACKUPS_DIR ?? `${root}/backups`),
      check: abs(env.PRAXIS_CHECK_TMP ?? `${root}/check`),
      scripts: abs(env.PRAXIS_SCRIPTS_DIR ?? path.dirname(fileURLToPath(import.meta.url))),
    },
  };
  const images = {};
  let ci = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--wait") cfg.wait = true;
    else if (a === "--no-pull") cfg.noPull = true;
    else if (a === "--skip-zap") cfg.skipZap = true;
    else if (a === "--skip-check") cfg.skipCheck = true;
    else if (a === "--rollback") cfg.mode = "rollback";
    else if (a === "--check-only") cfg.checkOnly = true;
    else if (a === "--no-notify") cfg.noNotify = true;
    else if (a === "--ci") ci = true;
    else if (a === "--data" && i + 1 < argv.length) cfg.data = argv[++i];
    else if (a === "--web-image" && i + 1 < argv.length) images.web = argv[++i];
    else if (a === "--jobs-image" && i + 1 < argv.length) images.jobs = argv[++i];
    else if (a === "--zap-image" && i + 1 < argv.length) cfg.zapImage = argv[++i];
    else if (!a.startsWith("-") && cfg.sha === undefined) cfg.sha = a;
    else return { error: `unknown or incomplete argument ${a.slice(0, 40)}` };
  }
  if (cfg.data !== undefined && !["auto", "backup", "snapshot", "none"].includes(cfg.data))
    return { error: "--data must be auto, backup, snapshot or none" };
  if (ci) {
    if (!images.web || !images.jobs) return { error: "--ci needs --web-image and --jobs-image" };
    Object.assign(cfg, {
      images,
      checkOnly: true,
      noPull: true,
      noNotify: true,
      data: cfg.data ?? "none",
    });
  } else if (images.web || images.jobs)
    return { error: "--web-image and --jobs-image are only for --ci" };
  if (cfg.mode === "rollback" && cfg.sha !== undefined)
    return { error: "--rollback takes no SHA (it uses deployed.prev.json)" };
  if (cfg.mode === "deploy" && !ci && cfg.sha === undefined) return { error: "a SHA is required" };
  return { cfg };
}

export async function main(argv, env = process.env) {
  const p = parseArgs(argv, env);
  if (p.error) {
    console.log(`deploy: ${p.error}\n${USAGE}`);
    return EXIT.USAGE;
  }
  const deps = realDeps(env, p.cfg.dirs);
  const r = await runDeploy(p.cfg, deps);
  console.log(`deploy: ${r.ok ? "PASS" : "FAIL"}${r.failedStep ? ` at ${r.failedStep}` : ""}`);
  return r.code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
