// @vitest-environment node
// UX-116, PLT-041, SEC-013, AT-02: updateConfigAction
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addUser, auditRows, KEY } from "../auth/helpers";
import { cleanupTempDbs, freshDb } from "../db/helpers";

const requireUser = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());
const dbs = vi.hoisted(() => ({ main: vi.fn(), auth: vi.fn() }));
vi.mock("@/lib/auth/guard", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-real-ip": "9.9.9.9", "user-agent": "agent" }),
}));
vi.mock("@/lib/db/client", () => ({ mainDb: () => dbs.main(), authDb: () => dbs.auth() }));

import { updateConfigAction } from "@/app/(app)/config/actions";

afterEach(cleanupTempDbs);

let main: Client;
let auth: Client;
let ownerId: number;
const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const good = { key: "retention_logs_days", value: "21", reason: "tidy" };

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv("PII_HASH_KEY", KEY);
  vi.stubEnv("OWNER_EMAIL", "owner@example.test");
  requireUser.mockReset();
  revalidatePath.mockReset();
  main = await freshDb("main");
  auth = await freshDb("auth");
  dbs.main.mockReset().mockReturnValue(main);
  dbs.auth.mockReset().mockReturnValue(auth);
  ownerId = await addUser(auth, { email: "owner@example.test", role: "owner" });
  requireUser.mockResolvedValue({
    id: ownerId,
    email: "owner@example.test",
    name: null,
    role: "owner",
  });
});

describe("updateConfigAction", () => {
  it("requires admin on /config and stops when refused (editor/viewer)", async () => {
    requireUser.mockRejectedValue(new Error("NEXT_HTTP_ERROR_FALLBACK;403"));
    await expect(updateConfigAction(form(good))).rejects.toThrow(/403/);
    expect(requireUser).toHaveBeenCalledWith("admin", "/config");
    expect(revalidatePath).not.toHaveBeenCalled();
    expect((await main.execute("SELECT 1 FROM config_version")).rows).toEqual([]);
    expect(await auditRows(auth)).toEqual([]);
  });

  it("saves a version, audits with the request meta and revalidates", async () => {
    expect(await updateConfigAction(form(good))).toEqual({ ok: true });
    expect(revalidatePath).toHaveBeenCalledWith("/config");
    const v = await main.execute(
      "SELECT key, value_json, reason, changed_by_user_id FROM config_version",
    );
    expect(v.rows[0]).toMatchObject({
      key: "retention_logs_days",
      value_json: "21",
      reason: "tidy",
      changed_by_user_id: ownerId,
    });
    expect((await auditRows(auth))[0]).toMatchObject({
      action: "config.change",
      ip: "9.9.9.9",
      user_agent: "agent",
    });
  });

  it("ignores a scope sent by the client", async () => {
    await updateConfigAction(form({ ...good, scope: "AU" }));
    expect((await main.execute("SELECT scope FROM config_version")).rows[0].scope).toBe("global");
  });

  it("returns the code and message for invalid input, without revalidating", async () => {
    const r = await updateConfigAction(form({ ...good, value: "0" }));
    expect(r).toMatchObject({ error: "invalid" });
    expect((r as { message: string }).message).toMatch(/^Value /);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("returns a bare code when there is no message", async () => {
    expect(await updateConfigAction(form({ ...good, key: "nope" }))).toEqual({ error: "unknown" });
  });

  it("fixed keys and missing fields are refused", async () => {
    expect(await updateConfigAction(form({ ...good, key: "hmac_max_age_s" }))).toMatchObject({
      error: "fixed",
    });
    expect(await updateConfigAction(form({}))).toEqual({ error: "unknown" });
    expect(await updateConfigAction(form({ key: good.key, value: "5" }))).toMatchObject({
      error: "invalid",
    });
  });

  it("a stale Owner (revoked since the page loaded) is forbidden", async () => {
    await auth.execute({
      sql: "UPDATE app_user SET status = 'revoked' WHERE id = ?",
      args: [ownerId],
    });
    expect(await updateConfigAction(form(good))).toEqual({ error: "forbidden" });
  });

  it("an unexpected throw becomes unavailable", async () => {
    dbs.main.mockImplementation(() => {
      throw new Error("db not configured");
    });
    expect(await updateConfigAction(form(good))).toEqual({ error: "unavailable" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
