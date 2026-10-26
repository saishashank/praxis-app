// Workflow lint (M8 T6; docs/M8_design.md 2.3 and decision 40; SEC-107, SEC-108, SEC-110, AT-05a).
// Reads .github/workflows/*.yml as DATA (never runs anything) and reports every rule break. It
// reports findings; it never edits a workflow (a finding in a deploy file goes to the Owner).
//
// Rules (rule id in brackets, printed with each finding):
//   [yaml-parse]            the file is not valid YAML
//   [permissions-missing]   no top-level `permissions:` (the default token would be wide)
//   [permissions-wide]      top-level permissions wider than `contents: read` (or `{}`); a job-level
//                           scope set to `write`, or a `read-all` / `write-all` string, anywhere
//   [uses-unpinned]         a `uses:` that is not owner/repo[/path]@<40-hex SHA>, a docker:// image
//                           without @sha256:, a job container or service image without @sha256:
//                           (local `./` actions are allowed)
//   [pull-request-target]   the `pull_request_target` trigger
//   [run-expression]        `${{ secrets.* }}`, `${{ inputs.* }}`, `${{ github.event.* }}` or
//                           `${{ github.head_ref }}` inside `run:` text (script injection / leak)
//   [secret-placement]      `secrets.*` anywhere except a step's `env:` (also `secrets: inherit`).
//                           One exception: `actions/checkout` `with: token: ${{ secrets.NAME }}` (the
//                           only way to give a checkout a token; the value must be that one expression)
//   [secret-job-storage]    a job that holds secrets (references `secrets.*` or has an
//                           `environment:`) uses actions/upload-artifact, actions/cache or a
//                           setup action with `cache:`
//   [artifact-upload]       actions/upload-artifact outside the allow-list (the failure-only
//                           Playwright report on synthetic data, ci.yml job e2e)
//   [fork-secrets]          a workflow with a `pull_request` trigger has a job that holds secrets
//                           and no job-level `if:` that keeps fork PRs out
//   [concurrency-missing]   a pipeline workflow (dispatched by the Worker, or a deploy) with no
//                           `concurrency:` at the top or on every job that holds secrets
//   [schedule-trigger]      `schedule:` in a file that says "workflow_dispatch ONLY", or in a file
//                           outside the scheduled allow-list (PLT-015)
//   [npm-install]           `npm install` / `npm i` (only `npm ci`)
//   [pip-hashes]            `pip install` without `--require-hashes`
//
// Exceptions: scripts/ci/workflow-lint-exceptions.json lists known findings by file, job, step (the
// 1-based step number) and rule, each with a reason. An entry with approvedBy "pending" is NOT an
// approval: the finding is printed as PENDING and is a warning on normal runs, a failure with
// --release (as for licence-exceptions.json, D-153). An entry approved by the Owner (with a date)
// hides exactly that finding. An entry that matches nothing is reported as stale (a warning).
//
// Usage: node scripts/ci/workflow-lint.mjs [--dir <workflows dir>] [--exceptions <file>] [--release]
//   exit 1 on any finding that has no exception, on a malformed exceptions file, and with
//   --release also on any pending exception.
// Output: one line per finding, `file: [rule] where: sentence`. It never prints a step's command
// text or any value, only file, job and step names/positions.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SHA_USES = /^[\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40}$/;
const DIGEST = /@sha256:[0-9a-f]{64}$/;

/** Workflows the Worker dispatches, plus the deploys: these must serialise (PLT-071). */
export const PIPELINE_WORKFLOWS = [
  "arena-close.yml",
  "arena-signals.yml",
  "backfill-history.yml",
  "backfill-prices.yml",
  "backfill-index.yml",
  "asx-fetch.yml",
  "backup.yml",
  "ingest-batch1.yml",
  "kb-archive.yml",
  "llm-bakeoff.yml",
  "maintenance.yml",
  "replay.yml",
  "watchdog.yml",
  "deploy-staging.yml",
  "deploy-production.yml",
];
/** Files allowed to carry `schedule:` (decision 21 nightly, decision 22 weekly mutation). */
export const SCHEDULED_WORKFLOWS = ["nightly.yml", "mutation.yml"];
/** `file::job` pairs allowed to upload an artifact (failure-only report on synthetic data). */
export const UPLOAD_ALLOWED = ["ci.yml::e2e"];

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const SECRET_REF = /\bsecrets\s*(\.|\[)|secrets:\s*inherit/;

function triggersOf(wf) {
  const on = wf.on ?? wf[true]; // YAML 1.1 parsers turn `on` into `true`
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map(String);
  if (isObj(on)) return Object.keys(on);
  return [];
}

function* leaves(value, p = []) {
  if (Array.isArray(value))
    for (let i = 0; i < value.length; i++) yield* leaves(value[i], [...p, i]);
  else if (isObj(value)) for (const k of Object.keys(value)) yield* leaves(value[k], [...p, k]);
  else yield [p, value];
}

// `actions/checkout` takes its token only through `with: token:`; allow that one place, and only
// when the value is exactly one `${{ secrets.NAME }}` expression.
const SINGLE_SECRET = /^\s*\$\{\{\s*secrets\.[A-Za-z_][A-Za-z0-9_]*\s*\}\}\s*$/;
function isCheckoutToken(wf, p, value) {
  if (
    p[0] !== "jobs" ||
    p[2] !== "steps" ||
    p[4] !== "with" ||
    p[5] !== "token" ||
    p.length !== 6
  ) {
    return false;
  }
  const step = wf.jobs?.[p[1]]?.steps?.[p[3]];
  const uses = isObj(step) && typeof step.uses === "string" ? step.uses.split("@")[0] : "";
  return uses === "actions/checkout" && SINGLE_SECRET.test(value);
}

const stepLabel = (job, i, s) => `job ${job}, step ${i + 1}${s?.name ? ` (${s.name})` : ""}`;

function holdsSecrets(job, wf) {
  if (job.environment !== undefined) return true;
  if (SECRET_REF.test(JSON.stringify(job))) return true;
  return wf.env !== undefined && SECRET_REF.test(JSON.stringify(wf.env));
}

const FORK_GUARDS = [
  /github\.event_name\s*!=\s*['"]pull_request['"]/,
  /github\.event_name\s*==\s*['"](push|workflow_dispatch|schedule)['"]/,
  /github\.event\.pull_request\.head\.repo\.full_name\s*==\s*github\.repository/,
];

/**
 * @param {string} file workflow file name, e.g. "ci.yml"
 * @param {string} text the YAML text
 * @param {{ pipeline?: string[], scheduled?: string[], uploadAllowed?: string[] }} [opts]
 * @returns {{ file: string, rule: string, where: string, message: string }[]}
 */
export function lintWorkflow(file, text, opts = {}) {
  const pipeline = opts.pipeline ?? PIPELINE_WORKFLOWS;
  const scheduled = opts.scheduled ?? SCHEDULED_WORKFLOWS;
  const uploadAllowed = opts.uploadAllowed ?? UPLOAD_ALLOWED;
  const findings = [];
  const add = (rule, where, message) => findings.push({ file, rule, where, message });

  let wf;
  try {
    wf = yaml.load(text);
  } catch {
    add("yaml-parse", "file", "the file is not valid YAML");
    return findings;
  }
  if (!isObj(wf)) {
    add("yaml-parse", "file", "the file is not a YAML mapping");
    return findings;
  }
  const triggers = triggersOf(wf);
  const jobs = isObj(wf.jobs) ? wf.jobs : {};

  // permissions
  if (wf.permissions === undefined) {
    add("permissions-missing", "workflow", "no top-level permissions");
  } else if (typeof wf.permissions === "string") {
    add("permissions-wide", "workflow", `top-level permissions is "${wf.permissions}"`);
  } else if (isObj(wf.permissions)) {
    for (const [scope, level] of Object.entries(wf.permissions)) {
      if (!(scope === "contents" && level === "read") && level !== "none") {
        add(
          "permissions-wide",
          "workflow",
          `top-level ${scope}: ${level} is wider than contents: read`,
        );
      }
    }
  }
  for (const [id, job] of Object.entries(jobs)) {
    if (!isObj(job)) continue;
    if (typeof job.permissions === "string" && /-all$/.test(job.permissions)) {
      add("permissions-wide", `job ${id}`, `permissions is "${job.permissions}"`);
    } else if (isObj(job.permissions)) {
      for (const [scope, level] of Object.entries(job.permissions)) {
        if (level === "write") add("permissions-wide", `job ${id}`, `${scope}: write`);
      }
    }
  }

  // triggers
  if (triggers.includes("pull_request_target")) {
    add("pull-request-target", "workflow", "pull_request_target is not allowed");
  }
  if (triggers.includes("schedule")) {
    if (/workflow_dispatch\s+ONLY/i.test(text)) {
      add("schedule-trigger", "workflow", "the file says workflow_dispatch ONLY but has schedule:");
    }
    if (!scheduled.includes(file)) {
      add("schedule-trigger", "workflow", "schedule: is not allowed in this workflow (PLT-015)");
    }
  }

  // concurrency
  if (pipeline.includes(file)) {
    // Top-level concurrency, or one on every job that holds secrets / an environment (a job with
    // neither, such as a synthetic-data drill, touches no shared state).
    const touching = Object.values(jobs).filter((j) => isObj(j) && holdsSecrets(j, wf));
    const covered = touching.length > 0 ? touching.every((j) => j.concurrency) : false;
    if (!wf.concurrency && !covered) {
      add("concurrency-missing", "workflow", "a pipeline workflow needs concurrency");
    }
  }

  // secrets outside a step's env
  for (const [p, v] of leaves(wf)) {
    if (typeof v !== "string" || !SECRET_REF.test(v)) continue;
    const inStepEnv = p[0] === "jobs" && p[2] === "steps" && p[4] === "env";
    if (!inStepEnv && !isCheckoutToken(wf, p, v)) {
      add(
        "secret-placement",
        p[0] === "jobs" ? `job ${p[1]}, ${p.slice(2).join(".")}` : `workflow, ${p.join(".")}`,
        "secrets are allowed only in a step env:",
      );
    }
  }
  for (const [id, job] of Object.entries(jobs)) {
    if (!isObj(job)) continue;
    const secretive = holdsSecrets(job, wf) || job.secrets === "inherit";
    if (job.secrets === "inherit") {
      add(
        "secret-placement",
        `job ${id}`,
        "secrets: inherit hands every secret to the called workflow",
      );
    }

    if (typeof job.uses === "string" && !job.uses.startsWith("./") && !SHA_USES.test(job.uses)) {
      add("uses-unpinned", `job ${id}`, "reusable workflow is not pinned to a 40-hex SHA");
    }
    const images = [];
    if (typeof job.container === "string") images.push(job.container);
    if (isObj(job.container) && typeof job.container.image === "string") {
      images.push(job.container.image);
    }
    if (isObj(job.services)) {
      for (const s of Object.values(job.services)) {
        if (typeof s === "string") images.push(s);
        else if (isObj(s) && typeof s.image === "string") images.push(s.image);
      }
    }
    for (const img of images) {
      if (!DIGEST.test(img))
        add("uses-unpinned", `job ${id}`, "container image has no @sha256: digest");
    }

    const steps = Array.isArray(job.steps) ? job.steps : [];
    steps.forEach((s, i) => {
      if (!isObj(s)) return;
      const where = stepLabel(id, i, s);
      if (typeof s.uses === "string") {
        const u = s.uses;
        if (u.startsWith("./")) {
          // local action: reviewed in the same commit
        } else if (u.startsWith("docker://")) {
          if (!DIGEST.test(u)) add("uses-unpinned", where, "docker image has no @sha256: digest");
        } else if (!SHA_USES.test(u)) {
          add("uses-unpinned", where, "action is not pinned to a 40-hex SHA");
        }
        const base = u.split("@")[0];
        const isUpload = base === "actions/upload-artifact";
        const isCache = base === "actions/cache" || base.startsWith("actions/cache/");
        const setupCache = base.startsWith("actions/setup-") && s.with && s.with.cache;
        if (secretive && (isUpload || isCache || setupCache)) {
          add(
            "secret-job-storage",
            where,
            "a job that holds secrets must not upload an artifact or use a cache",
          );
        }
        if (isUpload && !uploadAllowed.includes(`${file}::${id}`)) {
          add("artifact-upload", where, "upload-artifact is not on the allow-list (SEC-110)");
        }
        if (isUpload && uploadAllowed.includes(`${file}::${id}`)) {
          if (typeof s.if !== "string" || !/failure\(\)/.test(s.if)) {
            add("artifact-upload", where, "an allowed upload must run only on failure()");
          }
        }
      }
      if (typeof s.run === "string") {
        for (const m of s.run.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
          if (/\b(secrets|inputs)\s*(\.|\[)|github\s*\.\s*(event\b|head_ref\b)/.test(m[1])) {
            add(
              "run-expression",
              where,
              "a secrets, inputs or github.event expression is inside run: text; pass it through env:",
            );
            break;
          }
        }
        if (/(^|[\s;&|(])npm\s+(install|i|add)(\s|$)/m.test(s.run)) {
          add("npm-install", where, "use npm ci, not npm install");
        }
        for (const line of s.run.split("\n")) {
          if (/(^|[\s;&|(])pip3?\s+install\b/.test(line) && !/--require-hashes/.test(line)) {
            add("pip-hashes", where, "pip install needs --require-hashes");
            break;
          }
        }
      }
    });

    if (triggers.includes("pull_request") && secretive) {
      const cond = typeof job.if === "string" ? job.if : "";
      if (!FORK_GUARDS.some((re) => re.test(cond))) {
        add(
          "fork-secrets",
          `job ${id}`,
          "a pull_request workflow job that holds secrets needs an if: that keeps fork PRs out",
        );
      }
    }
  }
  return findings;
}

export function lintDir(dir, opts) {
  const findings = [];
  const files = readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort();
  for (const f of files)
    findings.push(...lintWorkflow(f, readFileSync(path.join(dir, f), "utf8"), opts));
  return { files, findings };
}

const EXC_RULE = /^[a-z][a-z-]*$/;
const EXC_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Splits findings into the ones still open, the ones with a pending exception and the ones the
 * Owner approved; also reports malformed and stale exception entries. Pure.
 * @param {{ file: string, rule: string, where: string, message: string }[]} findings
 * @param {unknown} exceptionsFile parsed workflow-lint-exceptions.json
 */
export function applyExceptions(findings, exceptionsFile) {
  const problems = [];
  const list =
    exceptionsFile && typeof exceptionsFile === "object" && Array.isArray(exceptionsFile.exceptions)
      ? exceptionsFile.exceptions
      : null;
  if (!list) {
    return {
      open: findings,
      pending: [],
      approved: [],
      stale: [],
      problems: ["the exceptions file has no exceptions list"],
    };
  }
  const entries = [];
  list.forEach((e, i) => {
    const at = `exception ${i + 1}`;
    const ok =
      isObj(e) &&
      typeof e.file === "string" &&
      /\.ya?ml$/.test(e.file) &&
      typeof e.job === "string" &&
      e.job !== "" &&
      Number.isInteger(e.step) &&
      e.step >= 1 &&
      typeof e.rule === "string" &&
      EXC_RULE.test(e.rule);
    if (!ok) {
      problems.push(`${at}: needs file (.yml), job, step (a number from 1) and rule`);
      return;
    }
    if (typeof e.reason !== "string" || e.reason.trim().length < 10) {
      problems.push(`${at}: needs a reason (at least 10 characters)`);
      return;
    }
    if (e.approvedBy === "pending") {
      entries.push({ ...e, used: false });
    } else if (
      typeof e.approvedBy === "string" &&
      e.approvedBy.trim() !== "" &&
      EXC_DATE.test(e.date ?? "")
    ) {
      entries.push({ ...e, used: false });
    } else {
      problems.push(`${at}: approvedBy must be "pending", or a name with a YYYY-MM-DD date`);
    }
  });
  const open = [];
  const pending = [];
  const approved = [];
  for (const f of findings) {
    const job = /^job (\S+?)(?:,|$)/.exec(f.where)?.[1];
    const step = Number(/step (\d+)/.exec(f.where)?.[1]);
    const hit = entries.find(
      (e) => e.file === f.file && e.rule === f.rule && e.job === job && e.step === step,
    );
    if (!hit) open.push(f);
    else {
      hit.used = true;
      (hit.approvedBy === "pending" ? pending : approved).push(f);
    }
  }
  const stale = entries
    .filter((e) => !e.used)
    .map((e) => `${e.file} job ${e.job} step ${e.step} [${e.rule}]`);
  return { open, pending, approved, stale, problems };
}

export function format(f) {
  return `${f.file}: [${f.rule}] ${f.where}: ${f.message}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const dir = arg("--dir") ? path.resolve(arg("--dir")) : path.join(ROOT, ".github/workflows");
  const excFile = arg("--exceptions")
    ? path.resolve(arg("--exceptions"))
    : path.join(ROOT, "scripts/ci/workflow-lint-exceptions.json");
  const release = process.argv.includes("--release");
  const { files, findings } = lintDir(dir);
  let exceptions = { exceptions: [] };
  try {
    exceptions = JSON.parse(readFileSync(excFile, "utf8"));
  } catch (e) {
    if (e?.code !== "ENOENT") exceptions = null; // unreadable or not JSON: reported below
  }
  const r = exceptions
    ? applyExceptions(findings, exceptions)
    : {
        open: findings,
        pending: [],
        approved: [],
        stale: [],
        problems: ["the exceptions file is not valid JSON"],
      };
  for (const f of r.open) console.log(format(f));
  for (const f of r.pending) {
    console.warn(
      `PENDING ${format(f)} (Owner approval pending${release ? "; fails with --release" : ""})`,
    );
  }
  for (const s of r.stale) console.warn(`STALE exception matches no finding: ${s}`);
  for (const p of r.problems) console.log(`workflow-lint exceptions: ${p}`);
  const failures = r.open.length + r.problems.length + (release ? r.pending.length : 0);
  console.log(
    `workflow-lint: ${files.length} workflow(s), ${r.open.length} finding(s), ${r.pending.length} pending Owner approval, ${r.approved.length} approved exception(s)`,
  );
  process.exit(failures === 0 ? 0 : 1);
}
