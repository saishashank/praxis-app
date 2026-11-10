// Job manifest of praxis-clock (INFRA T3; REQ\infra\INFRA_REQUIREMENT.md §5.2). `deploy/selfhost/jobs.json`
// maps each dispatchable GitHub workflow to the commands of its `production` job, so a clock job runs the
// same scripts an Actions run does. A CI test (tests/selfhost/manifest-drift.test.ts) compares the file with
// `.github/workflows/*.yml`, so the two cannot drift apart.
//
// Step fields (everything is plain data, nothing is interpreted by a shell):
//   run     the command. Split into words with quotes; `$W` is the per-run directory; `$NAME` or `${NAME}`
//           is a variable of the step's own env (an unquoted variable that is empty vanishes, like in sh).
//   env     variables handed to THIS step only (the same pattern as `env:` of a workflow step: secrets reach
//           only the step that needs them). Values are sources, see `resolveSource`.
//   if      run the step only when this holds: `out:<step>.<key>=<value>` or `outcome:<step>=<status>`.
//   always  run even after an earlier step failed (the workflow's `!cancelled()`).
//   localOnly  a step with no counterpart in the workflow (the drift test skips it).
import { readFileSync } from "node:fs";

export type Step = {
  id?: string;
  run: string;
  env?: Record<string, string>;
  if?: string;
  always?: boolean;
  localOnly?: boolean;
};
/** What the runner needs of any job, workflow-backed or local-only. */
export type RunnableJob = {
  /** Wall-clock limit of the whole run in minutes (the workflow's `timeout-minutes`). */
  timeoutMin: number;
  /** One run per group at a time; jobs of the same group exclude each other. */
  group: string;
  /** Extra job names that may not run while this one runs (and the other way round). */
  exclusiveWith?: string[];
  /** A step that ends with one of these codes counts as success (in addition to 0). */
  okExitCodes?: number[];
  /** A step that ends with one of these codes ends the job as `standby`: a guard refused, nothing was done, no alert. */
  standbyExitCodes?: number[];
  steps: Step[];
};
/** A job that mirrors a GitHub workflow (the cloud runs the workflow, the clock runs the commands). */
export type Job = RunnableJob & {
  /** The workflow file this job mirrors. */
  workflow: string;
};
/** When a local-only job runs: Sydney local time, `from` to `until` every `everyMin`, optionally on some weekdays only. */
export type LocalSchedule = {
  from: string;
  until: string;
  everyMin: number;
  /** 0 = Sunday .. 6 = Saturday; absent = every day. */
  days?: number[];
};
/** A job that exists only on the self-hosted runtime: no workflow, not in AU_SLOTS, fired by the clock when it is owner. */
export type LocalJob = RunnableJob & { schedule: LocalSchedule };
export type Manifest = {
  version: 1;
  /** Workflows the clock leaves on GitHub (INF-O5: replay needs a 12 GB heap). */
  passthrough: string[];
  jobs: Record<string, Job>;
  /** Self-hosted-only scheduled jobs (backups to the bucket, Turso refresh, restore drill). */
  localSchedule?: Record<string, LocalJob>;
};

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const WORKFLOW_RE = /^[a-z0-9][a-z0-9-]*\.yml$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const STEP_ID_RE = /^[a-z][a-z0-9_-]*$/;
const SOURCE_RE =
  /^(env|env:[A-Z][A-Z0-9_]*|const:\S*|input:[a-z_]+(\|\S*)?|out:[a-z][a-z0-9_-]*\.[a-z_]+|flag:[a-z_]+=[^|\s]*\|[^|\s]*|when:[a-z_]+\?.+)$/;

/** Throws a plain Error naming the first problem; the manifest is data we ship, so this is a build-time check. */
export function validateManifest(m: unknown): Manifest {
  const bad = (msg: string): never => {
    throw new Error(`jobs.json: ${msg}`);
  };
  if (typeof m !== "object" || m === null) return bad("not an object");
  const man = m as Manifest;
  if (man.version !== 1) bad("version must be 1");
  if (!Array.isArray(man.passthrough) || man.passthrough.some((w) => !WORKFLOW_RE.test(w))) {
    bad("passthrough must be a list of workflow files");
  }
  if (typeof man.jobs !== "object" || man.jobs === null) return bad("jobs missing");
  const local = man.localSchedule ?? {};
  const all: Record<string, RunnableJob> = { ...man.jobs, ...local };
  const workflows = new Set<string>();
  for (const [name, lj] of Object.entries(local)) {
    if (name in man.jobs) bad(`${name}: a local job may not reuse a workflow job name`);
    if ("workflow" in lj) bad(`${name}: a local job has no workflow`);
    const sc = lj.schedule;
    if (
      !sc ||
      !HHMM_RE.test(sc.from) ||
      !HHMM_RE.test(sc.until) ||
      !Number.isInteger(sc.everyMin) ||
      sc.everyMin < 1 ||
      sc.from > sc.until ||
      (sc.days !== undefined && !sc.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6))
    ) {
      bad(`${name}: bad schedule`);
    }
  }
  for (const [name, job] of Object.entries(all)) {
    if (!NAME_RE.test(name)) bad(`bad job name ${name}`);
    if (name in man.jobs) {
      const wf = (job as Job).workflow;
      if (!WORKFLOW_RE.test(wf)) bad(`${name}: bad workflow`);
      if (workflows.has(wf)) bad(`${name}: workflow ${wf} used twice`);
      workflows.add(wf);
      if (man.passthrough.includes(wf)) bad(`${name}: workflow is passthrough`);
    }
    for (const k of ["okExitCodes", "standbyExitCodes"] as const) {
      const v = job[k];
      if (
        v !== undefined &&
        !(Array.isArray(v) && v.every((c) => Number.isInteger(c) && c > 0 && c < 256))
      ) {
        bad(`${name}: bad ${k}`);
      }
    }
    if (!(typeof job.timeoutMin === "number" && job.timeoutMin > 0)) bad(`${name}: timeoutMin`);
    if (!NAME_RE.test(job.group)) bad(`${name}: bad group`);
    for (const other of job.exclusiveWith ?? []) {
      if (!(other in all)) bad(`${name}: exclusiveWith names unknown job ${other}`);
      if (!(all[other]!.exclusiveWith ?? []).includes(name)) {
        bad(`${name}: exclusiveWith ${other} must be mutual`);
      }
    }
    if (!Array.isArray(job.steps) || job.steps.length === 0) bad(`${name}: no steps`);
    const ids = new Set<string>();
    for (const s of job.steps) {
      if (typeof s.run !== "string" || s.run.trim() === "") bad(`${name}: empty run`);
      if (s.if !== undefined) {
        const c = parseCondition(s.if);
        if (c === null) bad(`${name}: unreadable condition ${s.if}`);
        else if (!ids.has(c.step)) bad(`${name}: condition names unknown earlier step ${c.step}`);
      }
      if (s.id !== undefined) {
        if (!STEP_ID_RE.test(s.id) || ids.has(s.id)) bad(`${name}: bad or repeated step id`);
        ids.add(s.id);
      }
      for (const [k, v] of Object.entries(s.env ?? {})) {
        if (!/^[A-Z][A-Z0-9_]*$/.test(k)) bad(`${name}: bad env name ${k}`);
        if (!SOURCE_RE.test(v)) bad(`${name}: bad env source for ${k}`);
      }
    }
  }
  return man;
}

export function loadManifest(path: string): Manifest {
  return validateManifest(JSON.parse(readFileSync(path, "utf8")));
}

/** Job name of a workflow file, or null (not in the manifest). */
export function jobForWorkflow(m: Manifest, workflow: string): string | null {
  for (const [name, job] of Object.entries(m.jobs)) if (job.workflow === workflow) return name;
  return null;
}

/** A job of either kind by name. */
export function getJob(m: Manifest, name: string): RunnableJob | undefined {
  return Object.hasOwn(m.jobs, name)
    ? m.jobs[name]
    : Object.hasOwn(m.localSchedule ?? {}, name)
      ? m.localSchedule![name]
      : undefined;
}

export function allJobs(m: Manifest): [string, RunnableJob][] {
  return [...Object.entries(m.jobs), ...Object.entries(m.localSchedule ?? {})];
}

/** All job names that may not run while `name` runs: its group and its explicit exclusions. */
export function blockingJobs(m: Manifest, name: string): string[] {
  const me = getJob(m, name);
  if (!me) return [name];
  const out = new Set<string>([name]);
  for (const [other, job] of allJobs(m)) if (job.group === me.group) out.add(other);
  for (const other of me.exclusiveWith ?? []) out.add(other);
  return [...out].sort();
}

const hhmmMinutes = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** Local-only jobs due at a Sydney local minute of the day (0..1439) on a weekday (0 = Sunday). Pure. */
export function localJobsDue(m: Manifest, minuteOfDay: number, dow: number): string[] {
  const out: string[] = [];
  for (const [name, j] of Object.entries(m.localSchedule ?? {})) {
    const sc = j.schedule;
    const from = hhmmMinutes(sc.from);
    if (sc.days !== undefined && !sc.days.includes(dow)) continue;
    if (
      minuteOfDay >= from &&
      minuteOfDay <= hhmmMinutes(sc.until) &&
      (minuteOfDay - from) % sc.everyMin === 0
    ) {
      out.push(name);
    }
  }
  return out;
}

// ---- env sources and conditions --------------------------------------------------------------------------
export type SourceCtx = {
  /** The clock's own environment (jobs.env). */
  env: Readonly<Record<string, string | undefined>>;
  /** Workflow inputs of this run (strings, like GitHub's). */
  inputs: Readonly<Record<string, string>>;
  /** Outputs written by earlier steps: `outputs.<step>.<key>`. */
  outputs: Readonly<Record<string, Readonly<Record<string, string>>>>;
};

const truthy = (v: string | undefined): boolean => v === "true" || v === "1" || v === "yes";

/**
 * The value of one step env variable, or undefined (= leave it out). Sources:
 *   env | env:NAME       from the clock's environment (same name | another name)
 *   const:VALUE          a fixed value
 *   input:KEY[|DEFAULT]  a workflow input
 *   out:STEP.KEY         an output of an earlier step
 *   flag:KEY=YES|NO      YES when the input is true, else NO (Actions: `inputs.k && 'YES' || 'NO'`)
 *   when:KEY?SOURCE      SOURCE when the input is true, else "" (Actions: `inputs.k && secret || ''`)
 */
export function resolveSource(name: string, source: string, ctx: SourceCtx): string | undefined {
  if (source === "env") return ctx.env[name];
  if (source.startsWith("env:")) return ctx.env[source.slice(4)];
  if (source.startsWith("const:")) return source.slice(6);
  if (source.startsWith("input:")) {
    const [key, ...rest] = source.slice(6).split("|");
    const v = ctx.inputs[key!];
    return v !== undefined && v !== "" ? v : rest.length > 0 ? rest.join("|") : "";
  }
  if (source.startsWith("out:")) {
    const [step, key] = source.slice(4).split(".");
    return ctx.outputs[step!]?.[key!] ?? "";
  }
  if (source.startsWith("flag:")) {
    const eq = source.indexOf("=");
    const key = source.slice(5, eq);
    const [yes, no] = source.slice(eq + 1).split("|");
    return truthy(ctx.inputs[key]) ? yes : no;
  }
  if (source.startsWith("when:")) {
    const q = source.indexOf("?");
    const key = source.slice(5, q);
    return truthy(ctx.inputs[key]) ? resolveSource(name, source.slice(q + 1), ctx) : "";
  }
  return undefined;
}

export type Condition =
  | { kind: "out"; step: string; key: string; value: string }
  | { kind: "outcome"; step: string; value: string };

export function parseCondition(c: string): Condition | null {
  let m = /^out:([a-z][a-z0-9_-]*)\.([a-z_]+)=(\S+)$/.exec(c);
  if (m) return { kind: "out", step: m[1]!, key: m[2]!, value: m[3]! };
  m = /^outcome:([a-z][a-z0-9_-]*)=(success|failure|skipped)$/.exec(c);
  if (m) return { kind: "outcome", step: m[1]!, value: m[2]! };
  return null;
}

export type StepOutcome = "success" | "failure" | "skipped";

export function conditionHolds(
  c: string,
  outputs: SourceCtx["outputs"],
  outcomes: Readonly<Record<string, StepOutcome>>,
): boolean {
  const p = parseCondition(c);
  if (p === null) return false;
  if (p.kind === "out") return outputs[p.step]?.[p.key] === p.value;
  return outcomes[p.step] === p.value;
}

// ---- command words ----------------------------------------------------------------------------------------
const SHELL_CHARS = "|&;<>()`*?";

/**
 * Splits a command into argv. Single quotes are literal; double quotes allow `$VAR`; an unquoted `$VAR`
 * is split on spaces and vanishes when empty (the sh behaviour the workflows rely on, e.g. $HISTORY_FLAG).
 * No pipes, redirects or globs: a character of that kind outside quotes is an error.
 */
export function tokenize(
  cmd: string,
  vars: Readonly<Record<string, string | undefined>>,
): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false; // a quoted empty string still makes a word
  const expand = (i: number): [string, number] => {
    const m = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/.exec(cmd.slice(i));
    if (!m) return ["$", i + 1];
    return [vars[m[1] ?? m[2]!] ?? "", i + m[0].length];
  };
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i]!;
    if (ch === " " || ch === "\t" || ch === "\n") {
      if (has) out.push(cur);
      cur = "";
      has = false;
      i++;
    } else if (ch === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end < 0) throw new Error("unterminated quote");
      cur += cmd.slice(i + 1, end);
      has = true;
      i = end + 1;
    } else if (ch === '"') {
      i++;
      has = true;
      for (;;) {
        if (i >= cmd.length) throw new Error("unterminated quote");
        const c = cmd[i]!;
        if (c === '"') {
          i++;
          break;
        }
        if (c === "\\" && (cmd[i + 1] === '"' || cmd[i + 1] === "\\")) {
          cur += cmd[i + 1];
          i += 2;
        } else if (c === "$") {
          const [v, ni] = expand(i);
          cur += v;
          i = ni;
        } else {
          cur += c;
          i++;
        }
      }
    } else if (ch === "$") {
      const [v, ni] = expand(i);
      i = ni;
      const words = v.split(/\s+/).filter((w) => w !== "");
      if (words.length === 0) continue;
      cur += words[0];
      has = true;
      for (const w of words.slice(1)) {
        out.push(cur);
        cur = w;
      }
    } else if (SHELL_CHARS.includes(ch)) {
      throw new Error(`shell syntax is not supported in a job command: ${ch}`);
    } else {
      cur += ch;
      has = true;
      i++;
    }
  }
  if (has) out.push(cur);
  return out;
}
