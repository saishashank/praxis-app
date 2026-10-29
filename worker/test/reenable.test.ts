// M8 T8 (PLT-015, TST-112a): the daily check that re-enables scheduled workflows GitHub disabled after
// 60 days without repository activity, and the in-app notice. GitHub is a fake that models the 60-day
// rule; no real GitHub or Cloudflare API is called.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import arenaYml from "../../.github/workflows/arena-close.yml?raw";
import backupYml from "../../.github/workflows/backup.yml?raw";
import bakeoffYml from "../../.github/workflows/llm-bakeoff.yml?raw";
import maintenanceYml from "../../.github/workflows/maintenance.yml?raw";
import watchdogYml from "../../.github/workflows/watchdog.yml?raw";
import {
  githubWorkflowClient,
  hasScheduleTrigger,
  isReenableTick,
  reenableKey,
  runReenable,
  type ReenableEnv,
  type WorkflowClient,
  type WorkflowInfo,
} from "../src/reenable";
import { TOKEN, TURSO_TOKEN, TURSO_URL, makeDb, makeNet, rows } from "./fakeTurso";

const DAY = 86_400_000;
const ENV: ReenableEnv = {
  PRAXIS_ENV: "production",
  GITHUB_DISPATCH_TOKEN: TOKEN,
  TURSO_MAIN_URL: TURSO_URL,
  TURSO_MAIN_TOKEN: TURSO_TOKEN,
};
const utc = (date: string, hm: string) => {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, m] = hm.split(":").map(Number);
  return Date.UTC(y, mo - 1, d, h, m);
};
const T0 = utc("2026-10-21", "02:40");

const SCHEDULED_YAML = `name: Backup trigger
on:
  schedule:
    - cron: "5 13 * * *"
  workflow_dispatch:
jobs: {}
`;

/** GitHub as it behaves: a workflow with no repository activity for 60 days is disabled_inactivity. */
class FakeGithub implements WorkflowClient {
  files = new Map<string, string>();
  state = new Map<number, WorkflowInfo>();
  lastActivityMs = 0;
  calls: string[] = [];
  failList = false;
  failEnableFor = new Set<number>();
  add(id: number, path: string, yaml: string, state = "active") {
    this.files.set(path, yaml);
    this.state.set(id, { id, path, state });
  }
  /** GitHub's rule: only workflows with a schedule trigger are disabled after 60 idle days. */
  advanceTo(nowMs: number) {
    if (nowMs - this.lastActivityMs < 60 * DAY) return;
    for (const w of this.state.values()) {
      if (w.state === "active" && hasScheduleTrigger(this.files.get(w.path) ?? "")) {
        w.state = "disabled_inactivity";
      }
    }
  }
  async list() {
    this.calls.push("list");
    if (this.failList) throw Object.assign(new Error("secret " + TOKEN), { name: "Http500" });
    return [...this.state.values()].map((w) => ({ ...w }));
  }
  async hasSchedule(path: string) {
    this.calls.push(`file:${path}`);
    return hasScheduleTrigger(this.files.get(path) ?? "");
  }
  async enable(id: number) {
    this.calls.push(`enable:${id}`);
    if (this.failEnableFor.has(id)) throw Object.assign(new Error("nope"), { name: "Http403" });
    this.state.get(id)!.state = "active";
  }
}

let db: ReturnType<typeof makeDb>;
let net: ReturnType<typeof makeNet>;
let gh: FakeGithub;
let logs: string[];
const run = (t: number, env: ReenableEnv = ENV) =>
  runReenable(env, t, { fetch: net.f, nowMs: () => t, client: gh });

beforeEach(() => {
  db = makeDb();
  net = makeNet(db);
  gh = new FakeGithub();
  gh.lastActivityMs = T0 - 61 * DAY; // 61 days of inactivity
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.join(" "));
  });
});
afterEach(() => vi.restoreAllMocks());

describe("hasScheduleTrigger", () => {
  it("true only for a real `schedule:` key under `on:`", () => {
    expect(hasScheduleTrigger(SCHEDULED_YAML)).toBe(true);
    expect(hasScheduleTrigger("on:\r\n  schedule:\r\n    - cron: '1 1 * * *'\r\n")).toBe(true);
    expect(hasScheduleTrigger("on:\n  workflow_dispatch:\n")).toBe(false);
    // comments that mention it do not count (every Worker-dispatched workflow's header does)
    expect(hasScheduleTrigger("# It has no `schedule:` trigger\non:\n  workflow_dispatch:\n")).toBe(
      false,
    );
    // a `schedule:` that is not a trigger key
    expect(hasScheduleTrigger("on:\n  workflow_dispatch:\nenv:\n  schedule:\n")).toBe(false);
    expect(
      hasScheduleTrigger(
        "on:\n  workflow_dispatch:\njobs:\n  a:\n    steps:\n      - run: echo schedule:\n",
      ),
    ).toBe(false);
  });
  it("the shipped workflows are dispatch-only, except the watchdog's own schedule (GL-07)", () => {
    for (const y of [arenaYml, backupYml, bakeoffYml, maintenanceYml]) {
      expect(hasScheduleTrigger(y)).toBe(false);
    }
    expect(hasScheduleTrigger(watchdogYml)).toBe(true);
  });
});

describe("isReenableTick", () => {
  it("five UTC ticks a day, 02:40..02:44", () => {
    expect(isReenableTick(utc("2026-10-21", "02:39"))).toBe(false);
    for (const m of ["02:40", "02:41", "02:42", "02:43", "02:44"]) {
      expect(isReenableTick(utc("2026-10-21", m)), m).toBe(true);
    }
    expect(isReenableTick(utc("2026-10-21", "02:45"))).toBe(false);
    expect(isReenableTick(utc("2026-10-21", "14:40"))).toBe(false);
  });
});

describe("TST-112a: 60 days of inactivity, re-enable, notice", () => {
  it("re-enables a scheduled workflow GitHub disabled and raises an in-app notice", async () => {
    gh.add(11, ".github/workflows/backup-trigger.yml", SCHEDULED_YAML);
    gh.add(12, ".github/workflows/maintenance.yml", maintenanceYml);
    // day 0: nothing disabled
    gh.advanceTo(T0 - 30 * DAY);
    expect(gh.state.get(11)!.state).toBe("active");
    // 60+ days without activity: GitHub disables the scheduled workflow only
    gh.advanceTo(T0);
    expect(gh.state.get(11)!.state).toBe("disabled_inactivity");
    expect(gh.state.get(12)!.state).toBe("active");

    const s = await run(T0);
    expect(s.reenabled).toEqual([".github/workflows/backup-trigger.yml"]);
    expect(s.failed).toEqual([]);
    expect(gh.state.get(11)!.state).toBe("active"); // re-enabled automatically

    // the in-app notice: an open S3 incident (in-app only), with short facts
    const inc = rows(db, "SELECT severity, kind, detail_json, resolved_at FROM incident");
    expect(inc).toHaveLength(1);
    expect(inc[0]).toMatchObject({ severity: "S3", kind: "workflow_reenabled", resolved_at: null });
    const detail = JSON.parse(String(inc[0]!.detail_json));
    expect(detail.workflow).toBe(".github/workflows/backup-trigger.yml");
    expect(detail.summary).toContain("re-enabled");
    expect(JSON.stringify(detail)).not.toContain(TOKEN);

    // the run record and the day's claim
    const rr = rows(
      db,
      "SELECT status, items_processed FROM run_record WHERE job = 'worker-reenable'",
    );
    expect(rr).toEqual([{ status: "success", items_processed: 1 }]);
    const claim = rows(
      db,
      "SELECT value_json FROM worker_state WHERE key = ?",
      reenableKey("2026-10-21"),
    );
    expect(JSON.parse(String(claim[0]!.value_json)).s).toBe("dispatched");
  });

  it("one notice per workflow, each time it happens", async () => {
    gh.add(11, ".github/workflows/backup-trigger.yml", SCHEDULED_YAML);
    gh.add(13, ".github/workflows/watchdog-trigger.yml", SCHEDULED_YAML);
    gh.advanceTo(T0);
    await run(T0);
    expect(rows(db, "SELECT id FROM incident")).toHaveLength(2);
    // 61 more idle days: disabled again, re-enabled again, new notices
    gh.lastActivityMs = T0;
    gh.advanceTo(T0 + 62 * DAY);
    expect(gh.state.get(11)!.state).toBe("disabled_inactivity");
    await run(T0 + 62 * DAY);
    expect(rows(db, "SELECT id FROM incident")).toHaveLength(4);
    expect(gh.state.get(11)!.state).toBe("active");
  });

  it("dispatch-only workflows are left alone, even if one shows as disabled", async () => {
    gh.add(12, ".github/workflows/maintenance.yml", maintenanceYml, "disabled_inactivity");
    gh.add(14, ".github/workflows/old.yml", SCHEDULED_YAML, "disabled_manually");
    gh.add(15, ".github/workflows/ok.yml", SCHEDULED_YAML, "active");
    const s = await run(T0);
    expect(s.reenabled).toEqual([]);
    expect(s.untouched).toEqual([".github/workflows/maintenance.yml"]);
    expect(gh.calls.filter((c) => c.startsWith("enable"))).toEqual([]);
    expect(gh.state.get(12)!.state).toBe("disabled_inactivity");
    expect(gh.state.get(14)!.state).toBe("disabled_manually"); // the Owner's choice
    expect(rows(db, "SELECT id FROM incident")).toEqual([]);
    expect(rows(db, "SELECT status FROM run_record WHERE job = 'worker-reenable'")).toEqual([
      { status: "success" },
    ]);
  });

  it("nothing disabled: a run record and no notice", async () => {
    gh.add(11, ".github/workflows/backup-trigger.yml", SCHEDULED_YAML);
    const s = await run(T0);
    expect(s.checked).toBe(true);
    expect(s.reenabled).toEqual([]);
    expect(rows(db, "SELECT id FROM incident")).toEqual([]);
  });

  it("runs once a day: later ticks of the window and racing isolates do nothing more", async () => {
    gh.add(11, ".github/workflows/backup-trigger.yml", SCHEDULED_YAML);
    gh.advanceTo(T0);
    net.interleave = true;
    await Promise.all([run(T0), run(T0)]);
    expect(gh.calls.filter((c) => c === "enable:11")).toHaveLength(1);
    expect(rows(db, "SELECT id FROM incident")).toHaveLength(1);
    gh.calls.length = 0;
    for (const m of ["02:41", "02:42", "02:43", "02:44"]) await run(utc("2026-10-21", m));
    expect(gh.calls).toEqual([]);
    // the next day it runs again
    await run(utc("2026-10-22", "02:40"));
    expect(gh.calls).toContain("list");
  });

  it("every other minute: no work at all (no request, no GitHub call, no log)", async () => {
    gh.add(11, ".github/workflows/backup-trigger.yml", SCHEDULED_YAML, "disabled_inactivity");
    for (const hm of ["00:00", "02:15", "02:39", "02:45", "12:40"]) {
      await run(utc("2026-10-21", hm));
    }
    expect(net.pipelines).toBe(0);
    expect(gh.calls).toEqual([]);
    expect(logs).toEqual([]);
  });

  it("a GitHub list error is recorded as a failed run and retried on the next tick, 3 tries in all", async () => {
    gh.add(11, ".github/workflows/backup-trigger.yml", SCHEDULED_YAML, "disabled_inactivity");
    gh.failList = true;
    await run(utc("2026-10-21", "02:40"));
    await run(utc("2026-10-21", "02:41"));
    await run(utc("2026-10-21", "02:42"));
    await run(utc("2026-10-21", "02:43")); // 4th: over the cap
    expect(gh.calls.filter((c) => c === "list")).toHaveLength(3);
    expect(rows(db, "SELECT status FROM run_record WHERE job = 'worker-reenable'")).toEqual([
      { status: "failed" },
      { status: "failed" },
      { status: "failed" },
    ]);
    expect(logs.join("\n")).not.toContain(TOKEN);
    // recovery: a later try succeeds (new day)
    gh.failList = false;
    await run(utc("2026-10-22", "02:40"));
    expect(gh.state.get(11)!.state).toBe("active");
  });

  it("a failed enable is recorded, the others still go ahead, and the retry only touches what is still disabled", async () => {
    gh.add(11, ".github/workflows/a.yml", SCHEDULED_YAML, "disabled_inactivity");
    gh.add(13, ".github/workflows/b.yml", SCHEDULED_YAML, "disabled_inactivity");
    gh.failEnableFor.add(11);
    const s = await run(utc("2026-10-21", "02:40"));
    expect(s.failed).toEqual([".github/workflows/a.yml"]);
    expect(s.reenabled).toEqual([".github/workflows/b.yml"]);
    expect(rows(db, "SELECT status FROM run_record WHERE job = 'worker-reenable'")).toEqual([
      { status: "failed" },
    ]);
    gh.failEnableFor.clear();
    gh.calls.length = 0;
    await run(utc("2026-10-21", "02:41"));
    expect(gh.calls.filter((c) => c.startsWith("enable"))).toEqual(["enable:11"]);
    expect(gh.state.get(11)!.state).toBe("active");
  });

  it("without the token, a database or a known environment: nothing", async () => {
    gh.add(11, ".github/workflows/a.yml", SCHEDULED_YAML, "disabled_inactivity");
    await run(T0, { ...ENV, GITHUB_DISPATCH_TOKEN: "" });
    await run(T0, { ...ENV, TURSO_MAIN_URL: undefined });
    await run(T0, { ...ENV, PRAXIS_ENV: "preview" });
    expect(gh.calls).toEqual([]);
    expect(net.pipelines).toBe(0);
  });

  it("at most 10 workflows are handled per run (subrequest budget)", async () => {
    for (let i = 0; i < 14; i++) {
      gh.add(100 + i, `.github/workflows/w${i}.yml`, SCHEDULED_YAML, "disabled_inactivity");
    }
    const s = await run(T0);
    expect(s.reenabled).toHaveLength(10);
  });
});

describe("the real GitHub client (fetch faked)", () => {
  it("lists, reads a file and enables with the token in one header and nothing else", async () => {
    const seen: { url: string; method: string; auth: string }[] = [];
    const f = (async (i: string | URL | Request, init?: RequestInit) => {
      const url = String(i);
      seen.push({
        url,
        method: init?.method ?? "GET",
        auth: String((init?.headers as Record<string, string>).Authorization),
      });
      if (url.includes("/actions/workflows?")) {
        return Response.json({
          total_count: 2,
          workflows: [
            { id: 7, path: ".github/workflows/x.yml", state: "disabled_inactivity", name: "X" },
            { id: "bad", path: 1, state: null },
          ],
        });
      }
      if (url.includes("/contents/")) return new Response(SCHEDULED_YAML, { status: 200 });
      if (url.endsWith("/actions/workflows/7/enable")) return new Response(null, { status: 204 });
      return new Response("no", { status: 404 });
    }) as typeof fetch;
    const c = githubWorkflowClient(ENV, f);
    expect(await c.list()).toEqual([
      { id: 7, path: ".github/workflows/x.yml", state: "disabled_inactivity" },
    ]);
    expect(await c.hasSchedule(".github/workflows/x.yml")).toBe(true);
    await c.enable(7);
    expect(seen.map((s) => s.method)).toEqual(["GET", "GET", "PUT"]);
    expect(
      seen.every((s) => s.url.startsWith("https://api.github.com/repos/saishashank/praxis-app/")),
    ).toBe(true);
    expect(seen.every((s) => s.auth === `Bearer ${TOKEN}`)).toBe(true);
    // odd paths never become URLs
    expect(await c.hasSchedule("../../etc/passwd")).toBe(false);
    expect(seen).toHaveLength(3);
    await expect(c.enable(-1)).rejects.toThrow();
  });

  it("an HTTP error becomes an error NAME without the token", async () => {
    const f = (async () => new Response("secret body", { status: 403 })) as typeof fetch;
    const c = githubWorkflowClient(ENV, f);
    const err = await c.list().catch((e: Error) => e);
    expect((err as Error).name).toBe("Http403");
    expect(String(err)).not.toContain(TOKEN);
  });

  it("runReenable with the default client end to end", async () => {
    const calls: string[] = [];
    const f = (async (i: string | URL | Request, init?: RequestInit) => {
      const url = String(i);
      if (url.endsWith("/v2/pipeline")) return net.f(i, init);
      calls.push(
        `${init?.method} ${url.replace("https://api.github.com/repos/saishashank/praxis-app", "")}`,
      );
      if (url.includes("/actions/workflows?")) {
        return Response.json({
          workflows: [
            { id: 5, path: ".github/workflows/backup-trigger.yml", state: "disabled_inactivity" },
          ],
        });
      }
      if (url.includes("/contents/")) return new Response(SCHEDULED_YAML, { status: 200 });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const s = await runReenable(ENV, T0, { fetch: f, nowMs: () => T0 });
    expect(s.reenabled).toEqual([".github/workflows/backup-trigger.yml"]);
    expect(calls).toEqual([
      "GET /actions/workflows?per_page=100",
      "GET /contents/.github/workflows/backup-trigger.yml",
      "PUT /actions/workflows/5/enable",
    ]);
  });
});
