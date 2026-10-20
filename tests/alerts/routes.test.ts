// @vitest-environment node
// M5 T6 routes. Signed Worker routes (SEC-017 c2, D-067 pattern): api/internal/alert-flush and
// api/internal/incident refuse unsigned, stale, replayed, tampered, mis-bound and oversize
// requests; the incident route opens ONE incident and one e-mail. Signed-in routes: api/alerts,
// api/alerts/[key]/ack, api/alerts/[key]/snooze and api/alerts/quiet-hours are session-gated,
// own-row and audited. Mock e-mail provider only; synthetic data.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error plain .mjs signer without types (the Actions-side twin)
import { sign } from "../../scripts/smoke/sign.mjs";
import {
  createAlertFlushHandler,
  createIncidentHandler,
  MAX_BODY_BYTES,
  type MachineDeps,
} from "@/lib/alerts/machine";
import { createMockProvider, type MockProvider } from "@/lib/email/mock";
import type { NonceStore } from "@/lib/security/replay";
import { isPublicPath } from "@/lib/http/gate";
import type { CurrentUser } from "@/lib/auth/session";
import { addUser, auditRows, KEY } from "../auth/helpers";
import { cleanupTempDbs, freshDb } from "../db/helpers";

const mem = vi.hoisted(() => ({
  seen: new Set<string>(),
  main: null as unknown,
  auth: null as unknown,
  user: null as unknown,
}));
vi.mock("@/lib/security/replay", () => ({
  TursoNonceStore: class {
    async claim(n: string) {
      if (mem.seen.has(n)) return false;
      mem.seen.add(n);
      return true;
    }
  },
}));
vi.mock("@/lib/db/client", () => ({ mainDb: () => mem.main, authDb: () => mem.auth }));
vi.mock("@/lib/auth/session", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/session")>()),
  getCurrentUser: async () => mem.user,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), forbidden: vi.fn() }));
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import * as flushRoute from "@/app/api/internal/alert-flush/route";
import * as incidentRoute from "@/app/api/internal/incident/route";
import * as listRoute from "@/app/api/alerts/route";
import * as ackRoute from "@/app/api/alerts/[key]/ack/route";
import * as snoozeRoute from "@/app/api/alerts/[key]/snooze/route";
import * as quietRoute from "@/app/api/alerts/quiet-hours/route";

afterEach(() => {
  cleanupTempDbs();
  vi.unstubAllEnvs();
});

const SECRET = "7".repeat(64);
const NOW_MS = Date.UTC(2026, 9, 19, 9, 0, 0); // Mon 20:00 AEDT
const NOW = NOW_MS / 1000;
const TODAY = "2026-10-19";
const STAGING = { WORKER_HMAC_SECRET: SECRET, TEST_IDENTITY_SECRET: "1".repeat(64) };
const URL_FLUSH = "https://praxis-host.vercel.app/api/internal/alert-flush";
const URL_INC = "https://praxis-host.vercel.app/api/internal/incident";
const MAIL_ENV = {
  ...STAGING,
  EMAIL_PROVIDER: "mock",
  OWNER_EMAIL: "owner@example.test",
  APP_BASE_URL: "https://praxis.example.test",
  PII_HASH_KEY: KEY,
  PRAXIS_ENV: "staging",
} as Record<string, string | undefined>;

let main: Client;
let mock: MockProvider;

const memStore = (): NonceStore => {
  const seen = new Set<string>();
  return {
    claim: async (n) => {
      if (seen.has(n)) return false;
      seen.add(n);
      return true;
    },
  };
};
const deps = (over: Partial<MachineDeps> = {}): MachineDeps => ({
  env: MAIL_ENV,
  store: memStore(),
  nowSec: () => NOW,
  today: () => TODAY,
  ctx: () => ({
    db: main,
    env: MAIL_ENV,
    now: () => new Date(NOW_MS),
    provider: mock,
    sleep: async () => {},
  }),
  ...over,
});
let n = 0;
const nonce = () => (++n).toString(16).padStart(32, "0");
const flushBody = (over: Record<string, unknown> = {}) => ({
  purpose: "alert-flush",
  env: "staging",
  d: TODAY,
  ...over,
});
const incBody = (over: Record<string, unknown> = {}) => ({
  purpose: "incident",
  env: "staging",
  d: TODAY,
  kind: "sentinel_blind",
  window_min: 15,
  ...over,
});
const post = (
  url: string,
  body: string | object,
  headers?: Record<string, string>,
  nc = nonce(),
) => {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return new Request(url, {
    method: "POST",
    body: raw,
    headers: headers ?? (sign(SECRET, raw, NOW, nc) as Record<string, string>),
  });
};
const setMode = (mode: string) =>
  main.execute({
    sql: `INSERT INTO worker_state (key, value_json, updated_at) VALUES ('email_mode', ?, 'x')
          ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
    args: [JSON.stringify(mode)],
  });

beforeEach(async () => {
  main = await freshDb("main");
  mem.main = main;
  mem.seen.clear();
  mock = createMockProvider();
  await setMode("full");
});

describe("POST /api/internal/alert-flush: signed-route refusal", () => {
  it("200 with the flush result when signed correctly", async () => {
    const r = await createAlertFlushHandler(deps())(post(URL_FLUSH, flushBody()));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toMatchObject({ status: "idle", raised: 0, email: null, due: null });
  });

  it("401 generic body: wrong secret, no headers, stale, future, tampered body, replay", async () => {
    const h = createAlertFlushHandler(deps());
    const raw = JSON.stringify(flushBody());
    const wrong = sign("8".repeat(64), raw, NOW, "a".repeat(32)) as Record<string, string>;
    const stale = sign(SECRET, raw, NOW - 301, "b".repeat(32)) as Record<string, string>;
    const future = sign(SECRET, raw, NOW + 301, "d".repeat(32)) as Record<string, string>;
    const okHeaders = sign(SECRET, raw, NOW, "e".repeat(32)) as Record<string, string>;
    const once = "c".repeat(32);
    expect((await h(post(URL_FLUSH, raw, undefined, once))).status).toBe(200);
    const tampered = JSON.stringify(flushBody({ d: "2026-10-20" }));
    for (const req of [
      post(URL_FLUSH, raw, wrong),
      post(URL_FLUSH, raw, {}),
      post(URL_FLUSH, raw, stale),
      post(URL_FLUSH, raw, future),
      post(URL_FLUSH, tampered, okHeaders),
      post(URL_FLUSH, raw, undefined, once), // replay
    ]) {
      const r = await h(req);
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: "unauthorized" });
    }
  });

  it("503 when WORKER_HMAC_SECRET is missing or malformed; nothing runs", async () => {
    for (const secret of [undefined, "", "zz", "A".repeat(64)]) {
      const ctx = vi.fn();
      const r = await createAlertFlushHandler(
        deps({ env: { ...MAIL_ENV, WORKER_HMAC_SECRET: secret }, ctx: ctx as never }),
      )(post(URL_FLUSH, flushBody()));
      expect(r.status).toBe(503);
      expect(ctx).not.toHaveBeenCalled();
    }
  });

  it("400: another purpose, another environment, another date, oversize, not an object", async () => {
    const h = createAlertFlushHandler(deps());
    for (const body of [
      flushBody({ purpose: "incident" }),
      flushBody({ purpose: "sentinel-ingest" }),
      flushBody({ env: "production" }),
      flushBody({ d: "2026-10-18" }),
      flushBody({ d: 5 }),
      flushBody({ pad: "x".repeat(MAX_BODY_BYTES) }),
      "[]",
      "not json",
    ]) {
      const r = await h(post(URL_FLUSH, body));
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: "bad_request" });
    }
    const big = new Request(URL_FLUSH, {
      method: "POST",
      body: "{}",
      headers: { "content-length": String(MAX_BODY_BYTES + 1) },
    });
    const text = vi.spyOn(big, "text");
    expect((await h(big)).status).toBe(400);
    expect(text).not.toHaveBeenCalled();
  });

  it("503 without leaking when the replay store or the flush fails", async () => {
    const store = { claim: () => Promise.reject(new Error("db host secret")) };
    const r = await createAlertFlushHandler(deps({ store }))(post(URL_FLUSH, flushBody()));
    expect(r.status).toBe(503);
    expect(await r.text()).not.toContain("secret");
    const boom = deps({
      ctx: () => {
        throw new Error("SECRET-9");
      },
    });
    const r2 = await createAlertFlushHandler(boom)(post(URL_FLUSH, flushBody()));
    expect(r2.status).toBe(503);
    expect(await r2.text()).not.toContain("SECRET-9");
  });

  it("the real route exports POST only, answers 401 unsigned, and is a public machine path", async () => {
    expect(Object.keys(flushRoute).filter((k) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(k))).toEqual([
      "POST",
    ]);
    vi.stubEnv("WORKER_HMAC_SECRET", SECRET);
    vi.stubEnv("BACKUP_PUBLIC_KEY", "age1xyz");
    const r = await flushRoute.POST(new Request(URL_FLUSH, { method: "POST", body: "{}" }));
    expect(r.status).toBe(401);
    expect(isPublicPath("/api/internal/alert-flush")).toBe(true);
    expect(isPublicPath("/api/internal/incident")).toBe(true);
  });
});

describe("POST /api/internal/incident: signed-route refusal and behaviour", () => {
  it("opens ONE S2 sentinel_blind incident and sends ONE incident e-mail; a repeat adds nothing", async () => {
    const h = createIncidentHandler(deps());
    const r = await h(post(URL_INC, incBody()));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ opened: true, severity: "S2", email: "sent" });
    expect(mock.outbox).toHaveLength(1);
    expect(mock.outbox[0].subject).toContain("incident S2");
    expect(mock.outbox[0].subject).toContain("15 minutes");
    expect(mock.outbox[0].to).toBe("owner@example.test");
    const inc = (await main.execute("SELECT id, severity, kind, resolved_at FROM incident")).rows;
    expect(inc).toHaveLength(1);
    expect(inc[0]).toMatchObject({ severity: "S2", kind: "sentinel_blind", resolved_at: null });
    const key = `inc:${inc[0].id}:open`;
    const slot = await main.execute({
      sql: "SELECT slot, status FROM email_message WHERE email_key = ?",
      args: [key],
    });
    expect(slot.rows[0]).toMatchObject({ slot: "reserved_incident", status: "sent" });

    const again = await h(post(URL_INC, incBody()));
    expect(await again.json()).toEqual({ opened: false, severity: "S2", email: "duplicate" });
    expect(mock.outbox).toHaveLength(1);
    expect((await main.execute("SELECT 1 FROM incident")).rows).toHaveLength(1);
  });

  it("a resolved incident lets the next blindness open a new one and a new e-mail", async () => {
    const h = createIncidentHandler(deps());
    await h(post(URL_INC, incBody()));
    await main.execute("UPDATE incident SET resolved_at = '2026-10-19T09:30:00.000Z'");
    const r = await h(post(URL_INC, incBody()));
    expect(await r.json()).toMatchObject({ opened: true, email: "sent" });
    expect(mock.outbox).toHaveLength(2);
  });

  it("the S3 sentinel_ingest_failed kind is in-app only (no e-mail)", async () => {
    const r = await createIncidentHandler(deps())(
      post(URL_INC, incBody({ kind: "sentinel_ingest_failed" })),
    );
    expect(await r.json()).toEqual({ opened: true, severity: "S3", email: null });
    expect(mock.outbox).toHaveLength(0);
  });

  it("the production switch off still records the incident; the e-mail is suppressed", async () => {
    await setMode("off");
    const r = await createIncidentHandler(deps())(post(URL_INC, incBody()));
    expect(await r.json()).toEqual({ opened: true, severity: "S2", email: "suppressed_off" });
    expect(mock.outbox).toHaveLength(0);
    expect((await main.execute("SELECT 1 FROM incident")).rows).toHaveLength(1);
  });

  it("400 for an unknown kind, a bad window or another purpose; 401 unsigned or replayed", async () => {
    const h = createIncidentHandler(deps());
    for (const body of [
      incBody({ kind: "worker_blind" }),
      incBody({ kind: "constructor" }),
      incBody({ kind: 5 }),
      incBody({ window_min: 0 }),
      incBody({ window_min: "15" }),
      incBody({ window_min: 100000 }),
      incBody({ purpose: "alert-flush" }),
    ]) {
      expect((await h(post(URL_INC, body))).status, JSON.stringify(body)).toBe(400);
    }
    expect((await h(post(URL_INC, incBody(), {}))).status).toBe(401);
    const once = "f".repeat(32);
    expect((await h(post(URL_INC, incBody(), undefined, once))).status).toBe(200);
    expect((await h(post(URL_INC, incBody(), undefined, once))).status).toBe(401);
    expect((await main.execute("SELECT 1 FROM incident")).rows).toHaveLength(1);
  });

  it("the real route exports POST only and answers 401 unsigned", async () => {
    expect(
      Object.keys(incidentRoute).filter((k) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(k)),
    ).toEqual(["POST"]);
    vi.stubEnv("WORKER_HMAC_SECRET", SECRET);
    vi.stubEnv("BACKUP_PUBLIC_KEY", "age1xyz");
    const r = await incidentRoute.POST(new Request(URL_INC, { method: "POST", body: "{}" }));
    expect(r.status).toBe(401);
  });
});

// ---- signed-in routes ---------------------------------------------------------------------------

describe("/api/alerts routes (session, own rows, audit)", () => {
  let auth: Client;
  let viewer: CurrentUser;
  let editor: CurrentUser;
  const P1 = "ann:AU:asx_announcements:p1";
  const P0 = "ann:AU:asx_announcements:p0";
  const BASE = "https://praxis.example.test";
  const ctxFor = (key: string) => ({ params: Promise.resolve({ key: encodeURIComponent(key) }) });
  const asJson = (url: string, body?: unknown, method = "POST") =>
    new Request(url, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  beforeEach(async () => {
    auth = await freshDb("auth");
    mem.auth = auth;
    const v = await addUser(auth, { email: "v@example.test", role: "viewer" });
    const e = await addUser(auth, { email: "e@example.test", role: "editor" });
    viewer = { id: v, email: "v@example.test", name: null, role: "viewer" };
    editor = { id: e, email: "e@example.test", name: null, role: "editor" };
    mem.user = viewer;
    vi.stubEnv("PII_HASH_KEY", KEY);
    const at = new Date().toISOString();
    for (const [k, tier, kind] of [
      [P0, "P0", "halt"],
      [P1, "P1", "announcement"],
    ]) {
      await main.execute({
        sql: `INSERT INTO alert (alert_key, market, code, kind, tier, detected_at, facts_json)
              VALUES (?, 'AU', 'ZZAA', ?, ?, ?, '{}')`,
        args: [k, kind, tier, at],
      });
    }
  });

  it("GET /api/alerts: 401 without a session; a Viewer reads the inbox and the badge", async () => {
    mem.user = null;
    expect((await listRoute.GET(new Request(`${BASE}/api/alerts`), undefined)).status).toBe(401);
    mem.user = viewer;
    const r = await listRoute.GET(new Request(`${BASE}/api/alerts?tier=P1`), undefined);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.alerts.map((a: { key: string }) => a.key)).toEqual([P1]);
    expect(typeof body.badge).toBe("number");
    expect((await listRoute.GET(new Request(`${BASE}/api/alerts?tier=P9`), undefined)).status).toBe(
      400,
    );
    expect(
      (await listRoute.GET(new Request(`${BASE}/api/alerts?unacked=maybe`), undefined)).status,
    ).toBe(400);
  });

  // DAT-124 / ROL-107 / UX-009: GET /api/alerts never carries a code, a code-bearing key, a price or a
  // link to a user who is masked; the Owner and a user with a live grant get the real values.
  describe("GET /api/alerts masking", () => {
    const PROXY = "proxy:AU:ZZHLT:2026-10-19";
    const TB = "tb:sig-ZZHLT-E01:TB-NEG:2026-10-19";
    const CODES = ["ZZAA", "ZZHLT", "ZZWHY"];
    let owner: CurrentUser;
    const get = async (user: CurrentUser | null, q = "") => {
      mem.user = user;
      const r = await listRoute.GET(new Request(`${BASE}/api/alerts${q}`), undefined);
      return { status: r.status, text: await r.text() };
    };
    const clean = (text: string) => {
      for (const c of CODES)
        expect(text, c).not.toMatch(new RegExp(`(?<![A-Za-z0-9])${c}(?![A-Za-z0-9])`));
      expect(text).not.toContain("://");
      expect(text).not.toContain("Zed Halt Holdings");
    };

    beforeEach(async () => {
      const o = await addUser(auth, { email: "o@example.test", role: "owner" });
      owner = { id: o, email: "o@example.test", name: null, role: "owner" };
      const at = new Date().toISOString();
      await main.execute({
        sql: "INSERT INTO instrument (market, code, name) VALUES ('AU', 'ZZHLT', 'Zed Halt Holdings'), ('AU', 'ZZAA', 'Zed Alpha Holdings'), ('AU', 'ZZWHY', 'Zed Why Holdings')",
        args: [],
      });
      for (const [k, kind, code, text] of [
        [PROXY, "halt_proxy", "ZZHLT", null],
        [TB, "thesis_breaker", "ZZHLT", null],
      ] as const) {
        await main.execute({
          sql: `INSERT INTO alert (alert_key, market, code, kind, tier, detected_at, facts_json, text_llm)
                VALUES (?, 'AU', ?, ?, 'P1', ?, ?, ?)`,
          args: [
            k,
            code,
            kind,
            at,
            JSON.stringify({
              rule: "r",
              why: "ZZWHY moved; see https://news.example.test/x for Zed Halt Holdings",
              executions: [{ id: "E01", label: "F1 U", weightPct: 12 }],
            }),
            text,
          ],
        });
      }
    });

    it("an Owner gets the real codes, keys and text", async () => {
      const { status, text } = await get(owner);
      expect(status).toBe(200);
      expect(text).toContain("ZZHLT");
      expect(text).toContain(PROXY);
      expect(text).toContain("https://news.example.test/x");
    });

    it.each(["viewer", "editor"] as const)("a %s gets no code, key, name or link", async (role) => {
      const { status, text } = await get(role === "viewer" ? viewer : editor);
      expect(status).toBe(200);
      clean(text);
      expect(text).not.toContain(PROXY);
      expect(text).not.toContain(TB);
      expect(text).toContain("Stock ");
      expect(text).toContain("[link hidden]");
      expect(text).toContain("mk:");
      const body = JSON.parse(text) as {
        alerts: Array<{ code: string | null; key: string }>;
        badge: number;
      };
      expect(typeof body.badge).toBe("number");
      for (const a of body.alerts) {
        if (a.code !== null) expect(a.code).toMatch(/^(Stock [A-Z]+|Another stock)$/);
        expect(a.key).not.toMatch(/ZZ/);
      }
    });

    it("an Editor with a live grant sees real codes; an expired grant masks again", async () => {
      await auth.execute({
        sql: "INSERT INTO unmask_grant (user_id, granted_by, granted_at, expires_at) VALUES (?, ?, '2019-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')",
        args: [editor.id, owner.id],
      });
      clean((await get(editor)).text);
      await auth.execute({
        sql: "INSERT INTO unmask_grant (user_id, granted_by, granted_at, expires_at) VALUES (?, ?, '2019-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z')",
        args: [editor.id, owner.id],
      });
      expect((await get(editor)).text).toContain("ZZHLT");
    });

    it("a missing user table (lookup failure) keeps the response masked", async () => {
      await auth.execute("DROP TABLE unmask_grant");
      const { status, text } = await get(editor);
      expect(status).toBe(200);
      clean(text);
    });

    it("a masked user can acknowledge and snooze through the opaque key; the stored key is used", async () => {
      const body = JSON.parse((await get(viewer)).text) as {
        alerts: Array<{ key: string; kind: string }>;
      };
      const opaque = body.alerts.find((a) => a.kind === "halt_proxy")!.key;
      expect(opaque).toMatch(/^mk:[0-9a-f]{16}$/);
      const ack = await ackRoute.POST(asJson(`${BASE}/api/alerts/x/ack`), ctxFor(opaque));
      expect(ack.status).toBe(200);
      const row = await auth.execute({
        sql: "SELECT alert_key, acked_at FROM alert_user_state WHERE user_id = ?",
        args: [viewer.id],
      });
      expect(row.rows[0]!.alert_key).toBe(PROXY);
      const sn = await snoozeRoute.POST(
        asJson(`${BASE}/api/alerts/x/snooze`, {
          until: new Date(Date.now() + 3_600_000).toISOString(),
        }),
        ctxFor(opaque),
      );
      expect(sn.status).toBe(200);
      const unknown = await ackRoute.POST(
        asJson(`${BASE}/api/alerts/x/ack`),
        ctxFor("mk:0123456789abcdef"),
      );
      expect(unknown.status).toBe(404);
    });
  });

  it("POST api/alerts/[key]/ack: every role may acknowledge its own state; audited; 404/400", async () => {
    mem.user = null;
    expect((await ackRoute.POST(asJson(`${BASE}/api/alerts/x/ack`), ctxFor(P1))).status).toBe(401);
    mem.user = viewer;
    const r = await ackRoute.POST(asJson(`${BASE}/api/alerts/x/ack`), ctxFor(P1));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ changed: true });
    mem.user = editor;
    expect((await ackRoute.POST(asJson(`${BASE}/api/alerts/x/ack`), ctxFor(P1))).status).toBe(200);
    const states = await auth.execute("SELECT user_id FROM alert_user_state ORDER BY user_id");
    expect(states.rows.map((x) => Number(x.user_id))).toEqual([viewer.id, editor.id]);
    expect((await auditRows(auth)).filter((x) => x.action === "alert.ack")).toHaveLength(2);
    expect(
      (await ackRoute.POST(asJson(`${BASE}/api/alerts/x/ack`), ctxFor("ann:AU:s:none"))).status,
    ).toBe(404);
    expect((await ackRoute.POST(asJson(`${BASE}/api/alerts/x/ack`), ctxFor("junk"))).status).toBe(
      400,
    );
  });

  it("POST api/alerts/[key]/snooze: P1 yes, P0 refused (409), bad body 400", async () => {
    const until = new Date(Date.now() + 86_400_000).toISOString();
    const ok = await snoozeRoute.POST(asJson(`${BASE}/x`, { until }), ctxFor(P1));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ snoozedUntil: until });
    expect((await snoozeRoute.POST(asJson(`${BASE}/x`, { until }), ctxFor(P0))).status).toBe(409);
    expect((await snoozeRoute.POST(asJson(`${BASE}/x`, {}), ctxFor(P1))).status).toBe(400);
    expect((await snoozeRoute.POST(asJson(`${BASE}/x`, { until: 5 }), ctxFor(P1))).status).toBe(
      400,
    );
    expect((await snoozeRoute.POST(asJson(`${BASE}/x`, { until: null }), ctxFor(P1))).status).toBe(
      200,
    );
    mem.user = null;
    expect((await snoozeRoute.POST(asJson(`${BASE}/x`, { until }), ctxFor(P1))).status).toBe(401);
  });

  it("GET and POST api/alerts/quiet-hours: read, set, clear, invalid", async () => {
    const url = `${BASE}/api/alerts/quiet-hours`;
    const get0 = await quietRoute.GET(new Request(url), undefined);
    expect(await get0.json()).toEqual({ quietHours: null });
    const set = await quietRoute.POST(
      asJson(url, { quietHours: { start: "22:00", end: "07:00" } }),
      undefined,
    );
    expect(set.status).toBe(200);
    const get1 = await quietRoute.GET(new Request(url), undefined);
    expect(await get1.json()).toEqual({ quietHours: { start: "22:00", end: "07:00" } });
    mem.user = editor;
    expect(await (await quietRoute.GET(new Request(url), undefined)).json()).toEqual({
      quietHours: null,
    });
    mem.user = viewer;
    expect(
      (
        await quietRoute.POST(
          asJson(url, { quietHours: { start: "22:00", end: "22:00" } }),
          undefined,
        )
      ).status,
    ).toBe(400);
    expect((await quietRoute.POST(asJson(url, {}), undefined)).status).toBe(400);
    expect((await quietRoute.POST(asJson(url, { quietHours: null }), undefined)).status).toBe(200);
    mem.user = null;
    expect((await quietRoute.GET(new Request(url), undefined)).status).toBe(401);
  });

  it("the route files export the documented methods only", () => {
    const methods = (m: object) =>
      Object.keys(m).filter((k) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(k));
    expect(methods(listRoute)).toEqual(["GET"]);
    expect(methods(ackRoute)).toEqual(["POST"]);
    expect(methods(snoozeRoute)).toEqual(["POST"]);
    expect(methods(quietRoute).sort()).toEqual(["GET", "POST"]);
  });
});
