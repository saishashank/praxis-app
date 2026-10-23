// Store adapters for the Owner's secrets tool (D-176): the exact command that writes, lists or
// checks a name in GitHub (gh), Vercel (vercel CLI) and Cloudflare (wrangler), run under the
// Owner's own logins on the Owner's machine. A value is only ever passed on standard input, never
// as an argument, and any captured output is redacted before it is shown. The command builders are
// pure (tested); `run` spawns.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
/** The Vercel CLI version the deploy workflows pin. */
export const VERCEL_CLI = "vercel@63.1.0";

/** Public names (already in the workflows). Ids that are not in the repo come from the targets file. */
export const DEFAULT_TARGETS = {
  repo: "saishashank/praxis-app",
  vercel: { teamId: null, projects: { production: null, staging: null } },
  workers: { production: "praxis-sentinel", staging: "praxis-sentinel-staging" },
  cloudflareAccounts: { production: null, staging: null },
  deploy: {
    production: { workflow: "deploy-production.yml", ref: "release" },
    staging: { workflow: "deploy-staging.yml", ref: "main" },
  },
};

/** The targets file sits next to the repo, never inside it (it holds account and project ids). */
export const DEFAULT_TARGETS_PATH = path.resolve(ROOT, "..", "praxis-secrets-targets.json");

export function loadTargets(file = DEFAULT_TARGETS_PATH) {
  const local = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  return {
    ...DEFAULT_TARGETS,
    ...local,
    vercel: {
      ...DEFAULT_TARGETS.vercel,
      ...local.vercel,
      projects: { ...DEFAULT_TARGETS.vercel.projects, ...local.vercel?.projects },
    },
    workers: { ...DEFAULT_TARGETS.workers, ...local.workers },
    cloudflareAccounts: { ...DEFAULT_TARGETS.cloudflareAccounts, ...local.cloudflareAccounts },
    deploy: { ...DEFAULT_TARGETS.deploy, ...local.deploy },
  };
}

const npx = (args) => ({ cmd: "npx", args });

function vercelEnv(targets, env) {
  const projectId = targets.vercel.projects[env];
  if (!targets.vercel.teamId || !projectId) {
    throw new Error(
      `Vercel ids for ${env} missing in the targets file (vercel.teamId, vercel.projects.${env})`,
    );
  }
  return { VERCEL_ORG_ID: targets.vercel.teamId, VERCEL_PROJECT_ID: projectId };
}

function workerEnv(targets, env) {
  const id = targets.cloudflareAccounts[env];
  return id ? { CLOUDFLARE_ACCOUNT_ID: id } : {};
}

/**
 * The commands that write one value to one place, run in order. The value goes on stdin.
 * `mayFail` marks a step whose failure is fine (removing a Vercel name that does not exist yet).
 */
export function writeSteps(w, targets) {
  if (w.store === "github-env") {
    return [
      {
        cmd: "gh",
        args: ["secret", "set", w.name, "--env", w.githubEnv, "--repo", targets.repo],
        stdin: true,
      },
    ];
  }
  if (w.store === "vercel-env") {
    const env = vercelEnv(targets, w.env);
    const cli = ["--yes", VERCEL_CLI];
    return [
      {
        ...npx([...cli, "env", "rm", w.name, "production", "--yes"]),
        env,
        cwd: os.tmpdir(),
        mayFail: true,
      },
      { ...npx([...cli, "env", "add", w.name, "production"]), env, cwd: os.tmpdir(), stdin: true },
    ];
  }
  if (w.store === "cloudflare-worker") {
    return [
      {
        ...npx([
          "--no-install",
          "wrangler",
          "secret",
          "put",
          w.name,
          "--name",
          targets.workers[w.env],
        ]),
        env: workerEnv(targets, w.env),
        cwd: path.join(ROOT, "worker"),
        stdin: true,
      },
    ];
  }
  throw new Error(`the tool cannot write to ${w.store}`);
}

/** The command that lists the names held in one place (never values). */
export function listStep(store, where, targets) {
  if (store === "github-env") {
    return {
      cmd: "gh",
      args: ["secret", "list", "--env", where, "--repo", targets.repo, "--json", "name"],
    };
  }
  if (store === "vercel-env") {
    return {
      ...npx(["--yes", VERCEL_CLI, "env", "ls", "production"]),
      env: vercelEnv(targets, where),
      cwd: os.tmpdir(),
    };
  }
  if (store === "cloudflare-worker") {
    return {
      ...npx([
        "--no-install",
        "wrangler",
        "secret",
        "list",
        "--name",
        targets.workers[where],
        "--format",
        "json",
      ]),
      env: workerEnv(targets, where),
      cwd: path.join(ROOT, "worker"),
    };
  }
  throw new Error(`the tool cannot list ${store}`);
}

/** Names found in a list command's output. Vercel prints a table, so known names are matched. */
export function parseNames(store, stdout, known = []) {
  if (store === "github-env" || store === "cloudflare-worker") {
    const start = stdout.indexOf("[");
    if (start < 0) return [];
    return JSON.parse(stdout.slice(start)).map((x) => x.name);
  }
  return known.filter((n) => new RegExp(`(^|\\s)${n}(\\s|$)`, "m").test(stdout));
}

/** The login checks for `doctor` (who is signed in; never a token). */
export function doctorSteps(targets) {
  return [
    {
      what: "GitHub (gh): admin on the code repo",
      step: { cmd: "gh", args: ["api", `repos/${targets.repo}`, "--jq", ".permissions.admin"] },
      ok: (r) => r.code === 0 && r.stdout.trim() === "true",
      fix: "gh auth switch --user <your account> (an account with admin on the repo)",
    },
    {
      what: "Cloudflare (wrangler): signed in",
      step: { ...npx(["--no-install", "wrangler", "whoami"]), cwd: path.join(ROOT, "worker") },
      ok: (r) => r.code === 0 && !/not authenticated/i.test(r.stdout + r.stderr),
      fix: "npm run secrets -- login",
    },
    {
      what: "Vercel (vercel): signed in",
      step: { ...npx(["--yes", VERCEL_CLI, "whoami"]), cwd: os.tmpdir() },
      ok: (r) => r.code === 0,
      fix: "npm run secrets -- login",
    },
  ];
}

/** Interactive sign-ins the Owner completes in the browser (`login`). */
export function loginSteps() {
  return [
    { ...npx(["--no-install", "wrangler", "login"]), cwd: path.join(ROOT, "worker") },
    { ...npx(["--yes", VERCEL_CLI, "login"]), cwd: os.tmpdir() },
  ];
}

/** Replace every copy of each value with ***, so no output line can carry one. */
export function redact(text, values) {
  let out = text;
  for (const v of values) if (v && v.length >= 4) out = out.split(v).join("***");
  return out;
}

/** Run one step. Output is captured (not shown) unless `inherit` is set for an interactive login. */
export function run(step, { input, inherit = false } = {}) {
  return new Promise((resolve) => {
    // Windows runs npx/gh through cmd.exe; the arguments are fixed names, never a value.
    const [cmd, args] =
      process.platform === "win32"
        ? ["cmd.exe", ["/d", "/s", "/c", step.cmd, ...step.args]]
        : [step.cmd, step.args];
    const child = spawn(cmd, args, {
      cwd: step.cwd ?? ROOT,
      env: { ...process.env, ...step.env },
      stdio: inherit ? "inherit" : ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    if (!inherit) {
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.stdin.end(input ?? "");
    }
    child.on("error", (e) => resolve({ code: 127, stdout, stderr: String(e.message) }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
