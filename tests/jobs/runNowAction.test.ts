// @vitest-environment node
// TST-122 for requestRunNowAction (D-840..D-849). The Owner asks for a scheduled job to run now. Covered:
// the guard runs FIRST and a refusal changes nothing, only the Owner (also at the service), the job must
// be a runnable registry job, per-job parameters, confirm, the audit event is written BEFORE the request
// (a failing insert leaves the audit row and a `_failed` row), one waiting request per job, the hourly
// limit, the append-only effect, revalidation, and the Ops page read model.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addUser, auditRows, KEY } from "../auth/helpers";
import { cleanupTempDbs, freshDb } from "../db/helpers";

const requireUser = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());
const mem = vi.hoisted(() => ({ main: null as unknown, auth: null as unknown }));
vi.mock("@/lib/auth/guard", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-real-ip": "9.9.9.9", "user-agent": "agent" }),
}));
vi.mock("@/lib/db/client", () => ({ mainDb: () => mem.main, authDb: () => mem.auth }));

import { requestRunNowAction } from "@/app/(app)/ops/actions";
import {
  loadRunNowRows,
  requestRunNow,
  requesterTag,
  RUN_NOW_MAX_PER_HOUR,
  RUN_NOW_MAX_PER_JOB_HOUR,
} from "@/lib/jobs/runNow";
import { RUNNABLE_JOBS } from "@/lib/jobs/registry.mjs";

afterEach(() => {
  cleanupTempDbs();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

let main: Client;
let auth: Client;
let ownerId: number;
let editorId: number;

const asUser = (id: number, role: string) =>
  requireUser.mockResolvedValue({ id, email: `${role}@example.test`, name: null, role });
const form = (o: Record<string, string | undefined>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) if (v !== undefined) fd.set(k, v);
  return fd;
};
// Mon 2 Nov 2026 12:00 Melbourne (AEDT)
const NOW = new Date("2026-11-02T01:00:00.000Z");
const OK = { job: "evening-review", confirm: "true" };
const requests = async () =>
  (await main.execute("SELECT * FROM run_now_request ORDER BY id")).rows.map((r) => ({ ...r }));

beforeEach(async () => {
  vi.stubEnv("PII_HASH_KEY", KEY);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  requireUser.mockReset();
  revalidatePath.mockReset();
  main = await freshDb("main");
  auth = await freshDb("auth");
  mem.main = main;
  mem.auth = auth;
  ownerId = await addUser(auth, { email: "owner@example.test", role: "owner" });
  editorId = await addUser(auth, { email: "editor@example.test", role: "editor" });
  asUser(ownerId, "owner");
});

describe("guard first", () => {
  it("asks for the admin (Owner) action before anything else, on the Ops path", async () => {
    await requestRunNowAction(form(OK));
    expect(requireUser).toHaveBeenCalledWith("admin", "/ops");
  });

  it("a non-Owner is refused by the guard: nothing is written, no audit event, no revalidation", async () => {
    requireUser.mockRejectedValue(new Error("NEXT_HTTP_ERROR_FALLBACK;403"));
    await expect(requestRunNowAction(form(OK))).rejects.toThrow(/403/);
    expect(await requests()).toEqual([]);
    expect(await auditRows(auth)).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("an anonymous visitor is redirected before any read", async () => {
    requireUser.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(requestRunNowAction(form(OK))).rejects.toThrow(/REDIRECT/);
    expect(await requests()).toEqual([]);
  });

  it("the service refuses a non-Owner even if a caller skipped the guard", async () => {
    const r = await requestRunNow({
      mainDb: main,
      authDb: auth,
      env: process.env,
      actorId: editorId,
      now: NOW,
      jobId: "backup",
      confirmed: true,
    });
    expect(r).toEqual({ ok: false, error: "forbidden" });
    expect(await requests()).toEqual([]);
    expect(await auditRows(auth)).toEqual([]);
  });
});

describe("the Owner asks for a run", () => {
  it("writes ONE pending request after its audit event, names the audit row, revalidates /ops", async () => {
    expect(await requestRunNowAction(form(OK))).toEqual({ ok: true });
    const rows = await requests();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      job_id: "evening-review",
      market: "AU",
      params_json: '{"d":"2026-11-02"}',
      status: "pending",
      result: null,
      requested_at: NOW.toISOString(),
    });
    expect(rows[0]!.requested_by_hmac).toBe(requesterTag(KEY, ownerId));
    const audits = await auditRows(auth);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "jobs.run_now_requested",
      actor_user_id: ownerId,
      target_type: "job",
      target_id: "evening-review",
      ip: "9.9.9.9",
    });
    expect(rows[0]!.audit_ref).toBe(`audit:${String(audits[0]!.id)}`);
    expect(revalidatePath).toHaveBeenCalledWith("/ops");
  });

  it("a dateless job takes no parameters, a dated job takes yesterday, never tomorrow", async () => {
    expect(await requestRunNowAction(form({ job: "backup", confirm: "true" }))).toEqual({
      ok: true,
    });
    expect(
      await requestRunNowAction(form({ job: "backup", confirm: "true", d: "2026-11-02" })),
    ).toEqual({ error: "invalid" });
    expect(await requestRunNowAction(form({ ...OK, d: "2026-11-01" }))).toEqual({ ok: true });
    expect((await requests()).map((r) => r.params_json)).toEqual(["{}", '{"d":"2026-11-01"}']);
    const late = { job: "evening-review-late", confirm: "true" };
    expect(await requestRunNowAction(form({ ...late, d: "2026-11-03" }))).toEqual({
      error: "invalid",
    });
    expect(await requestRunNowAction(form({ ...late, d: "2026-10-30" }))).toEqual({
      error: "invalid",
    });
  });

  it("uses the Melbourne date near midnight (13:30 UTC is already tomorrow in Melbourne)", async () => {
    vi.setSystemTime(new Date("2026-11-02T13:30:00.000Z"));
    expect(await requestRunNowAction(form(OK))).toEqual({ ok: true });
    expect((await requests())[0]!.params_json).toBe('{"d":"2026-11-03"}');
  });
});

describe("refusals change nothing and write no audit event", () => {
  const none = async () => {
    expect(await requests()).toEqual([]);
    expect(await auditRows(auth)).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
  };

  it("an unknown job, a Worker-internal job and a malformed id", async () => {
    for (const job of ["no-such-job", "asx-poll", "universe", "", "__proto__", "Backup"]) {
      expect(await requestRunNowAction(form({ job, confirm: "true" })), job).toEqual({
        error: "unknown_job",
      });
    }
    expect(await requestRunNowAction(form({ confirm: "true" }))).toEqual({
      error: "unknown_job",
    });
    await none();
  });

  it("no confirmation, or anything but 'true'", async () => {
    expect(await requestRunNowAction(form({ job: "backup" }))).toEqual({
      error: "confirm_required",
    });
    expect(await requestRunNowAction(form({ job: "backup", confirm: "yes" }))).toEqual({
      error: "confirm_required",
    });
    await none();
  });

  it("runnable registry jobs are accepted by the action", async () => {
    for (const j of RUNNABLE_JOBS.slice(0, 5)) {
      expect(await requestRunNowAction(form({ job: j.id, confirm: "true" })), j.id).toEqual({
        ok: true,
      });
    }
  });
});

describe("one waiting request per job and the hourly limit", () => {
  it("a second request for the same job is refused while the first waits", async () => {
    expect(await requestRunNowAction(form(OK))).toEqual({ ok: true });
    expect(await requestRunNowAction(form(OK))).toEqual({ error: "already_pending" });
    await main.execute("UPDATE run_now_request SET status = 'dispatched'");
    expect(await requestRunNowAction(form(OK))).toEqual({ error: "already_pending" });
    expect(await requests()).toHaveLength(1);
    // a different job is independent
    expect(await requestRunNowAction(form({ job: "backup", confirm: "true" }))).toEqual({
      ok: true,
    });
  });

  it("allows another once the first has finished, up to the per-job hourly limit", async () => {
    for (let i = 0; i < RUN_NOW_MAX_PER_JOB_HOUR; i++) {
      expect(await requestRunNowAction(form(OK)), String(i)).toEqual({ ok: true });
      await main.execute(
        "UPDATE run_now_request SET status = 'done', result = 'ran: HTTP 200' WHERE status = 'pending'",
      );
    }
    expect(await requestRunNowAction(form(OK))).toEqual({ error: "rate_limited" });
    // an hour later the count is clear
    vi.setSystemTime(new Date(NOW.getTime() + 61 * 60_000));
    expect(await requestRunNowAction(form(OK))).toEqual({ ok: true });
  });

  it("limits the total over all jobs in an hour", async () => {
    const stamp = NOW.toISOString();
    for (let i = 0; i < RUN_NOW_MAX_PER_HOUR; i++) {
      await main.execute({
        sql:
          "INSERT INTO run_now_request (job_id, market, params_json, requested_by_hmac, requested_at, " +
          "audit_ref, status, result, updated_at) VALUES (?, 'AU', '{}', ?, ?, 'audit:1', 'done', 'ran', ?)",
        args: [`job-${i}`, "a".repeat(64), stamp, stamp],
      });
    }
    expect(await requestRunNowAction(form({ job: "backup", confirm: "true" }))).toEqual({
      error: "rate_limited",
    });
  });

  it("the bake-off is capped at one manual request per hour; other jobs are not affected (D-851)", async () => {
    const BAKE = { job: "llm-bakeoff", confirm: "true" };
    expect(await requestRunNowAction(form(BAKE))).toEqual({ ok: true });
    await main.execute(
      "UPDATE run_now_request SET status = 'done', result = 'started: HTTP 204' WHERE status = 'pending'",
    );
    expect(await requestRunNowAction(form(BAKE))).toEqual({ error: "rate_limited" });
    expect(await requestRunNowAction(form(OK))).toEqual({ ok: true });
    vi.setSystemTime(new Date(NOW.getTime() + 61 * 60_000));
    expect(await requestRunNowAction(form(BAKE))).toEqual({ ok: true });
  });

  it("a waiting request older than an hour still blocks a second one (D-852)", async () => {
    expect(await requestRunNowAction(form(OK))).toEqual({ ok: true });
    vi.setSystemTime(new Date(NOW.getTime() + 2 * 60 * 60_000));
    expect(await requestRunNowAction(form(OK))).toEqual({ error: "already_pending" });
    expect((await requests()).length).toBe(1);
  });

  it("two requests racing for the same job write one row (the check is repeated in the transaction)", async () => {
    const run = () =>
      requestRunNow({
        mainDb: main,
        authDb: auth,
        env: process.env,
        actorId: ownerId,
        now: NOW,
        jobId: "backup",
        confirmed: true,
      });
    const out = await Promise.all([run(), run()]);
    expect(out.filter((r) => r.ok)).toHaveLength(1);
    expect(await requests()).toHaveLength(1);
  });
});

describe("failure handling", () => {
  it("a failing insert leaves the audit row and a _failed row, and no request", async () => {
    await main.execute("DROP TRIGGER run_now_request_forward");
    await main.execute("DROP TRIGGER run_now_request_no_delete");
    await main.execute("DROP TABLE run_now_request");
    await main.execute(
      "CREATE TABLE run_now_request (id INTEGER PRIMARY KEY, job_id TEXT CHECK (job_id = 'never'), market TEXT, " +
        "params_json TEXT, requested_by_hmac TEXT, requested_at TEXT, audit_ref TEXT, status TEXT, result TEXT, updated_at TEXT)",
    );
    const r = await requestRunNowAction(form(OK));
    expect(r).toEqual({ error: "unavailable" });
    expect((await auditRows(auth)).map((a) => a.action)).toEqual([
      "jobs.run_now_requested",
      "jobs.run_now_requested_failed",
    ]);
    expect(await requests()).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("an unreadable database before the audit changes nothing", async () => {
    mem.main = { execute: () => Promise.reject(new Error("down")) };
    expect(await requestRunNowAction(form(OK))).toEqual({ error: "unavailable" });
    expect(await auditRows(auth)).toEqual([]);
  });

  it("no PII key means no audit and no request", async () => {
    vi.stubEnv("PII_HASH_KEY", "");
    expect(await requestRunNowAction(form(OK))).toEqual({ error: "unavailable" });
    expect(await requests()).toEqual([]);
  });
});

describe("the request table is append-only", () => {
  it("status moves forward only; the request never changes; recent rows cannot be deleted", async () => {
    await requestRunNowAction(form(OK));
    const run = (sql: string) => main.execute(sql);
    await run("UPDATE run_now_request SET status = 'dispatched'");
    await expect(run("UPDATE run_now_request SET status = 'pending'")).rejects.toThrow(/forward/);
    await expect(run("UPDATE run_now_request SET job_id = 'backup'")).rejects.toThrow(/forward/);
    await expect(run("UPDATE run_now_request SET params_json = '{}'")).rejects.toThrow(/forward/);
    await run("UPDATE run_now_request SET status = 'done', result = 'ran: HTTP 200'");
    await expect(run("UPDATE run_now_request SET status = 'refused'")).rejects.toThrow(/forward/);
    await expect(run("DELETE FROM run_now_request")).rejects.toThrow(/append-only/);
    await expect(run("UPDATE run_now_request SET status = 'bogus'")).rejects.toThrow();
  });

  it("a row older than the 90-day floor may be pruned", async () => {
    await main.execute({
      sql:
        "INSERT INTO run_now_request (job_id, market, params_json, requested_by_hmac, requested_at, " +
        "audit_ref, status, updated_at) VALUES ('backup', 'AU', '{}', ?, '2020-01-01T00:00:00.000Z', 'audit:1', 'done', '2020-01-01T00:00:00.000Z')",
      args: ["a".repeat(64)],
    });
    await main.execute("DELETE FROM run_now_request");
    expect(await requests()).toEqual([]);
  });
});

describe("the Ops page read model", () => {
  it("lists every runnable job with its newest request and its newest scheduled start", async () => {
    await requestRunNowAction(form(OK));
    await main.execute(
      "UPDATE run_now_request SET status = 'refused', result = 'refused: not listed'",
    );
    await main.execute({
      sql: "INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, ?, ?), (?, ?, ?)",
      args: [
        "slot:backup:2026-11-01",
        JSON.stringify({ s: "dispatched", n: 1, at: "x" }),
        "2026-11-01T12:00:00.000Z",
        "slot:backup:2026-10-31",
        JSON.stringify({ s: "failed", n: 3, at: "x" }),
        "2026-10-31T12:00:00.000Z",
      ],
    });
    const rows = await loadRunNowRows(main);
    expect(rows.map((r) => r.job.id)).toEqual(RUNNABLE_JOBS.map((j) => j.id));
    const ev = rows.find((r) => r.job.id === "evening-review")!;
    expect(ev.last).toMatchObject({ status: "refused", result: "refused: not listed" });
    const bk = rows.find((r) => r.job.id === "backup")!;
    expect(bk.last).toBeNull();
    expect(bk.scheduled).toEqual({
      state: "dispatched",
      at: "2026-11-01T12:00:00.000Z",
      d: "2026-11-01",
    });
  });
});
