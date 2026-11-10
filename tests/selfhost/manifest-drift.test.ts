// @vitest-environment node
// INFRA T3 (REQ\infra\INFRA_REQUIREMENT.md §5.2): `deploy/selfhost/jobs.json` and `.github/workflows/*.yml`
// cannot drift apart. Fails when a dispatchable or scheduled workflow has no manifest job, when a manifest job
// points at a missing workflow, when a command, its env names, its timeout or its conditions differ from the
// workflow's `production` job, and when the UTC cron table of the clock no longer matches vercel.json and the
// workflows' own `schedule:` lines.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { UTC_CRONS } from "../../clock/crons";
import { loadManifest, validateManifest, type Step } from "../../clock/manifest";
import { AU_SLOTS, DISPATCHABLE_WORKFLOWS } from "../../worker/src/schedule";

const ROOT = path.resolve(import.meta.dirname, "../..");
const WF_DIR = path.join(ROOT, ".github", "workflows");
const manifest = loadManifest(path.join(ROOT, "deploy", "selfhost", "jobs.json"));

type WfStep = { name?: string; run?: string; if?: string; env?: Record<string, string> };
type WfJob = {
  "timeout-minutes"?: number;
  concurrency?: { group?: string };
  steps?: WfStep[];
};
type Wf = {
  on: { schedule?: { cron: string }[]; workflow_dispatch?: unknown };
  jobs: Record<string, WfJob>;
};
const workflows = new Map<string, Wf>();
for (const f of readdirSync(WF_DIR).filter((x) => x.endsWith(".yml"))) {
  const raw = load(readFileSync(path.join(WF_DIR, f), "utf8")) as Omit<Wf, "on"> & { on: unknown };
  // `on:` may be a single event name or a list instead of a map.
  const on =
    typeof raw.on === "string"
      ? { [raw.on]: null }
      : Array.isArray(raw.on)
        ? Object.fromEntries((raw.on as string[]).map((e) => [e, null]))
        : ((raw.on ?? {}) as Wf["on"]);
  workflows.set(f, { ...raw, on });
}

/** CI workflows with a `schedule:` that stay on GitHub (INF-O2): they are not runtime jobs. */
const CI_ONLY = ["nightly.yml", "mutation.yml"];
/** Workflow steps that exist only on a GitHub runner; the image or the server replaces them. */
const RUNNER_ONLY: { test: RegExp; why: string }[] = [
  {
    test: /approved-commit\.mjs/,
    why: "the image tag is the approved commit (deploy.sh checks the SHA)",
  },
  { test: /^npm ci\b/, why: "dependencies are baked into the image" },
  {
    test: /^pip install\b/,
    why: "hashed Python requirements are installed in the image (SEC-107)",
  },
];
/** A whole step with no meaning on the server: the temporary restore key is never there. */
const RUNNER_ONLY_STEP = /BACKUP_PRIVATE_KEY/;

/** The commands of the workflow's `production` job that the clock must run, with their env names. */
function expectedSteps(wf: Wf): { run: string; env: string[]; hasIf: boolean; always: boolean }[] {
  const out: { run: string; env: string[]; hasIf: boolean; always: boolean }[] = [];
  for (const s of wf.jobs.production?.steps ?? []) {
    if (!s.run || RUNNER_ONLY_STEP.test(s.run)) continue;
    for (const line of s.run
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)) {
      if (RUNNER_ONLY.some((r) => r.test.test(line))) continue;
      out.push({
        run: line,
        env: Object.keys(s.env ?? {}).sort(),
        hasIf: Boolean(s.if),
        always: (s.if ?? "").includes("!cancelled()"),
      });
    }
  }
  return out;
}
const withoutW = (run: string): string => run.split("$W/").join("");

describe("every dispatchable or scheduled workflow has a manifest job", () => {
  it("all DISPATCHABLE_WORKFLOWS but the passthrough ones are manifest jobs", () => {
    const covered = new Set(Object.values(manifest.jobs).map((j) => j.workflow));
    for (const wf of DISPATCHABLE_WORKFLOWS) {
      if (manifest.passthrough.includes(wf)) continue;
      expect(covered.has(wf), `${wf} is dispatched by the Worker but has no manifest job`).toBe(
        true,
      );
    }
    for (const wf of manifest.passthrough) {
      expect(DISPATCHABLE_WORKFLOWS, wf).toContain(wf);
      expect(workflows.has(wf), wf).toBe(true);
    }
    expect(manifest.passthrough).toEqual(["replay.yml"]); // INF-O5
  });

  it("every workflow with a `schedule:` is a manifest job, or one of the CI-only ones", () => {
    const covered = new Set(Object.values(manifest.jobs).map((j) => j.workflow));
    for (const [f, wf] of workflows) {
      if (!wf.on.schedule) continue;
      if (CI_ONLY.includes(f)) continue;
      expect(covered.has(f), `${f} has a schedule: but no manifest job`).toBe(true);
    }
    for (const f of CI_ONLY) expect(workflows.get(f)?.on.schedule, f).toBeDefined();
  });

  it("every manifest job points at an existing workflow that can be dispatched", () => {
    for (const [name, job] of Object.entries(manifest.jobs)) {
      const wf = workflows.get(job.workflow);
      expect(wf, `${name}: ${job.workflow} is missing`).toBeDefined();
      expect("workflow_dispatch" in (wf?.on ?? {}), `${name}: no workflow_dispatch`).toBe(true);
    }
  });

  it("the runner-only steps are exactly the ones this test knows (a new kind of step must be decided)", () => {
    expect(RUNNER_ONLY.map((r) => r.why)).toHaveLength(3);
  });
});

describe("each manifest job runs the commands of its workflow's production job", () => {
  for (const [name, job] of Object.entries(manifest.jobs)) {
    it(`${name} (${job.workflow})`, () => {
      const wf = workflows.get(job.workflow)!;
      expect(job.timeoutMin, "timeout-minutes").toBe(wf.jobs.production?.["timeout-minutes"]);
      const want = expectedSteps(wf);
      const have = job.steps.filter((s: Step) => !s.localOnly);
      expect(
        have.map((s) => withoutW(s.run)),
        "commands",
      ).toEqual(want.map((w) => w.run));
      have.forEach((s, i) => {
        const w = want[i]!;
        expect(Object.keys(s.env ?? {}).sort(), `env names of step ${i + 1}`).toEqual(w.env);
        if (w.hasIf) {
          expect(s.if !== undefined || s.always === true, `condition of step ${i + 1}`).toBe(true);
        }
        expect(s.always === true, `always of step ${i + 1}`).toBe(w.always);
      });
    });
  }
});

describe("localSchedule: jobs that exist only on the self-hosted runtime", () => {
  const local = manifest.localSchedule ?? {};
  it("are exactly bucket-hourly, turso-refresh and restore-drill, with no workflow", () => {
    expect(Object.keys(local).sort()).toEqual(["bucket-hourly", "restore-drill", "turso-refresh"]);
    for (const [name, j] of Object.entries(local)) {
      expect("workflow" in j, name).toBe(false);
      expect(name in manifest.jobs, name).toBe(false);
    }
  });
  it("are not in AU_SLOTS and the Worker never dispatches them (the cloud is unchanged)", () => {
    const slotIds = AU_SLOTS.map((s) => s.id);
    for (const name of Object.keys(local)) {
      expect(slotIds, name).not.toContain(name);
      expect(DISPATCHABLE_WORKFLOWS, name).not.toContain(`${name}.yml`); // restore-drill.yml is the manual Actions tool
    }
  });
  it("run the scripts they name, at the times the requirement gives", () => {
    expect(local["bucket-hourly"]!.steps.map((s) => s.run)).toEqual([
      "node scripts/backup/bucket-copy.mjs --hourly",
    ]);
    expect(local["bucket-hourly"]!.schedule).toEqual({
      from: "07:05",
      until: "23:05",
      everyMin: 60,
    });
    expect(local["turso-refresh"]!.steps.map((s) => s.run)).toEqual([
      "node scripts/selfhost/turso-refresh.mjs",
    ]);
    expect(local["turso-refresh"]!.standbyExitCodes).toEqual([3]);
    expect(local["restore-drill"]!.schedule.days).toEqual([0]);
    expect(local["restore-drill"]!.schedule.from).toBe("10:00");
    // refresh starts after the backup slot (23:00, 20 min limit) plus a margin
    expect(local["turso-refresh"]!.schedule.from > "23:20").toBe(true);
    for (const j of Object.values(local))
      for (const s of j.steps) {
        expect(
          readFileSync(path.join(ROOT, s.run.split(" ")[1]!), "utf8").length,
          s.run,
        ).toBeGreaterThan(0);
      }
  });
  it("the backup job ends with the local-only bucket copy and excludes the refresh", () => {
    const steps = manifest.jobs.backup!.steps;
    expect(steps.at(-1)).toMatchObject({
      run: "node scripts/backup/bucket-copy.mjs",
      localOnly: true,
    });
    expect(manifest.jobs.backup!.exclusiveWith).toEqual(["turso-refresh"]);
    expect(local["turso-refresh"]!.exclusiveWith).toEqual(["backup"]);
  });
});

describe("the exclusive and concurrency rules", () => {
  it("every job's group is the workflow's own concurrency group; arena-close and arena-signals exclude each other", () => {
    for (const [name, job] of Object.entries(manifest.jobs)) {
      const conc = workflows.get(job.workflow)!.jobs.production?.concurrency;
      expect(job.group, name).toBe(conc?.group);
    }
    expect(manifest.jobs["arena-close"]!.exclusiveWith).toEqual(["arena-signals"]);
    expect(manifest.jobs["arena-signals"]!.exclusiveWith).toEqual(["arena-close"]);
  });

  it("validateManifest refuses a one-sided exclusion, a passthrough job and a bad env source", () => {
    const base = JSON.parse(
      readFileSync(path.join(ROOT, "deploy", "selfhost", "jobs.json"), "utf8"),
    );
    const m1 = structuredClone(base);
    delete m1.jobs["arena-signals"].exclusiveWith;
    expect(() => validateManifest(m1)).toThrow(/mutual/);
    const m2 = structuredClone(base);
    m2.passthrough = ["maintenance.yml"];
    expect(() => validateManifest(m2)).toThrow(/passthrough/);
    const m3 = structuredClone(base);
    m3.jobs.maintenance.steps[0].env.BAD_NAME = "nonsense";
    expect(() => validateManifest(m3)).toThrow(/bad env source/);
  });
});

describe("the UTC cron table of the clock", () => {
  const hhmm = (cron: string): string => {
    const [m, h] = cron.split(" ");
    return `${h!.padStart(2, "0")}:${m!.padStart(2, "0")}`;
  };
  it("has the 8 Vercel crons of vercel.json, with the same path and time", () => {
    const vercel = JSON.parse(readFileSync(path.join(ROOT, "vercel.json"), "utf8")) as {
      crons: { path: string; schedule: string }[];
    };
    const want = vercel.crons.map((c) => `${hhmm(c.schedule)} ${c.path}`).sort();
    const have = UTC_CRONS.flatMap((c) =>
      c.source === "vercel" ? [`${c.at} ${c.path}`] : [],
    ).sort();
    expect(want).toHaveLength(8);
    expect(have).toEqual(want);
  });

  it("has the GitHub backstops of ingest-batch1.yml and watchdog.yml, with their gate times", () => {
    for (const [file, job, gate] of [
      ["ingest-batch1.yml", "ingest-batch1", ["18:15"]],
      ["watchdog.yml", "watchdog", ["20:40", "21:50"]],
    ] as const) {
      const lines = (workflows.get(file)!.on.schedule ?? []).map((s) => s.cron).sort();
      const mine = UTC_CRONS.flatMap((c) => (c.source === "github" && c.job === job ? [c] : []));
      expect(mine.map((c) => c.cron).sort(), file).toEqual(lines);
      for (const c of mine) expect(c.gateTimes, c.id).toEqual([...gate]);
      // the workflow's own gate step is given the same times
      const step = (workflows.get(file)!.jobs.gate?.steps ?? []).find((s) =>
        s.run?.includes("scheduleGate"),
      );
      expect(step?.run?.trim(), file).toBe(`node scripts/time/scheduleGate.mjs ${gate.join(" ")}`);
    }
    // no other runtime workflow has a schedule that the table forgot
    const scheduled = [...workflows]
      .filter(([f, w]) => w.on.schedule && !CI_ONLY.includes(f))
      .map(([f]) => f);
    expect(scheduled.sort()).toEqual(["ingest-batch1.yml", "watchdog.yml"]);
  });
});
