// @vitest-environment node
// NFR-023 (V1-S4): the audit hash chain is verified nightly by the evening heartbeat and on demand
// by the Owner CLI; a tampered row raises an S1 incident.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHeartbeatHandler } from "@/lib/heartbeat/handler";
import { appendAudit, auditKey } from "@/lib/db/audit";
import { detectAuditChain } from "@/lib/incidents/detectors";
import { run, verifyChain } from "../../scripts/audit/verify-chain.mjs";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const PII = "test-pii-key";
const key = auditKey(PII);
let authDb: Client;
let mainDb: Client;
beforeEach(async () => {
  authDb = await freshDb("auth");
  mainDb = await freshDb("main");
  for (const a of ["a", "b", "c"]) {
    await appendAudit(authDb, key, { action: a, at: "2026-10-10T07:00:00.000Z", detail: { n: a } });
  }
});

/** audit_event is append-only by trigger; a tamperer with raw access drops the trigger first. */
async function tamper() {
  const t = await authDb.execute(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='audit_event'",
  );
  for (const r of t.rows) await authDb.execute(`DROP TRIGGER ${String(r.name)}`);
  await authDb.execute('UPDATE audit_event SET detail_json = \'{"n":"forged"}\' WHERE id = 2');
}

describe("detectAuditChain", () => {
  it("an intact chain raises nothing", async () => {
    expect(await detectAuditChain(authDb, PII)).toEqual([]);
  });
  it("no key -> cannot verify, raises nothing", async () => {
    await tamper();
    expect(await detectAuditChain(authDb, undefined)).toEqual([]);
  });
  it("a tampered row -> S1 audit_chain_broken naming the first broken row", async () => {
    await tamper();
    const d = await detectAuditChain(authDb, PII);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ kind: "audit_chain_broken", severity: "S1" });
    expect(d[0].facts.detail).toEqual({ firstBrokenId: 2 });
  });
  it("a deleted middle row breaks the chain too", async () => {
    await tamper();
    await authDb.execute("DELETE FROM audit_event WHERE id = 2");
    expect((await detectAuditChain(authDb, PII))[0].facts.detail).toEqual({ firstBrokenId: 3 });
  });
});

describe("evening heartbeat", () => {
  const CRON = "c".repeat(32);
  const EVENING = new Date("2026-10-12T11:10:00.000Z");
  const call = (withAuth: boolean) =>
    createHeartbeatHandler("evening", {
      env: { CRON_SECRET: CRON, BACKUP_PUBLIC_KEY: "age1fake", PII_HASH_KEY: PII },
      mainDb: () => mainDb,
      ...(withAuth ? { authDb: () => authDb } : {}),
      now: () => EVENING,
    })(
      new Request("https://praxis-host.vercel.app/api/cron/heartbeat-evening", {
        headers: { Authorization: `Bearer ${CRON}` },
      }),
    );
  const kinds = async () =>
    (await mainDb.execute("SELECT kind, severity FROM incident")).rows.map((r) => [
      r.kind,
      r.severity,
    ]);

  it("opens an S1 incident once when the chain is broken", async () => {
    await tamper();
    await call(true);
    expect(await kinds()).toContainEqual(["audit_chain_broken", "S1"]);
  });
  it("opens nothing for an intact chain", async () => {
    await call(true);
    expect((await kinds()).map((k) => k[0])).not.toContain("audit_chain_broken");
  });
  it("without an auth DB the check is skipped, the heartbeat still runs", async () => {
    await tamper();
    const res = await call(false);
    expect(res.status).toBe(200);
    expect((await kinds()).map((k) => k[0])).not.toContain("audit_chain_broken");
  });
});

describe("Owner CLI (scripts/audit/verify-chain.mjs)", () => {
  it("agrees with the app verifier on a good and a tampered chain", async () => {
    expect(await verifyChain(authDb, PII)).toEqual({ rows: 3, brokenId: null });
    await tamper();
    expect(await verifyChain(authDb, PII)).toEqual({ rows: 3, brokenId: 2 });
  });
  it("exit codes and output: ok 0, broken 1, not configured 2; no secret in output", async () => {
    const lines: string[] = [];
    const mk = () => ({ execute: (s: string) => authDb.execute(s), close: () => {} });
    const env = { TURSO_AUTH_URL: "file:x", PII_HASH_KEY: PII };
    expect(await run(env, mk as never, (l: string) => lines.push(l))).toBe(0);
    await tamper();
    expect(await run(env, mk as never, (l: string) => lines.push(l))).toBe(1);
    expect(await run({}, mk as never, (l: string) => lines.push(l))).toBe(2);
    expect(lines.join("\n")).toMatch(/chain ok \(3 rows\)/);
    expect(lines.join("\n")).toMatch(/BROKEN at row 2/);
    expect(lines.join("\n")).not.toContain(PII);
  });
});
