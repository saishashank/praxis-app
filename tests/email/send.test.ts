// @vitest-environment node
// M5 T3 email core (docs/M5_design.md 2.3, 2.4, 4.9, 4.10, 4.12; D-096, D-099): the production
// switch matrix, one email per key (also under concurrency), caps and reserved slots (P0 never uses
// a reserved slot), retries and the attempts log, the crash-after-accept case, the recipient guard,
// the staging prefix, provider error paths and the no-live-send guard. Mock provider only; the real
// Resend API is never called (the fetch used by the Resend tests is a local stub).
// The Owner-only route POST /api/email/test is covered in testRoute.test.ts.
import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDbs, freshDb, MIGRATIONS, tempDbUrl, track } from "../db/helpers";
import { loadMigrations, migrateUp } from "@/lib/db/migrate-core.mjs";
import { setConfig } from "@/lib/config/store";
import { claimKey, emailUsage, loadCaps } from "@/lib/email/caps";
import { emailKeys, keyMatchesKind, melbourneDate, slotCandidates } from "@/lib/email/keys";
import { createMockProvider } from "@/lib/email/mock";
import {
  guardRecipient,
  LiveSendBlockedError,
  NULL_PROVIDER,
  ownerAddress,
  RecipientGuardError,
  RESEND_HOST,
  type EmailProvider,
} from "@/lib/email/provider";
import { createResendProvider, idempotencyHeader, RESEND_URL } from "@/lib/email/resend";
import { resetStagingLiveSlot, selectProvider } from "@/lib/email/select";
import { sendEmail, type FactsByKind, type SendContext } from "@/lib/email/send";
import { EMAIL_KINDS, type EmailKind } from "@/lib/sentinel/schema";
import * as fx from "../fixtures/email/facts";

afterEach(cleanupTempDbs);

// 2026-10-19 09:00 UTC = 20:00 on 2026-10-19 in Melbourne (AEDT).
const T0 = new Date("2026-10-19T09:00:00.000Z");
const D = "2026-10-19";
const OWNER = "owner@example.test";
const ENV = {
  EMAIL_PROVIDER: "mock",
  OWNER_EMAIL: OWNER,
  APP_BASE_URL: fx.APP,
  PII_HASH_KEY: "k".repeat(64),
  PRAXIS_ENV: "production",
} as Record<string, string | undefined>;

let db: Client;
let mock: ReturnType<typeof createMockProvider>;
let clock: Date;
const sleeps: number[] = [];

function ctx(over: Partial<SendContext> = {}): SendContext {
  return {
    db,
    env: ENV,
    now: () => clock,
    provider: mock,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...over,
  };
}

async function setMode(mode: string, testDate?: string): Promise<void> {
  const put = (k: string, v: string) =>
    db.execute({
      sql: `INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, ?, 'x')
            ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
      args: [k, JSON.stringify(v)],
    });
  await put("email_mode", mode);
  if (testDate) await put("email_review_test_date", testDate);
}

const FACTS: { [K in EmailKind]: FactsByKind[K] } = {
  review: fx.REVIEW_FULL,
  p0: { alert: fx.P0_ALERT },
  p0_batch: { window: "10:42-10:47 AEDT", alerts: fx.P0_BATCH_ALERTS },
  incident_open: fx.INCIDENT_OPEN,
  incident_s1: fx.INCIDENT_ESCALATED,
  dbdown: fx.INCIDENT_OPEN,
  tokens: fx.TOKENS_DUE,
  unread7: fx.UNREAD7,
  reminder: fx.REMINDER,
  brief: fx.BRIEF,
  test: { requestedAt: "Mon 19 Oct 2026 20:00 AEDT" },
};
const KEY: { [K in EmailKind]: string } = {
  review: emailKeys.review(D),
  p0: emailKeys.p0("ann:AU:asx:1"),
  p0_batch: emailKeys.p0Batch("ann:AU:asx:1"),
  incident_open: emailKeys.incidentOpen("i1"),
  incident_s1: emailKeys.incidentS1("i1"),
  dbdown: emailKeys.dbdown(D, "a"),
  tokens: emailKeys.tokens(D),
  unread7: emailKeys.unread7(D),
  reminder: emailKeys.reminder(D),
  brief: emailKeys.brief(D),
  test: emailKeys.test(D, 1),
};
const send = <K extends EmailKind>(kind: K, key = KEY[kind], c = ctx(), o = {}) =>
  sendEmail(c, kind, key, FACTS[kind], o);

async function rows(sql = "SELECT * FROM email_message ORDER BY email_key") {
  return (await db.execute(sql)).rows;
}

beforeEach(async () => {
  db = await freshDb("main");
  mock = createMockProvider();
  clock = new Date(T0);
  sleeps.length = 0;
  await setMode("full");
});

describe("keys", () => {
  it("each kind accepts only its own key shape", () => {
    for (const k of EMAIL_KINDS) expect(keyMatchesKind(k, KEY[k])).toBe(true);
    expect(keyMatchesKind("review", "review:2026-13-1")).toBe(false);
    expect(keyMatchesKind("p0", "review:2026-10-19")).toBe(false);
    expect(keyMatchesKind("test", "test:2026-10-19:0")).toBe(false);
  });

  it("P0 only ever has the p0 slot; reserved slots belong to their own kinds", () => {
    expect(slotCandidates("p0")).toEqual(["p0"]);
    expect(slotCandidates("p0_batch")).toEqual(["p0"]);
    expect(slotCandidates("review")).toEqual(["reserved_review"]);
    expect(slotCandidates("incident_open")).toEqual(["reserved_incident", "pool"]);
    expect(melbourneDate(new Date("2026-10-18T14:00:00Z"))).toBe("2026-10-19");
  });

  it("an invalid key is refused before anything is written", async () => {
    const out = await sendEmail(ctx(), "review", "review:oops", FACTS.review);
    expect(out.status).toBe("invalid");
    expect(await rows()).toHaveLength(0);
    expect(mock.calls).toHaveLength(0);
  });
});

describe("email_mode matrix (design 4.12)", () => {
  it("off: nothing is sent and each attempt is recorded as suppressed_off", async () => {
    await setMode("off");
    for (const k of EMAIL_KINDS) expect((await send(k)).status).toBe("suppressed_off");
    expect(mock.calls).toHaveLength(0);
    const r = await rows("SELECT status, count(*) AS n FROM email_message GROUP BY status");
    expect(r.map((x) => [x.status, Number(x.n)])).toEqual([["suppressed_off", EMAIL_KINDS.length]]);
  });

  it("a missing switch reads as off", async () => {
    await db.execute("DELETE FROM worker_state");
    expect((await send("incident_open")).status).toBe("suppressed_off");
  });

  it("incidents: incident-class mail only; a review only on the test date or as the fallback", async () => {
    await setMode("incidents");
    const allowed = ["incident_open", "incident_s1", "tokens", "unread7", "dbdown"] as const;
    for (const k of EMAIL_KINDS) {
      const out = await send(k);
      expect(out.status, k).toBe(
        (allowed as readonly string[]).includes(k) ? "sent" : "suppressed_off",
      );
    }
    expect((await send("review", KEY.review, ctx(), { watchdogFallback: true })).status).toBe(
      "sent",
    );
  });

  it("incidents + the one-off test date lets exactly that review through", async () => {
    await setMode("incidents", D);
    expect((await send("review")).status).toBe("sent");
    await setMode("incidents", "2026-10-25");
    const later = await sendEmail(ctx(), "review", emailKeys.review("2026-10-20"), FACTS.review);
    expect(later.status).toBe("suppressed_off");
  });

  it("full: every kind renders and sends, to the Owner only", async () => {
    for (const k of EMAIL_KINDS) expect((await send(k)).status, k).toBe("sent");
    expect(mock.outbox).toHaveLength(EMAIL_KINDS.length);
    for (const m of mock.outbox) {
      expect(m.to).toBe(OWNER);
      expect(m.html.length).toBeGreaterThan(100);
      expect(m.text.length).toBeGreaterThan(20);
      expect(m.idempotencyKey.startsWith("production:")).toBe(true);
    }
  });

  it("a suppressed record does not use up the real key: the key sends after the switch is on", async () => {
    await setMode("off");
    expect((await send("review")).status).toBe("suppressed_off");
    await setMode("full");
    expect((await send("review")).status).toBe("sent");
  });

  it("the Evening Review pause suppresses the review only", async () => {
    await setConfig(db, {
      key: "evening_review_paused",
      value: "on",
      userId: null,
      now: T0.toISOString(),
    });
    expect((await send("review")).status).toBe("suppressed_paused");
    expect((await send("incident_open")).status).toBe("sent");
  });
});

describe("one email per key", () => {
  it("the same key twice sends once", async () => {
    expect((await send("review")).status).toBe("sent");
    const again = await send("review");
    expect(again.status).toBe("duplicate");
    expect(again.reason).toBe("sent");
    expect(mock.outbox).toHaveLength(1);
  });

  it("many concurrent calls for one key send once", async () => {
    const outs = await Promise.all(Array.from({ length: 8 }, () => send("p0")));
    expect(outs.filter((o) => o.status === "sent")).toHaveLength(1);
    expect(outs.filter((o) => o.status === "duplicate")).toHaveLength(7);
    expect(mock.outbox).toHaveLength(1);
  });

  it("two database connections racing for the last pool slot: exactly one wins", async () => {
    const url = tempDbUrl();
    const a = track(createClient({ url }));
    await migrateUp(a, await loadMigrations(MIGRATIONS("main")));
    const b = track(createClient({ url }));
    const caps = { ...(await loadCaps(a)), dailyCap: 5, reservedSlots: 3 }; // pool of 2
    const make = (i: number) =>
      claimKey(i % 2 ? a : b, {
        key: `dbdown:${D}:r${i}`,
        kind: "dbdown",
        env: "test",
        d: D,
        nowIso: T0.toISOString(),
        recipientSha: null,
        caps,
      });
    const res = await Promise.all(Array.from({ length: 10 }, (_, i) => make(i)));
    expect(res.filter((r) => r.kind === "claimed")).toHaveLength(2);
    expect(res.filter((r) => r.kind === "capped")).toHaveLength(8);
  });

  it("the same key from two connections claims once", async () => {
    const url = tempDbUrl();
    const a = track(createClient({ url }));
    await migrateUp(a, await loadMigrations(MIGRATIONS("main")));
    const b = track(createClient({ url }));
    const caps = await loadCaps(a);
    const p = (c: Client) =>
      claimKey(c, {
        key: KEY.review,
        kind: "review",
        env: "test",
        d: D,
        nowIso: T0.toISOString(),
        recipientSha: null,
        caps,
      });
    const res = await Promise.all([p(a), p(b), p(a), p(b)]);
    expect(res.filter((r) => r.kind === "claimed")).toHaveLength(1);
    expect(res.filter((r) => r.kind === "exists")).toHaveLength(3);
  });
});

describe("caps and reserved slots (NFR-006 l.21, EML-004, EML-020)", () => {
  const poolSend = (i: number) =>
    sendEmail(ctx(), "dbdown", emailKeys.dbdown(D, `s${i}`), FACTS.dbdown);

  it("12 P0 events: at most 10 send, the rest are suppressed_cap", async () => {
    const outs = [];
    for (let i = 1; i <= 12; i++) {
      outs.push(await sendEmail(ctx(), "p0", emailKeys.p0(`ann:AU:asx:${i}`), FACTS.p0));
    }
    expect(outs.filter((o) => o.status === "sent")).toHaveLength(10);
    expect(outs.slice(10).map((o) => o.status)).toEqual(["suppressed_cap", "suppressed_cap"]);
    const u = await emailUsage(db, "production", D);
    expect(u.p0Today).toBe(10);
    expect(u.suppressedCapToday).toBe(2);
  });

  it("3 reserved + 17 pool: the pool stops at 17, the reserved mail still goes out", async () => {
    for (let i = 1; i <= 17; i++) expect((await poolSend(i)).status).toBe("sent");
    expect((await poolSend(18)).status).toBe("suppressed_cap");
    expect((await send("review")).status).toBe("sent");
    expect((await send("reminder")).status).toBe("sent");
    expect((await send("incident_open")).status).toBe("sent"); // first incident: reserved slot
    expect((await send("incident_open", emailKeys.incidentOpen("i2"))).status).toBe(
      "suppressed_cap",
    ); // later incidents use the (full) pool
    const u = await emailUsage(db, "production", D);
    expect(u.today).toBe(20);
  });

  it("P0 never uses a reserved slot, even when the pool is full and the reserved are free", async () => {
    for (let i = 1; i <= 17; i++) await poolSend(i);
    const out = await sendEmail(ctx(), "p0", emailKeys.p0("ann:AU:asx:99"), FACTS.p0);
    expect(out.status).toBe("suppressed_cap");
    const slots = await rows("SELECT DISTINCT slot FROM email_message WHERE kind = 'p0'");
    expect(slots.map((x) => x.slot)).toEqual(["p0"]);
    expect((await send("review")).status).toBe("sent"); // the reserved slot is still free
  });

  it("P0 mail shares the pool: 10 P0 + 7 others fill it", async () => {
    for (let i = 1; i <= 10; i++) await sendEmail(ctx(), "p0", emailKeys.p0(`a${i}`), FACTS.p0);
    for (let i = 1; i <= 7; i++) expect((await poolSend(i)).status).toBe("sent");
    expect((await poolSend(8)).status).toBe("suppressed_cap");
  });

  it("the second email for a reserved review key is a duplicate, never a second slot", async () => {
    await send("review");
    expect((await send("review")).status).toBe("duplicate");
  });

  it("monthly cap: only reserved-slot kinds and S1 incidents still send", async () => {
    await setConfig(db, {
      key: "email_monthly_cap",
      value: 50,
      userId: null,
      now: T0.toISOString(),
    });
    for (let i = 0; i < 50; i++) {
      const day = String(1 + (i % 10)).padStart(2, "0");
      await db.execute({
        sql: `INSERT INTO email_message (email_key, env, kind, d, slot, status, sent_at, created_at)
              VALUES (?, 'production', 'dbdown', ?, 'pool', 'sent', 'x', 'x')`,
        args: [`dbdown:2026-10-${day}:f${i}`, `2026-10-${day}`],
      });
    }
    expect((await send("tokens")).status).toBe("suppressed_cap");
    expect((await send("p0")).status).toBe("suppressed_cap");
    expect((await send("review")).status).toBe("sent");
    expect((await send("reminder")).status).toBe("sent");
    expect((await send("incident_open")).status).toBe("sent"); // reserved
    expect((await send("incident_s1")).status).toBe("sent"); // S1 is exempt in the pool too
    expect((await send("incident_open", emailKeys.incidentOpen("i9"))).status).toBe(
      "suppressed_cap",
    );
  });

  it("failed rows count only after an accepted attempt", async () => {
    mock.script = [{ outcome: "rejected", httpStatus: 422 }];
    expect((await send("tokens")).status).toBe("failed");
    expect((await emailUsage(db, "production", D)).today).toBe(0);
  });

  it("a cap suppression is reported for the next review and is permanent for that key", async () => {
    for (let i = 1; i <= 17; i++) await poolSend(i);
    await poolSend(18);
    const r = await rows(
      "SELECT email_key, status FROM email_message WHERE status = 'suppressed_cap'",
    );
    expect(r).toHaveLength(1);
    expect((await poolSend(18)).status).toBe("duplicate");
  });
});

describe("retries, backoff and the attempts log (EML-030)", () => {
  const attempts = async (key: string) =>
    (
      await db.execute({
        sql: "SELECT n, outcome, http_status, provider_id FROM email_attempt WHERE email_key = ? ORDER BY n",
        args: [key],
      })
    ).rows;

  it("retryable then accepted: the second attempt follows after 2 s", async () => {
    mock.script = [{ outcome: "retryable", httpStatus: 503 }];
    const out = await send("tokens");
    expect(out).toMatchObject({ status: "sent", attempts: 2 });
    expect(sleeps).toEqual([2000]);
    const a = await attempts(KEY.tokens);
    expect(a.map((x) => x.outcome)).toEqual(["retryable", "accepted"]);
    expect(a[1].provider_id).toBe("mock-1");
    expect(a[0].provider_id).toBeNull();
    expect(mock.calls.map((c) => c.idempotencyKey)).toEqual([
      `production:${KEY.tokens}`,
      `production:${KEY.tokens}`,
    ]);
  });

  it("Retry-After up to 5 s is honoured in the request; longer waits for a later invocation", async () => {
    mock.script = [{ outcome: "retryable", httpStatus: 429, retryAfterS: 4 }];
    expect((await send("tokens")).status).toBe("sent");
    expect(sleeps).toEqual([4000]);

    sleeps.length = 0;
    mock.script = [{ outcome: "retryable", httpStatus: 429, retryAfterS: 30 }];
    const out = await send("unread7");
    expect(out).toMatchObject({ status: "pending", attempts: 1 });
    expect(sleeps).toEqual([]);
  });

  it("two failed attempts leave the row claimed; the third waits >= 60 s and uses the same key", async () => {
    mock.script = [{ outcome: "network" }, { outcome: "timeout" }];
    expect(await send("tokens")).toMatchObject({ status: "pending", attempts: 2 });
    expect((await rows("SELECT status, attempts FROM email_message"))[0]).toMatchObject({
      status: "claimed",
      attempts: 2,
    });

    clock = new Date(T0.getTime() + 30_000); // too early
    expect((await send("tokens")).status).toBe("duplicate");

    clock = new Date(T0.getTime() + 61_000);
    expect(await send("tokens")).toMatchObject({ status: "sent", attempts: 3 });
    expect((await attempts(KEY.tokens)).map((x) => x.outcome)).toEqual([
      "network",
      "timeout",
      "accepted",
    ]);
    expect(mock.outbox).toHaveLength(1);
  });

  it("the third failure ends as failed; a failed key is not retried again", async () => {
    mock.script = [{ outcome: "network" }, { outcome: "network" }, { outcome: "retryable" }];
    await send("tokens");
    clock = new Date(T0.getTime() + 61_000);
    expect(await send("tokens")).toMatchObject({ status: "failed", attempts: 3 });
    clock = new Date(T0.getTime() + 600_000);
    expect((await send("tokens")).status).toBe("duplicate");
    expect(mock.calls).toHaveLength(3);
  });

  it("rejected fails at once; 401 and 403 are flagged for the provider incident", async () => {
    mock.script = [{ outcome: "rejected", httpStatus: 422 }];
    expect(await send("tokens")).toMatchObject({ status: "failed", attempts: 1 });
    expect((await send("tokens")).authFailure).toBeUndefined();

    mock.script = [{ outcome: "rejected", httpStatus: 401 }];
    expect(await send("unread7")).toMatchObject({ status: "failed", authFailure: true });
    mock.script = [{ outcome: "rejected", httpStatus: 403 }];
    expect(await send("brief")).toMatchObject({ status: "failed", authFailure: true });
  });

  it("a crash after the provider accepted: the retry reuses the idempotency key, one email", async () => {
    let first = true;
    const crashing: EmailProvider = {
      name: "mock",
      async send(m) {
        const r = await mock.send(m);
        if (first) {
          first = false;
          throw new Error("connection reset after accept");
        }
        return r;
      },
    };
    const out = await send("tokens", KEY.tokens, ctx({ provider: crashing }));
    expect(out.status).toBe("sent");
    expect(mock.calls).toHaveLength(2);
    expect(mock.outbox).toHaveLength(1);
  });

  it("a stale claim is taken over once, by compare-and-swap", async () => {
    const caps = await loadCaps(db);
    await claimKey(db, {
      key: KEY.tokens,
      kind: "tokens",
      env: "production",
      d: D,
      nowIso: T0.toISOString(),
      recipientSha: null,
      caps,
    });
    clock = new Date(T0.getTime() + 60_000); // fresh: another invocation is probably still working
    expect((await send("tokens")).status).toBe("duplicate");
    clock = new Date(T0.getTime() + 181_000);
    const outs = await Promise.all([send("tokens"), send("tokens")]);
    expect(outs.map((o) => o.status).sort()).toEqual(["duplicate", "sent"]);
    expect(mock.outbox).toHaveLength(1);
  });

  it("a provider that throws an unexpected error counts as a network failure, not a crash", async () => {
    const bad: EmailProvider = {
      name: "mock",
      async send() {
        throw new Error("boom");
      },
    };
    const out = await send("tokens", KEY.tokens, ctx({ provider: bad }));
    expect(out).toMatchObject({ status: "pending", attempts: 2 });
  });
});

describe("recipient guard (EML-003b, EML-005, ROL-105)", () => {
  it("only the configured Owner address is accepted by the guard", async () => {
    const guarded = guardRecipient(mock, OWNER);
    const base = { from: "x", subject: "s", html: "h", text: "t", idempotencyKey: "k" };
    expect(() => guarded.send({ ...base, to: "other@example.test" })).toThrow(RecipientGuardError);
    expect((await guarded.send({ ...base, to: " Owner@Example.test " })).outcome).toBe("accepted");
  });

  it("the sender always addresses the Owner and never stores or hashes the address in the clear", async () => {
    await send("tokens");
    expect(mock.calls.every((c) => c.to === OWNER)).toBe(true);
    const dump = JSON.stringify([
      await rows(),
      await rows("SELECT * FROM email_attempt"),
    ]).toLowerCase();
    expect(dump).not.toContain("owner@example");
    const sha = String((await rows())[0].recipient_sha);
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a missing or malformed OWNER_EMAIL is no_recipient, never a failure (EML-006)", async () => {
    for (const bad of [
      undefined,
      "",
      "not-an-address",
      "a@b.test, c@d.test",
      "a@b.test\nBcc: x@y.test",
    ]) {
      const out = await sendEmail(
        ctx({ env: { ...ENV, OWNER_EMAIL: bad } }),
        "tokens",
        KEY.tokens,
        FACTS.tokens,
      );
      expect(out.status).toBe("no_recipient");
    }
    expect(mock.calls).toHaveLength(0);
    expect(ownerAddress({ OWNER_EMAIL: "Owner@Example.test" })).toBe(OWNER);
    // once the address is set the same key sends
    expect((await send("tokens")).status).toBe("sent");
  });

  it("the guard failure is not swallowed as a network error", async () => {
    const wrong: EmailProvider = { name: "mock", send: async () => ({ outcome: "accepted" }) };
    const swapped = guardRecipient(wrong, "someone-else@example.test");
    await expect(send("tokens", KEY.tokens, ctx({ provider: swapped }))).rejects.toThrow(
      RecipientGuardError,
    );
    expect((await rows())[0].status).toBe("failed");
  });
});

describe("staging prefix and environments (EML-004, NFR-040)", () => {
  it("every staging subject starts with [STAGING] and counts in its own environment", async () => {
    const c = ctx({ env: { ...ENV, PRAXIS_ENV: "staging" } });
    for (const k of EMAIL_KINDS) expect((await send(k, KEY[k], c)).status, k).toBe("sent");
    for (const m of mock.outbox) expect(m.subject.startsWith("[STAGING] ")).toBe(true);
    expect(mock.outbox.every((m) => m.idempotencyKey.startsWith("staging:"))).toBe(true);
    const r = await rows("SELECT DISTINCT env FROM email_message");
    expect(r.map((x) => x.env)).toEqual(["staging"]);
    const subj = await rows("SELECT subject FROM email_message WHERE subject <> ''");
    expect(subj.every((x) => String(x.subject).startsWith("[STAGING] "))).toBe(true);
  });

  it("production subjects carry no prefix", async () => {
    await send("tokens");
    expect(mock.outbox[0].subject.startsWith("[STAGING]")).toBe(false);
  });

  it("staging selects the mock, except one live email per process with EMAIL_LIVE=1", async () => {
    resetStagingLiveSlot();
    const live = vi.fn(async () => new Response(JSON.stringify({ id: "re_1" }), { status: 200 }));
    const stagingMock = createMockProvider();
    const env = {
      EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: "re_placeholder",
      PRAXIS_ENV: "staging",
    };
    const off = selectProvider(env, {
      fetchImpl: live as unknown as typeof fetch,
      mock: stagingMock,
    });
    expect(off).toBe(stagingMock);

    const p = selectProvider(
      { ...env, EMAIL_LIVE: "1" },
      { fetchImpl: live as unknown as typeof fetch, mock: stagingMock },
    );
    const m = {
      from: "f",
      to: OWNER,
      subject: "[STAGING] s",
      html: "h",
      text: "t",
      idempotencyKey: "k1",
    };
    expect((await p.send(m)).providerId).toBe("re_1");
    expect((await p.send({ ...m, idempotencyKey: "k2" })).providerId).toBe("mock-1");
    expect(live).toHaveBeenCalledTimes(1);
    resetStagingLiveSlot();
  });
});

describe("Resend adapter error paths (fetch is a local stub)", () => {
  const msg = {
    from: "Praxis <onboarding@resend.dev>",
    to: OWNER,
    subject: "s",
    html: "<p>h</p>",
    text: "t",
    idempotencyKey: "production:tokens:2026-10-19",
  };
  const make = (f: (url: string, init: RequestInit) => Promise<Response>, timeoutMs?: number) =>
    createResendProvider({
      apiKey: "re_placeholder",
      fetchImpl: f as unknown as typeof fetch,
      timeoutMs,
    });

  it("posts to Resend with the key, the Idempotency-Key header and a one-element to list", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const p = make(async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify({ id: "re_abc" }), { status: 200 });
    });
    expect(await p.send(msg)).toEqual({
      outcome: "accepted",
      providerId: "re_abc",
      httpStatus: 200,
    });
    expect(seen!.url).toBe(RESEND_URL);
    const h = seen!.init.headers as Record<string, string>;
    expect(h["Idempotency-Key"]).toBe(msg.idempotencyKey);
    expect(h.Authorization).toBe("Bearer re_placeholder");
    const body = JSON.parse(String(seen!.init.body));
    expect(body.to).toEqual([OWNER]);
    expect(body.from).toBe("Praxis <onboarding@resend.dev>");
  });

  it("maps statuses: 429/409/5xx retryable, other 4xx rejected", async () => {
    const answer = (status: number, headers: Record<string, string> = {}) =>
      make(async () => new Response("{}", { status, headers })).send(msg);
    expect(await answer(429, { "Retry-After": "3" })).toEqual({
      outcome: "retryable",
      httpStatus: 429,
      retryAfterS: 3,
    });
    expect((await answer(409)).outcome).toBe("retryable");
    expect((await answer(500)).outcome).toBe("retryable");
    expect((await answer(503)).outcome).toBe("retryable");
    for (const s of [400, 401, 403, 404, 422]) {
      expect(await answer(s)).toEqual({ outcome: "rejected", httpStatus: s });
    }
  });

  it("network error, timeout and an unreadable 200", async () => {
    expect(
      (await make(async () => Promise.reject(new TypeError("fetch failed"))).send(msg)).outcome,
    ).toBe("network");
    const hang = make(
      (_u, init) =>
        new Promise((_res, rej) => {
          init.signal!.addEventListener("abort", () =>
            rej(new DOMException("aborted", "AbortError")),
          );
        }),
      20,
    );
    expect((await hang.send(msg)).outcome).toBe("timeout");
    const odd = await make(async () => new Response("not json", { status: 200 })).send(msg);
    expect(odd).toEqual({ outcome: "accepted", providerId: undefined, httpStatus: 200 });
  });

  it("a very long email key is hashed to fit the header limit", () => {
    expect(idempotencyHeader("a".repeat(256))).toHaveLength(256);
    expect(idempotencyHeader("a".repeat(300))).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("flows through sendEmail: 429 with a long Retry-After leaves the row pending", async () => {
    const f = vi.fn(
      async () => new Response("{}", { status: 429, headers: { "Retry-After": "30" } }),
    );
    const p = createResendProvider({
      apiKey: "re_placeholder",
      fetchImpl: f as unknown as typeof fetch,
    });
    const out = await send("tokens", KEY.tokens, ctx({ provider: p }));
    expect(out).toMatchObject({ status: "pending", attempts: 1 });
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("no-live-send guard (D-096 decision 44)", () => {
  it("a fetch to api.resend.com from a test throws", () => {
    expect(() => fetch(`https://${RESEND_HOST}/emails`, { method: "POST" })).toThrow(
      LiveSendBlockedError,
    );
    expect(() => fetch(new URL(RESEND_URL))).toThrow(LiveSendBlockedError);
  });

  it("the Resend adapter without an injected fetch refuses to send in a test run", async () => {
    const p = createResendProvider({ apiKey: "re_placeholder" });
    await expect(
      p.send({ from: "f", to: OWNER, subject: "s", html: "h", text: "t", idempotencyKey: "k" }),
    ).rejects.toThrow(LiveSendBlockedError);
  });

  it("EMAIL_PROVIDER=resend in a test run selects the mock; unset or unknown selects null", async () => {
    const env = { EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_placeholder", VITEST: "true" };
    expect(selectProvider(env).name).toBe("mock");
    expect(selectProvider({}).name).toBe("null");
    expect(selectProvider({ EMAIL_PROVIDER: "smtp" })).toBe(NULL_PROVIDER);
    const noKey = selectProvider(
      { EMAIL_PROVIDER: "resend" },
      { fetchImpl: (async () => new Response()) as typeof fetch },
    );
    expect(noKey).toBe(NULL_PROVIDER); // no key: unavailable, never a failure
  });

  it("sendEmail with the resend setting in a test never touches the network", async () => {
    const c = ctx({
      provider: undefined,
      env: { ...ENV, EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_placeholder" },
    });
    expect((await send("tokens", KEY.tokens, c)).status).toBe("sent");
  });

  it("the null provider never sends: the attempt is recorded as suppressed_off", async () => {
    const out = await send("tokens", KEY.tokens, ctx({ provider: NULL_PROVIDER }));
    expect(out).toMatchObject({ status: "suppressed_off", reason: "provider_null" });
    expect(mock.calls).toHaveLength(0);
  });

  it("a missing APP_BASE_URL is treated as unavailable, not as a failure", async () => {
    const out = await send("tokens", KEY.tokens, ctx({ env: { ...ENV, APP_BASE_URL: undefined } }));
    expect(out).toMatchObject({ status: "suppressed_off", reason: "no_app_url" });
  });
});
