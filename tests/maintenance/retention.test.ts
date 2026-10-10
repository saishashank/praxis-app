// @vitest-environment node
// DAT-142, PLT-060, NFR-030, PLT-016, PLT-017, PLT-076 (nightly retention job)
import type { Client } from "@libsql/client";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendAudit, auditKey, verifyAuditChain } from "@/lib/db/audit";
import {
  concurrencyKeyFor,
  hashRevokedUsers,
  isValidDate,
  MAINTENANCE_JOB,
  pruneLogs,
  pruneNonces,
  runMaintenance,
} from "@/lib/maintenance/retention";
import { setConfig } from "@/lib/config/store";
import { finishRun, startRun } from "@/lib/runs/runRecord";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const PII = "4".repeat(64);
const NOW = new Date("2026-10-11T00:30:00.000Z");
const DATE = "2026-10-11";
const DAY = 86_400_000;
const ago = (days: number, extraMs = 0) =>
  new Date(NOW.getTime() - days * DAY - extraMs).toISOString();

let main: Client;
let auth: Client;
beforeEach(async () => {
  main = await freshDb("main");
  auth = await freshDb("auth");
});

const run = (over: Partial<Parameters<typeof runMaintenance>[0]> = {}, date = DATE) =>
  runMaintenance({ mainDb: main, authDb: auth, piiHashKey: PII, now: NOW, ...over }, date);

async function addRun(startedAt: string, status = "success", key = `k:${startedAt}`) {
  await main.execute({
    sql: "INSERT INTO run_record (job, concurrency_key, started_at, status) VALUES ('x', ?, ?, ?)",
    args: [key, startedAt, status],
  });
}
async function addLog(at: string) {
  await main.execute({
    sql: "INSERT INTO app_log (at, level, source, message) VALUES (?, 'info', 's', 'm')",
    args: [at],
  });
}
async function count(db: Client, table: string): Promise<number> {
  return Number((await db.execute(`SELECT COUNT(*) AS c FROM ${table}`)).rows[0].c);
}
async function addUser(p: {
  email: string;
  name?: string | null;
  status?: string;
  revokedAt?: string | null;
  role?: string;
}): Promise<number> {
  const r = await auth.execute({
    sql: `INSERT INTO app_user (email, name, role, status, created_at, updated_at, revoked_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      p.email,
      p.name ?? null,
      p.role ?? "viewer",
      p.status ?? "revoked",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      p.revokedAt === undefined ? null : p.revokedAt,
    ],
  });
  return Number(r.lastInsertRowid);
}
async function addAudit(
  userId: number,
  ip: string | null,
  ua: string | null,
  at = "2026-02-01T00:00:00.000Z",
) {
  await appendAudit(auth, auditKey(PII), {
    at,
    actorUserId: userId,
    action: "auth.signin",
    ip,
    userAgent: ua,
  });
}
const userRow = async (id: number) =>
  (await auth.execute({ sql: "SELECT * FROM app_user WHERE id = ?", args: [id] })).rows[0];
const h = (v: string) => createHmac("sha256", PII).update(v).digest("hex");

describe("isValidDate / concurrency key", () => {
  it("accepts real dates only", () => {
    expect(isValidDate("2026-10-11")).toBe(true);
    expect(isValidDate("2028-02-29")).toBe(true);
    for (const bad of [
      "2026-02-30",
      "2026-13-01",
      "2026-1-1",
      "26-10-11",
      "",
      20261011,
      null,
      "2026-10-11T00:00",
    ]) {
      expect(isValidDate(bad)).toBe(false);
    }
    expect(concurrencyKeyFor("2026-10-11")).toBe("maintenance:2026-10-11");
  });
});

describe("pruning boundaries (DAT-142, PLT-060)", () => {
  it("run records: exactly 180 days old is kept, one millisecond older goes", async () => {
    await addRun(ago(180), "failed");
    await addRun(ago(180, 1), "failed");
    await addRun(ago(1), "failed");
    const out = await run();
    expect(out.status).toBe("success");
    const left = (
      await main.execute("SELECT started_at FROM run_record WHERE job <> 'maintenance-nightly'")
    ).rows;
    expect(left.map((r) => String(r.started_at)).sort()).toEqual([ago(180), ago(1)].sort());
    if (out.status === "success") expect(out.counts.prunedRuns).toBe(1);
  });

  it("logs: exactly 30 days old is kept, one millisecond older goes", async () => {
    await addLog(ago(30));
    await addLog(ago(30, 1));
    await addLog(ago(0));
    const out = await run();
    expect(await count(main, "app_log")).toBe(2);
    if (out.status === "success") expect(out.counts.prunedLogs).toBe(1);
  });

  it("uses the stored retention config instead of the default", async () => {
    await setConfig(main, { key: "retention_logs_days", value: 5, userId: null, now: ago(0) });
    await setConfig(main, { key: "retention_runs_days", value: 10, userId: null, now: ago(0) });
    await addLog(ago(6));
    await addLog(ago(4));
    await addRun(ago(11), "failed");
    await addRun(ago(9), "failed");
    await run();
    expect(await count(main, "app_log")).toBe(1);
    expect(
      Number(
        (
          await main.execute(
            "SELECT COUNT(*) AS c FROM run_record WHERE job <> 'maintenance-nightly'",
          )
        ).rows[0].c,
      ),
    ).toBe(1);
  });

  it("an invalid stored value falls back to the default instead of deleting everything", async () => {
    await main.execute({
      sql: "INSERT INTO config_version (key, scope, value_json, changed_at) VALUES ('retention_logs_days','global','0',?)",
      args: [ago(0)],
    });
    await addLog(ago(10));
    await run();
    expect(await count(main, "app_log")).toBe(1);
  });

  it("expired nonces go, live ones stay (boundary: expires_at == now stays)", async () => {
    const nowSec = Math.floor(NOW.getTime() / 1000);
    for (const [n, e] of [
      ["a", nowSec - 1],
      ["b", nowSec],
      ["c", nowSec + 300],
    ] as const) {
      await main.execute({
        sql: "INSERT INTO request_nonce (nonce, expires_at) VALUES (?, ?)",
        args: [n, e],
      });
    }
    expect(await pruneNonces(main, nowSec)).toBe(1);
    expect(await count(main, "request_nonce")).toBe(2);
  });

  it("pruneLogs returns the deleted count", async () => {
    await addLog(ago(40));
    await addLog(ago(41));
    expect(await pruneLogs(main, NOW.toISOString(), 30)).toBe(2);
  });

  it("the current run record is never pruned, even with a 1-day retention", async () => {
    await setConfig(main, { key: "retention_runs_days", value: 1, userId: null, now: ago(0) });
    await run();
    expect(await count(main, "run_record")).toBe(1);
  });
});

describe("run record and concurrency (PLT-017, PLT-076)", () => {
  it("writes a success record with counts, key and scheduled date", async () => {
    await addLog(ago(31));
    const out = await run();
    expect(out).toEqual({
      status: "success",
      counts: { prunedRuns: 0, prunedLogs: 1, prunedNonces: 0, hashedUsers: 0 },
    });
    const r = (
      await main.execute({ sql: "SELECT * FROM run_record WHERE job = ?", args: [MAINTENANCE_JOB] })
    ).rows[0];
    expect(r.status).toBe("success");
    expect(r.concurrency_key).toBe("maintenance:2026-10-11");
    expect(r.scheduled_for).toBe(DATE);
    expect(r.items_processed).toBe(1);
    expect(Number(r.rows_written)).toBe(1);
    expect(Number(r.rows_read)).toBe(2);
    expect(JSON.parse(String(r.details_json))).toEqual({
      prunedRuns: 0,
      prunedLogs: 1,
      prunedNonces: 0,
      hashedUsers: 0,
    });
    expect(r.error_summary).toBeNull();
  });

  it("skips (no new record) when a success exists for the date; other dates still run", async () => {
    expect((await run()).status).toBe("success");
    expect(await run()).toEqual({ status: "skipped" });
    expect(await count(main, "run_record")).toBe(1);
    expect((await run({}, "2026-10-12")).status).toBe("success");
    expect(await count(main, "run_record")).toBe(2);
  });

  it("a failed or running record for the date does not block a retry", async () => {
    const id = await startRun(main, {
      job: MAINTENANCE_JOB,
      concurrencyKey: concurrencyKeyFor(DATE),
    });
    await finishRun(main, id, { status: "failed" });
    await startRun(main, { job: MAINTENANCE_JOB, concurrencyKey: concurrencyKeyFor(DATE) });
    expect((await run()).status).toBe("success");
  });
});

describe("NFR-030 PII hashing", () => {
  it("hashes only users revoked more than 90 days ago and not yet hashed", async () => {
    const old = await addUser({ email: "Old@Example.test", name: "Old Name", revokedAt: ago(91) });
    const exact = await addUser({ email: "exact@example.test", name: "E", revokedAt: ago(90) });
    const recent = await addUser({ email: "recent@example.test", name: "R", revokedAt: ago(89) });
    const active = await addUser({ email: "active@example.test", name: "A", status: "active" });
    const noDate = await addUser({ email: "nodate@example.test", name: "N", revokedAt: null });
    const done = await addUser({ email: "hashed:abc", name: "zzz", revokedAt: ago(200) });
    await auth.execute({
      sql: "UPDATE app_user SET pii_hashed_at = ? WHERE id = ?",
      args: [ago(100), done],
    });

    const out = await run();
    expect(out.status).toBe("success");
    if (out.status === "success") expect(out.counts.hashedUsers).toBe(1);

    const o = await userRow(old);
    expect(o.email).toBe(`hashed:${h("old@example.test")}`);
    expect(o.name).toBe(h("Old Name"));
    expect(o.pii_hashed_at).toBe(NOW.toISOString());
    expect(o.status).toBe("revoked");
    for (const [id, email] of [
      [exact, "exact@example.test"],
      [recent, "recent@example.test"],
      [active, "active@example.test"],
      [noDate, "nodate@example.test"],
    ] as const) {
      const r = await userRow(id);
      expect(r.email).toBe(email);
      expect(r.pii_hashed_at).toBeNull();
    }
    expect((await userRow(done)).email).toBe("hashed:abc");
    expect((await userRow(done)).name).toBe("zzz");
    // Plain, unsalted hashes are never used (NFR-030): the key matters.
    expect(o.email).not.toBe(
      `hashed:${createHmac("sha256", "other-key").update("old@example.test").digest("hex")}`,
    );
  });

  it("a null name stays null; the email stays UNIQUE (two users, two hashes)", async () => {
    const a = await addUser({ email: "a@example.test", name: null, revokedAt: ago(100) });
    const b = await addUser({ email: "b@example.test", name: null, revokedAt: ago(100) });
    await run();
    const ra = await userRow(a);
    const rb = await userRow(b);
    expect(ra.name).toBeNull();
    expect(ra.email).not.toBe(rb.email);
  });

  it("produces the known-answer HMAC values from the shared audit helpers", async () => {
    const id = await addUser({
      email: "Same@Example.test",
      name: "Same Name",
      revokedAt: ago(100),
    });
    await run();
    const u = await userRow(id);
    expect(u.email).toBe("hashed:9a8a2036a7b1722ea964b1d8fe1cf5f57f8e780805044f2a79e7a799ddc02f1f");
    expect(u.name).toBe("b16448134f02a267ea09c9e41a21b1cccbf351a32692408e40ef5c575383fba1");
    expect(u.pii_hashed_at).toBe(NOW.toISOString());
    expect(u.updated_at).toBe(NOW.toISOString());
  });

  it("nulls ip/user_agent on that user's audit rows only, keeps rows, chain still verifies", async () => {
    const victim = await addUser({ email: "v@example.test", name: "V", revokedAt: ago(100) });
    const other = await addUser({ email: "o@example.test", name: "O", status: "active" });
    await addAudit(victim, "1.1.1.1", "UA-1");
    await addAudit(other, "2.2.2.2", "UA-2");
    await addAudit(victim, "3.3.3.3", null);
    const before = await count(auth, "audit_event");
    expect(await verifyAuditChain(auth, auditKey(PII))).toBeNull();

    await run();

    const rows = (
      await auth.execute(
        "SELECT actor_user_id, ip, user_agent, action FROM audit_event ORDER BY id",
      )
    ).rows;
    expect(rows).toHaveLength(before + 1);
    for (const r of rows.filter((x) => Number(x.actor_user_id) === victim)) {
      expect(r.ip).toBeNull();
      expect(r.user_agent).toBeNull();
    }
    const kept = rows.find((x) => Number(x.actor_user_id) === other);
    expect(kept?.ip).toBe("2.2.2.2");
    expect(kept?.user_agent).toBe("UA-2");
    expect(await verifyAuditChain(auth, auditKey(PII))).toBeNull();
  });

  it("appends one user.pii_hashed audit event with the user id and no personal data", async () => {
    const id = await addUser({
      email: "secret-person@example.test",
      name: "Secret Person",
      revokedAt: ago(100),
    });
    await addAudit(id, "9.9.9.9", "UA");
    await run();
    const ev = (await auth.execute("SELECT * FROM audit_event WHERE action = 'user.pii_hashed'"))
      .rows;
    expect(ev).toHaveLength(1);
    expect(ev[0].target_type).toBe("app_user");
    expect(ev[0].target_id).toBe(String(id));
    expect(ev[0].actor_user_id).toBeNull();
    expect(JSON.parse(String(ev[0].detail_json))).toEqual({ auditRowsNulled: 1 });
    const text = JSON.stringify(ev[0]);
    expect(text).not.toContain("secret-person");
    expect(text).not.toContain("Secret Person");
    expect(text).not.toContain("9.9.9.9");
  });

  it("is idempotent: a second run (new date) hashes nothing and adds no audit rows", async () => {
    await addUser({ email: "x@example.test", name: "X", revokedAt: ago(100) });
    await run();
    const snapshot = JSON.stringify(
      (await auth.execute("SELECT * FROM app_user ORDER BY id")).rows,
    );
    const audits = await count(auth, "audit_event");
    const second = await run({}, "2026-10-12");
    expect(second.status).toBe("success");
    if (second.status === "success") expect(second.counts.hashedUsers).toBe(0);
    expect(JSON.stringify((await auth.execute("SELECT * FROM app_user ORDER BY id")).rows)).toBe(
      snapshot,
    );
    expect(await count(auth, "audit_event")).toBe(audits);
  });

  it("rolls back that user entirely when the audit append fails; other users still proceed", async () => {
    const bad = await addUser({ email: "bad@example.test", name: "Bad", revokedAt: ago(100) });
    const good = await addUser({ email: "good@example.test", name: "Good", revokedAt: ago(100) });
    await addAudit(bad, "5.5.5.5", "UA-bad");
    await addAudit(good, "6.6.6.6", "UA-good");
    // Fails only for the "bad" user's event.
    await auth.execute(
      `CREATE TRIGGER fail_bad BEFORE INSERT ON audit_event
       WHEN NEW.action = 'user.pii_hashed' AND NEW.target_id = '${bad}'
       BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    );
    const out = await run();
    expect(out.status).toBe("failed");
    const b = await userRow(bad);
    expect(b.email).toBe("bad@example.test");
    expect(b.name).toBe("Bad");
    expect(b.pii_hashed_at).toBeNull();
    const badAudit = (
      await auth.execute({
        sql: "SELECT ip, user_agent FROM audit_event WHERE actor_user_id = ?",
        args: [bad],
      })
    ).rows[0];
    expect(badAudit.ip).toBe("5.5.5.5");
    expect(badAudit.user_agent).toBe("UA-bad");
    expect((await userRow(good)).pii_hashed_at).not.toBeNull();
    expect(await verifyAuditChain(auth, auditKey(PII))).toBeNull();

    const rec = (
      await main.execute({ sql: "SELECT * FROM run_record WHERE job = ?", args: [MAINTENANCE_JOB] })
    ).rows[0];
    expect(rec.status).toBe("failed");
    expect(rec.error_summary).toBe("failed steps: pii_hash(1)");
    expect(JSON.parse(String(rec.details_json)).hashedUsers).toBe(1);
  });

  it("a user re-invited after the candidate query is left alone (in-transaction re-check)", async () => {
    const id = await addUser({ email: "back@example.test", name: "Back", revokedAt: ago(100) });
    // Simulate the race: the user row changes between the candidate query and the transaction.
    const real = auth.transaction.bind(auth);
    (auth as unknown as { transaction: typeof auth.transaction }).transaction = (async (
      mode: "write",
    ) => {
      await auth.execute({
        sql: "UPDATE app_user SET status = 'invited', revoked_at = NULL WHERE id = ?",
        args: [id],
      });
      return real(mode);
    }) as typeof auth.transaction;
    const r = await hashRevokedUsers(auth, PII, NOW.toISOString(), 90);
    expect(r).toEqual({ hashed: 0, failed: 0, rowsWritten: 0 });
    expect((await userRow(id)).email).toBe("back@example.test");
  });

  it("rejects a malformed PII_HASH_KEY without touching any user", async () => {
    const id = await addUser({ email: "k@example.test", name: "K", revokedAt: ago(100) });
    for (const piiHashKey of [undefined, "", "short", "G".repeat(64)]) {
      const out = await run(
        { piiHashKey },
        `2026-11-0${piiHashKey === undefined ? 1 : piiHashKey === "" ? 2 : piiHashKey === "short" ? 3 : 4}`,
      );
      expect(out.status).toBe("failed");
    }
    expect((await userRow(id)).email).toBe("k@example.test");
  });
});

describe("failure path (PLT-017)", () => {
  it("records a failed run with a safe summary naming steps only, and other steps still run", async () => {
    await addLog(ago(40));
    await main.execute("DROP TABLE request_nonce");
    const out = await run();
    expect(out.status).toBe("failed");
    if (out.status === "failed") expect(out.counts.prunedLogs).toBe(1);
    const rec = (
      await main.execute({ sql: "SELECT * FROM run_record WHERE job = ?", args: [MAINTENANCE_JOB] })
    ).rows[0];
    expect(rec.status).toBe("failed");
    expect(rec.error_summary).toBe("failed steps: prune_nonces");
    expect(String(rec.error_summary)).not.toMatch(/no such table|request_nonce|SQL/i);
    expect(JSON.parse(String(rec.details_json))).toEqual({
      prunedRuns: 0,
      prunedLogs: 1,
      prunedNonces: 0,
      hashedUsers: 0,
      failedSteps: ["prune_nonces"],
    });
    // A failed run does not block the retry for the same date.
    await main.execute(
      "CREATE TABLE request_nonce (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)",
    );
    expect((await run()).status).toBe("success");
  });

  it("names each failing prune step", async () => {
    await main.execute("DROP TABLE app_log");
    const out = await run();
    expect(out.status).toBe("failed");
    const rec = (
      await main.execute({
        sql: "SELECT error_summary FROM run_record WHERE job = ?",
        args: [MAINTENANCE_JOB],
      })
    ).rows[0];
    expect(rec.error_summary).toBe("failed steps: prune_logs");
  });

  it("a prune_runs failure is named too", async () => {
    // pruneRuns deletes from run_record; a trigger makes only that delete fail.
    await addRun(ago(400), "failed");
    await main.execute(
      "CREATE TRIGGER no_del BEFORE DELETE ON run_record BEGIN SELECT RAISE(ABORT, 'x'); END",
    );
    const out = await run();
    expect(out.status).toBe("failed");
    const rec = (
      await main.execute({
        sql: "SELECT error_summary FROM run_record WHERE job = ?",
        args: [MAINTENANCE_JOB],
      })
    ).rows[0];
    expect(rec.error_summary).toBe("failed steps: prune_runs");
  });

  it("an auth database failure is recorded as pii_hash", async () => {
    await auth.execute("DROP TABLE audit_event");
    await auth.execute("DROP TABLE app_user");
    const out = await run();
    expect(out.status).toBe("failed");
    const rec = (
      await main.execute({
        sql: "SELECT error_summary FROM run_record WHERE job = ?",
        args: [MAINTENANCE_JOB],
      })
    ).rows[0];
    expect(rec.error_summary).toBe("failed steps: pii_hash");
  });

  it("when the success record cannot be written (concurrent run), this run ends as failed", async () => {
    // A concurrent run holds the success for the key after our hasSuccess check.
    const realExecute = main.execute.bind(main);
    let injected = false;
    (main as unknown as { execute: typeof main.execute }).execute = (async (stmt: never) => {
      const sql = typeof stmt === "string" ? stmt : (stmt as { sql: string }).sql;
      if (!injected && sql.startsWith("UPDATE run_record SET status")) {
        injected = true;
        await realExecute({
          sql: "INSERT INTO run_record (job, concurrency_key, started_at, status) VALUES ('other', ?, ?, 'success')",
          args: [concurrencyKeyFor(DATE), NOW.toISOString()],
        });
      }
      return realExecute(stmt);
    }) as typeof main.execute;
    const out = await run();
    expect(out.status).toBe("failed");
    const rec = (
      await main.execute({
        sql: "SELECT status, error_summary FROM run_record WHERE job = ?",
        args: [MAINTENANCE_JOB],
      })
    ).rows[0];
    expect(rec.status).toBe("failed");
    expect(rec.error_summary).toBe("failed steps: finish");
  });
});
