// @vitest-environment node
// M5 T11 incident emails (docs/M5_design.md 4.8, NFR-006, EML-021; D-051, D-063, D-066, D-101,
// D-105): every wired writer emails exactly once per incident key, escalation once, tokens-due
// windows, the evening email-record check, `email_mode` off records without sending, the reserved
// incident slot, S3 and LLM-style kinds never email. Mock provider only; synthetic data.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBackupExportHandler } from "@/lib/backup/exportHandler";
import { emailKeys } from "@/lib/email/keys";
import { sendEmail } from "@/lib/email/send";
import { REVIEW_FULL } from "../fixtures/email/facts";
import { createMockProvider, type MockProvider } from "@/lib/email/mock";
import { createHeartbeatHandler } from "@/lib/heartbeat/handler";
import { openS2Once } from "@/lib/heartbeat/incidents";
import { openIncident } from "@/lib/alerts/incident";
import {
  detectAsxTrip,
  detectDispatchAuth,
  detectDataQualityTwoNights,
  detectReviewMissing,
} from "@/lib/incidents/detectors";
import { escalateIncidents } from "@/lib/incidents/escalate";
import { notifyIncident, type NotifyCtx } from "@/lib/incidents/notify";
import { dueTokens, sendTokensDue } from "@/lib/incidents/tokensDue";
import { openS1Once } from "@/lib/watchdog/incidents";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const T0 = new Date("2026-10-19T09:00:00.000Z"); // 20:00 Melbourne, 2026-10-19
const D = "2026-10-19";
const ENV: Record<string, string | undefined> = {
  EMAIL_PROVIDER: "mock",
  OWNER_EMAIL: "owner@example.test",
  APP_BASE_URL: "https://praxis.example.test",
  PII_HASH_KEY: "k".repeat(64),
  PRAXIS_ENV: "production",
};

let db: Client;
let mock: MockProvider;
let clock: Date;

const ctx = (over: Partial<NotifyCtx> = {}): NotifyCtx => ({
  db,
  env: ENV,
  now: () => clock,
  provider: mock,
  sleep: async () => {},
  ...over,
});
const notify = (): Omit<NotifyCtx, "db" | "now"> => ({
  env: ENV,
  provider: mock,
  sleep: async () => {},
});

async function setMode(mode: string, testDate?: string) {
  const put = (k: string, v: string) =>
    db.execute({
      sql: `INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, ?, 'x')
            ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
      args: [k, JSON.stringify(v)],
    });
  await put("email_mode", mode);
  if (testDate) await put("email_review_test_date", testDate);
}
const rows = async (sql: string) => (await db.execute(sql)).rows;
const incidents = () => rows("SELECT * FROM incident ORDER BY id");
const emails = (kind?: string) =>
  rows(
    `SELECT * FROM email_message ${kind ? `WHERE kind = '${kind}'` : ""} ORDER BY created_at, email_key`,
  );

beforeEach(async () => {
  db = await freshDb("main");
  mock = createMockProvider();
  clock = new Date(T0);
  await setMode("incidents");
});

describe("notifyIncident", () => {
  it("opens one incident and sends one email; a repeat sends nothing", async () => {
    const a = await notifyIncident(ctx(), "worker_blind", "S2", { summary: "Worker silent" });
    const b = await notifyIncident(ctx(), "worker_blind", "S2", { summary: "Worker silent" });
    expect(a).toMatchObject({ opened: true, email: "sent", severity: "S2" });
    expect(b).toMatchObject({ opened: false, id: a.id, email: "duplicate" });
    expect(await incidents()).toHaveLength(1);
    expect(mock.outbox).toHaveLength(1);
    expect(mock.outbox[0].subject).toContain("Worker silent");
    expect((await emails())[0].email_key).toBe(`inc:${a.id}:open`);
  });

  it("the day's first incident takes the reserved slot, the next the pool", async () => {
    await notifyIncident(ctx(), "worker_blind", "S2", { summary: "one" });
    await notifyIncident(ctx(), "sentinel_blind", "S2", { summary: "two" });
    const slots = (await emails()).map((r) => r.slot);
    expect(slots).toEqual(["reserved_incident", "pool"]);
  });

  it("email_mode off records the incident and sends nothing", async () => {
    await setMode("off");
    const r = await notifyIncident(ctx(), "worker_blind", "S2", { summary: "x" });
    expect(r).toMatchObject({ opened: true, email: "suppressed_off" });
    expect(mock.calls).toHaveLength(0);
    expect(await incidents()).toHaveLength(1);
    const e = await emails();
    expect(e).toHaveLength(1);
    expect(e[0].status).toBe("suppressed_off");
    // switching on later sends once for the still-open incident, then never again
    await setMode("incidents");
    await notifyIncident(ctx(), "worker_blind", "S2", { summary: "x" });
    await notifyIncident(ctx(), "worker_blind", "S2", { summary: "x" });
    expect(mock.outbox).toHaveLength(1);
  });

  it("S3 kinds and LLM-fallback style kinds never email", async () => {
    const a = await notifyIncident(ctx(), "sentinel_ingest_failed", "S3", { summary: "x" });
    const b = await notifyIncident(ctx(), "llm_fallback", "S3", { summary: "fallback" });
    expect([a.email, b.email]).toEqual([null, null]);
    expect(mock.calls).toHaveLength(0);
    expect(await emails()).toHaveLength(0);
  });

  it("without env the incident is recorded and nothing is sent", async () => {
    const r = await notifyIncident({ db, now: () => clock }, "worker_blind", "S2", {
      summary: "x",
    });
    expect(r.email).toBeNull();
    expect(await incidents()).toHaveLength(1);
    expect(mock.calls).toHaveLength(0);
  });

  it("rejects a malformed kind", async () => {
    await expect(notifyIncident(ctx(), "Bad Kind", "S2", { summary: "x" })).rejects.toThrow();
  });

  it("a 401/403 from the email provider opens the provider_auth incident once", async () => {
    mock.script = [{ outcome: "rejected", httpStatus: 401 }];
    const r = await notifyIncident(ctx(), "worker_blind", "S2", { summary: "x" });
    expect(r.email).toBe("failed");
    const kinds = (await incidents()).map((x) => x.kind);
    expect(kinds).toEqual(["worker_blind", "provider_auth"]);
  });
});

describe("wired writers: one email per incident key", () => {
  it("heartbeat openS2Once", async () => {
    const at = T0.toISOString();
    expect(await openS2Once(db, "worker_blind", { d: D }, at, notify(), "Worker silent")).toBe(
      true,
    );
    expect(await openS2Once(db, "worker_blind", { d: D }, at, notify(), "Worker silent")).toBe(
      false,
    );
    expect(mock.outbox).toHaveLength(1);
  });

  it("watchdog openS1Once (S1 email)", async () => {
    const at = T0.toISOString();
    expect(await openS1Once(db, "unapproved_production_code", {}, at, notify(), "Unapproved")).toBe(
      true,
    );
    expect(await openS1Once(db, "unapproved_production_code", {}, at, notify(), "Unapproved")).toBe(
      false,
    );
    expect(mock.outbox).toHaveLength(1);
    expect(mock.outbox[0].subject).toContain("S1");
  });

  it("Sentinel blind (alerts incident route core) twice -> one email", async () => {
    const c = { db, env: ENV, now: () => clock, provider: mock, sleep: async () => {} };
    const a = await openIncident(c, "sentinel_blind");
    const b = await openIncident(c, "sentinel_blind");
    expect([a.opened, b.opened]).toEqual([true, false]);
    expect(a.email).toBe("sent");
    expect(mock.outbox).toHaveLength(1);
    // the S3 kind is recorded and never emailed
    const s3 = await openIncident(c, "sentinel_ingest_failed");
    expect(s3.email).toBeNull();
    expect(mock.outbox).toHaveLength(1);
  });

  it("heartbeat evening route: problem incidents, escalation-free repeat, one mail each", async () => {
    const env = { ...ENV, CRON_SECRET: "c".repeat(32), BACKUP_PUBLIC_KEY: "age1fake" };
    const handler = createHeartbeatHandler("evening", {
      env,
      mainDb: () => db,
      now: () => new Date("2026-10-19T11:10:00.000Z"),
      provider: mock,
      sleep: async () => {},
    });
    const req = () =>
      new Request("https://x.test/api/cron/heartbeat-evening", {
        headers: { Authorization: `Bearer ${env.CRON_SECRET}` },
      });
    expect((await handler(req())).status).toBe(200);
    await handler(req()); // idempotent per date
    const inc = await incidents();
    expect(inc.map((i) => i.kind)).toContain("worker_blind");
    expect(mock.outbox).toHaveLength(inc.length);
    const keys = (await emails()).map((r) => r.email_key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("backup export failure opens backup_failure once", async () => {
    const env = { ...ENV, ACTIONS_HMAC_SECRET: "a".repeat(40), BACKUP_PUBLIC_KEY: "nope" };
    // A missing/invalid signature is refused before any incident: nothing is raised for it.
    const h = createBackupExportHandler({
      env,
      store: { claim: async () => true } as never,
      nowSec: () => 1,
      authDb: () => db,
      mainDb: () => db,
    });
    const res = await h(
      new Request("https://x.test/api/internal/backup-export", { method: "POST" }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await incidents()).toHaveLength(0);
    // The failure path itself, through the shared door:
    const r = await notifyIncident(ctx(), "backup_failure", "S2", { summary: "backup failed" });
    await notifyIncident(ctx(), "backup_failure", "S2", { summary: "backup failed" });
    expect(r.email).toBe("sent");
    expect(mock.outbox).toHaveLength(1);
  });
});

describe("detectors", () => {
  it("ASX trip -> S2 email once", async () => {
    await db.execute(
      "INSERT INTO source_status (source, mode, since) VALUES ('asx_announcements','tripped','2026-10-19T00:00:00Z') " +
        "ON CONFLICT (source) DO UPDATE SET mode='tripped'",
    );
    for (const d of await detectAsxTrip(db)) {
      await notifyIncident(ctx(), d.kind, d.severity, d.facts);
      await notifyIncident(ctx(), d.kind, d.severity, d.facts);
    }
    expect(mock.outbox).toHaveLength(1);
    expect((await incidents())[0]).toMatchObject({ kind: "asx_trip", severity: "S2" });
  });

  it("GL-06: dispatch-failed with HTTP 401/403 -> one S2 incident; other statuses stay silent", async () => {
    const put = (n: number, status: number | null) =>
      db.execute({
        sql: "INSERT INTO run_record (job, market, concurrency_key, scheduled_for, started_at, ended_at, status, error_summary, details_json) VALUES ('clock','AU',?,?,?,?,'failed','x',?)",
        args: [
          `dispatch-failed:backup:2026-10-19:${n}`,
          "2026-10-19",
          "2026-10-19T08:00:00.000Z",
          "2026-10-19T08:00:00.000Z",
          JSON.stringify({ slot: "backup", attempt: n, status }),
        ],
      });
    await put(1, 500);
    await put(2, null);
    expect(await detectDispatchAuth(db, T0)).toHaveLength(0);
    await put(3, 401);
    await put(4, 403);
    const found = await detectDispatchAuth(db, T0);
    expect(found).toHaveLength(1);
    for (let i = 0; i < 2; i++)
      await notifyIncident(ctx(), found[0].kind, found[0].severity, found[0].facts);
    expect(mock.outbox).toHaveLength(1);
    expect((await incidents())[0]).toMatchObject({ kind: "dispatch_auth", severity: "S2" });
    // older than 24 hours: not raised again
    expect(await detectDispatchAuth(db, new Date("2026-10-21T09:00:00Z"))).toHaveLength(0);
  });

  it("data quality: only two consecutive failing nights raise it", async () => {
    const put = (d: string, pass: number) =>
      db.execute({
        sql: "INSERT INTO quality_score (market, d, tier, valid, expected, score, gate_pass) VALUES ('AU', ?, 'U1', 1, 1, 0.5, ?)",
        args: [d, pass],
      });
    await put("2026-10-15", 1);
    await put("2026-10-16", 0);
    expect(await detectDataQualityTwoNights(db)).toHaveLength(0);
    await put("2026-10-19", 0);
    const found = await detectDataQualityTwoNights(db);
    expect(found).toHaveLength(1);
    await notifyIncident(ctx(), found[0].kind, found[0].severity, found[0].facts);
    expect(mock.outbox).toHaveLength(1);
  });

  describe("evening heartbeat email-record check", () => {
    it("skipped when email_mode is off or incidents without a forced date", async () => {
      await setMode("off");
      expect(await detectReviewMissing(db, T0)).toHaveLength(0);
      await setMode("incidents");
      expect(await detectReviewMissing(db, T0)).toHaveLength(0);
    });

    it("skipped in data-only mode under full; runs on the forced review date", async () => {
      await setMode("full");
      await db.execute("UPDATE market SET mode = 'data_only' WHERE code = 'AU'");
      expect(await detectReviewMissing(db, T0)).toHaveLength(0);
      await setMode("incidents", D);
      expect(await detectReviewMissing(db, T0)).toHaveLength(1);
    });

    it("forced date: missing -> S2 review_missing; a sent review:<d> row clears it", async () => {
      await setMode("incidents", D);
      const found = await detectReviewMissing(db, T0);
      expect(found[0]).toMatchObject({ kind: "review_missing", severity: "S2" });
      const out = await sendEmail(
        { ...ctx(), env: ENV },
        "review",
        emailKeys.review(D),
        REVIEW_FULL,
      );
      expect(out.status).toBe("sent");

      expect(await detectReviewMissing(db, T0)).toHaveLength(0);
    });
  });
});

describe("escalation", () => {
  it("S2 open for 24 h -> S1 and exactly one s1 email, however often it runs", async () => {
    await notifyIncident(ctx(), "worker_blind", "S2", { summary: "x" });
    const early = await escalateIncidents(ctx({ now: () => new Date(T0.getTime() + 3_600_000) }));
    expect(early.escalated).toEqual([]);
    clock = new Date(T0.getTime() + 25 * 3_600_000);
    const first = await escalateIncidents(ctx());
    const again = await escalateIncidents(ctx());
    expect(first.escalated).toHaveLength(1);
    expect(again.escalated).toHaveLength(0);
    expect((await incidents())[0].severity).toBe("S1");
    const keys = (await emails()).map((r) => r.email_key).sort();
    expect(keys).toEqual(["inc:1:open", "inc:1:s1"]);
    expect(mock.outbox).toHaveLength(2);
    // a new S2 of the same kind cannot open while the escalated one is open
    const dup = await notifyIncident(ctx(), "worker_blind", "S2", { summary: "x" });
    expect(dup.opened).toBe(false);
  });

  it("an incident opened as S1 is not escalated; a resolved one is not either", async () => {
    await notifyIncident(ctx(), "unapproved_production_code", "S1", { summary: "x" });
    await notifyIncident(ctx(), "worker_blind", "S2", { summary: "y" });
    await db.execute("UPDATE incident SET resolved_at = 'z' WHERE kind = 'worker_blind'");
    clock = new Date(T0.getTime() + 48 * 3_600_000);
    expect((await escalateIncidents(ctx())).escalated).toEqual([]);
  });

  it("escalation under email_mode off records, sends nothing, and sends once when switched on", async () => {
    await notifyIncident(ctx(), "worker_blind", "S2", { summary: "x" });
    await setMode("off");
    clock = new Date(T0.getTime() + 25 * 3_600_000);
    await escalateIncidents(ctx());
    expect(mock.outbox).toHaveLength(1);
    await setMode("incidents");
    await escalateIncidents(ctx());
    await escalateIncidents(ctx());
    expect(mock.outbox).toHaveLength(2);
  });
});

describe("tokens due", () => {
  const put = (name: string, on: string) =>
    db.execute({
      sql: "INSERT INTO credential_expiry (name, expires_on, set_at, set_by) VALUES (?, ?, 'x', 1)",
      args: [name, on],
    });

  it("exactly 14, 7 and 2 days ahead are due, others are not", async () => {
    await put("a_build_agent_token", "2026-11-02"); // 14
    await put("c2_worker_hmac", "2026-10-26"); // 7
    await put("e_turso_auth_token", "2026-10-21"); // 2
    await put("g_cloudflare_api_token", "2026-10-22"); // 3
    await put("h_resend_api_keys", "2026-10-20"); // 1
    await put("i_llm_api_keys", "2026-10-19"); // 0
    const due = await dueTokens(db, D);
    expect(due.map((t) => t.daysLeft)).toEqual([2, 7, 14]);
  });

  it("one combined email per day, none when nothing is due; no values anywhere", async () => {
    expect(await sendTokensDue(ctx())).toBeNull();
    await put("a_build_agent_token", "2026-11-02");
    await put("e_turso_auth_token", "2026-10-21");
    expect(await sendTokensDue(ctx())).toBe("sent");
    expect(await sendTokensDue(ctx())).toBe("duplicate");
    expect(mock.outbox).toHaveLength(1);
    expect((await emails("tokens"))[0].email_key).toBe(`tokens:${D}`);
    expect(mock.outbox[0].text).toContain("Turso");
  });

  it("email_mode off: nothing sent", async () => {
    await setMode("off");
    await put("e_turso_auth_token", "2026-10-21");
    expect(await sendTokensDue(ctx())).toBe("suppressed_off");
    expect(mock.calls).toHaveLength(0);
  });
});
