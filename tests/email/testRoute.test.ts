// @vitest-environment node
// M5 T3: POST /api/email/test (api/email/test), the Owner-only "send test email" action (EML-034,
// design 4.10): Owner only, audit first, at most 1 per 10 minutes and 3 per day, pool slot,
// allowed only in `full` mode. Mock provider only.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addUser, auditRows, KEY } from "../auth/helpers";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { createMockProvider } from "@/lib/email/mock";
import { handleTestEmail } from "@/lib/email/testRoute";
import type { CurrentUser } from "@/lib/auth/session";

const session = vi.hoisted(() => ({ user: vi.fn() }));
const dbs = vi.hoisted(() => ({ main: vi.fn(), auth: vi.fn() }));
vi.mock("@/lib/auth/session", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/session")>()),
  getCurrentUser: () => session.user(),
}));
vi.mock("@/lib/db/client", () => ({ mainDb: () => dbs.main(), authDb: () => dbs.auth() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), forbidden: vi.fn() }));
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { POST } from "@/app/api/email/test/route";
import * as route from "@/app/api/email/test/route";

afterEach(cleanupTempDbs);

const OWNER_EMAIL = "owner@example.test";
let main: Client;
let auth: Client;
let owner: CurrentUser;
let clock: Date;
let mock = createMockProvider();
const ENV = {
  EMAIL_PROVIDER: "mock",
  OWNER_EMAIL,
  APP_BASE_URL: "https://praxis.example.test",
  PII_HASH_KEY: KEY,
  PRAXIS_ENV: "production",
};

async function setMode(mode: string) {
  await main.execute({
    sql: `INSERT INTO worker_state (key, value_json, updated_at) VALUES ('email_mode', ?, 'x')
          ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
    args: [JSON.stringify(mode)],
  });
}
const call = () =>
  handleTestEmail(
    {
      mainDb: main,
      authDb: auth,
      env: ENV,
      meta: { ip: "9.9.9.9", userAgent: "UA" },
      now: () => clock,
      provider: mock,
    },
    owner,
  );

beforeEach(async () => {
  main = await freshDb("main");
  auth = await freshDb("auth");
  dbs.main.mockReturnValue(main);
  dbs.auth.mockReturnValue(auth);
  const id = await addUser(auth, { email: OWNER_EMAIL, role: "owner" });
  owner = { id, email: OWNER_EMAIL, name: null, role: "owner" };
  clock = new Date("2026-10-19T09:00:00.000Z");
  mock = createMockProvider();
  await setMode("full");
});

describe("handleTestEmail", () => {
  it("sends one [TEST] email from a pool slot and writes the audit event first", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "sent" });
    expect(mock.outbox).toHaveLength(1);
    expect(mock.outbox[0].subject).toContain("[TEST] Praxis test email");
    const a = await auditRows(auth);
    expect(a.map((x) => x.action)).toEqual(["email.test_requested"]);
    expect(JSON.stringify(a)).not.toContain(OWNER_EMAIL.split("@")[0] + "@example");
    const slot = (await main.execute("SELECT slot, kind FROM email_message")).rows[0];
    expect(slot).toMatchObject({ slot: "pool", kind: "test" });
  });

  it("at most one per 10 minutes and three per day", async () => {
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(429); // same minute
    clock = new Date(clock.getTime() + 11 * 60_000);
    expect((await call()).status).toBe(200);
    clock = new Date(clock.getTime() + 11 * 60_000);
    expect((await call()).status).toBe(200);
    clock = new Date(clock.getTime() + 11 * 60_000);
    const fourth = await call();
    expect(fourth.status).toBe(429);
    expect(await fourth.json()).toEqual({ error: "rate_limited" });
    expect(mock.outbox).toHaveLength(3);
    // the next Melbourne day starts again
    clock = new Date("2026-10-20T09:00:00.000Z");
    expect((await call()).status).toBe(200);
  });

  it("is refused (409) while email_mode is off or incidents, and sends nothing", async () => {
    for (const m of ["off", "incidents"]) {
      await setMode(m);
      const res = await call();
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ status: "suppressed_off" });
    }
    expect(mock.calls).toHaveLength(0);
  });

  it("answers 503 when the database is unavailable", async () => {
    const res = await handleTestEmail(
      {
        mainDb: { execute: async () => Promise.reject(new Error("down")) } as unknown as Client,
        authDb: auth,
        env: ENV,
        meta: { ip: null, userAgent: null },
        now: () => clock,
        provider: mock,
      },
      owner,
    );
    expect(res.status).toBe(503);
  });
});

describe("POST /api/email/test route wrapper", () => {
  it("exports POST only", () => {
    expect(Object.keys(route).filter((k) => ["GET", "PUT", "PATCH", "DELETE"].includes(k))).toEqual(
      [],
    );
    expect(typeof POST).toBe("function");
  });

  it("401 without a session, 403 (audited) for an editor, never reaching the sender", async () => {
    const req = () => new Request("https://praxis.example.test/api/email/test", { method: "POST" });
    session.user.mockResolvedValueOnce(null);
    expect((await POST(req(), undefined)).status).toBe(401);

    vi.stubEnv("PII_HASH_KEY", KEY);
    session.user.mockResolvedValueOnce({ ...owner, role: "editor" });
    expect((await POST(req(), undefined)).status).toBe(403);
    expect((await auditRows(auth)).map((x) => x.action)).toContain("auth.forbidden");
    expect(mock.calls).toHaveLength(0);
    vi.unstubAllEnvs();
  });
});
