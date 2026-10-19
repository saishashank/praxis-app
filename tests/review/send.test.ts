// @vitest-environment node
// Evening Review send loop (M5 T10; docs/M5_design.md 4.6 item 3; EML-010/011/036, NFR-006, AT-20;
// D-096 decisions 5, 12, 33; D-099, D-104, D-106): every state of the loop (waiting, partial, late,
// complete later, paused, no recipient, switched off), one email per date across the route and the
// watchdog's direct fallback, the unread-3 subject, the unread-7 incident once, DST local times.
// Mock provider only; synthetic data; the real Resend API is never reached.
import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setConfig } from "@/lib/config/store";
import { createMockProvider, type MockProvider } from "@/lib/email/mock";
import { markRead } from "@/lib/review/assemble";
import { melbourneMinute, runReviewSend, type ReviewSendCtx } from "@/lib/review/send";
import { sendFallbackReview } from "@/lib/watchdog/script";
import { cleanupTempDbs } from "../db/helpers";
import { APP, D, SAT, addMarker, exec, mainWorld, tradingDay } from "./helpers";

afterEach(cleanupTempDbs);

const OWNER = "owner@example.test";
const ENV = {
  EMAIL_PROVIDER: "mock",
  OWNER_EMAIL: OWNER,
  APP_BASE_URL: APP,
  PII_HASH_KEY: "k".repeat(64),
  PRAXIS_ENV: "production",
} as Record<string, string | undefined>;

let db: Client;
let mock: MockProvider;
let clock: Date;

/** Melbourne local time on a date as a UTC instant (offset 11 = AEDT, 10 = AEST). */
const local = (date: string, hhmm: string, offset = 11): Date => {
  const [h, m] = hhmm.split(":").map(Number);
  const [y, mo, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, mo! - 1, d!, h! - offset, m!));
};
const at = (hhmm: string, date = D) => {
  clock = local(date, hhmm);
};

const ctx = (over: Partial<ReviewSendCtx> = {}): ReviewSendCtx => ({
  db,
  env: ENV,
  now: () => clock,
  provider: mock,
  sleep: async () => {},
  ...over,
});
const run = (date = D, over: Partial<ReviewSendCtx> = {}) => runReviewSend(ctx(over), date);

async function putState(key: string, value: string) {
  await db.execute({
    sql: `INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, ?, 'x')
          ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
    args: [key, JSON.stringify(value)],
  });
}
const setMode = (mode: string, testDate?: string) =>
  putState("email_mode", mode).then(() =>
    testDate ? putState("email_review_test_date", testDate) : null,
  );

const count = async (sql: string, args: (string | number)[] = []) =>
  Number((await db.execute({ sql, args })).rows[0]!.n);
const versions = (d = D) => count("SELECT COUNT(*) AS n FROM evening_review WHERE d = ?", [d]);
const msg = async (key: string) =>
  (await db.execute({ sql: "SELECT * FROM email_message WHERE email_key = ?", args: [key] }))
    .rows[0];

/** Earlier reviews stored and never read (EML-036). */
async function seedUnread(dates: string[]) {
  for (const d of dates) {
    await exec(
      db,
      `INSERT INTO evening_review (d, version, kind, missing_json, facts_json, facts_sha, html, text,
         markdown, size_html, narrative, created_at)
       VALUES (?, 1, 'full', '[]', '{}', ?, '<p>x</p>', 'x', 'x', 8, 'rules', ?)`,
      [d, createHash("sha256").update(d).digest("hex"), `${d}T09:00:00.000Z`],
    );
  }
}
const DAYS_7 = [
  "2026-10-09",
  "2026-10-10",
  "2026-10-11",
  "2026-10-12",
  "2026-10-13",
  "2026-10-14",
  "2026-10-15",
];

beforeEach(async () => {
  db = await mainWorld();
  mock = createMockProvider();
  await setMode("full");
  at("20:00");
});

describe("a complete trading day", () => {
  beforeEach(async () => {
    await tradingDay(db);
  });

  it("sends one full review at 20:00 and stores version 1", async () => {
    const r = await run();
    expect(r).toMatchObject({ ok: true, status: "sent", kind: "full", version: 1, partial: false });
    expect(r.late).toBe(false);
    expect(mock.outbox).toHaveLength(1);
    expect(mock.outbox[0]!.to).toBe(OWNER);
    expect(mock.outbox[0]!.subject).toContain("Evening Review");
    expect(mock.outbox[0]!.subject).not.toContain("UNREAD");
    expect((await msg(`review:${D}`))!.status).toBe("sent");
    expect(await versions()).toBe(1);
  });

  it("twice in a row (every 5 minutes) is one email", async () => {
    expect((await run()).status).toBe("sent");
    at("20:05");
    const again = await run();
    expect(again).toMatchObject({ ok: true, status: "already_sent", partial: false });
    at("20:10");
    expect((await run()).status).toBe("already_sent");
    expect(mock.outbox).toHaveLength(1);
    expect(await versions()).toBe(1);
  });

  it("is waiting before the review time and stores nothing", async () => {
    at("19:59");
    const r = await run();
    expect(r).toMatchObject({ ok: true, status: "waiting", reason: "early", version: null });
    expect(await versions()).toBe(0);
    expect(mock.calls).toHaveLength(0);
  });

  it("after 20:45 a complete review is late (counted, never an incident, decision 33)", async () => {
    at("20:50");
    const r = await run();
    expect(r).toMatchObject({ status: "sent", kind: "full", late: true, partial: false });
    expect(await count("SELECT COUNT(*) AS n FROM incident")).toBe(0);
  });

  it("a run after midnight keeps the review date and is late", async () => {
    at("00:10", "2026-10-20");
    const r = await run(D);
    expect(r).toMatchObject({ status: "sent", d: D, late: true });
    expect((await msg(`review:${D}`))!.status).toBe("sent");
  });
});

describe("partial, then complete later", () => {
  it("no marker: waits until 20:30, then sends the partial with the missing sections", async () => {
    for (const t of ["20:00", "20:15", "20:25"]) {
      at(t);
      expect(await run()).toMatchObject({ ok: true, status: "waiting", reason: "inputs_missing" });
    }
    expect(await versions()).toBe(0);
    expect(mock.calls).toHaveLength(0);
    at("20:30");
    const r = await run();
    expect(r).toMatchObject({ status: "sent", kind: "partial", partial: true, late: false });
    expect(mock.outbox).toHaveLength(1);
    expect(mock.outbox[0]!.text).toMatch(/Headline scorecard/);
    expect(
      (await db.execute("SELECT missing_json FROM evening_review")).rows[0]!.missing_json,
    ).toContain("Headline scorecard");
  });

  it("a partial sent at 20:50 is also late", async () => {
    at("20:50");
    expect(await run()).toMatchObject({ status: "sent", kind: "partial", late: true });
  });

  it("the complete version is stored later and not sent again (EML-011)", async () => {
    at("20:30");
    expect((await run()).kind).toBe("partial");
    await tradingDay(db); // the nightly inputs arrive late
    at("21:00");
    const r = await run();
    expect(r).toMatchObject({
      ok: true,
      status: "complete_later",
      kind: "full",
      version: 2,
      partial: true,
    });
    expect(mock.outbox).toHaveLength(1);
    expect(await versions()).toBe(2);
    at("21:15");
    expect(await run()).toMatchObject({ status: "already_sent", version: 2 });
    expect(await versions()).toBe(2);
    expect(mock.outbox).toHaveLength(1);
  });

  it("data-only mode is never partial: sent at 20:00", async () => {
    await exec(db, "UPDATE market SET mode = 'data_only' WHERE code = 'AU'");
    expect(await run()).toMatchObject({ status: "sent", kind: "full" });
  });
});

describe("non-trading days (decision 5)", () => {
  it("a Saturday with the non-trading marker sends at 20:00 with all ten headings", async () => {
    await addMarker(db, SAT, "non-trading");
    at("20:00", SAT);
    const r = await run(SAT);
    expect(r).toMatchObject({ status: "sent", kind: "non_trading", partial: false });
    expect(mock.outbox).toHaveLength(1);
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
      expect(mock.outbox[0]!.text).toContain(`${n}.`);
  });

  it("a Saturday without the marker waits for it until 20:30, then sends the non-trading form", async () => {
    at("20:10", SAT);
    expect(await run(SAT)).toMatchObject({ status: "waiting", reason: "inputs_missing" });
    at("20:30", SAT);
    expect(await run(SAT)).toMatchObject({ status: "sent", kind: "non_trading" });
    expect(mock.outbox).toHaveLength(1);
  });

  it("the marker arriving in time sends earlier", async () => {
    at("20:10", SAT);
    expect((await run(SAT)).status).toBe("waiting");
    await addMarker(db, SAT, "non-trading");
    at("20:15", SAT);
    expect(await run(SAT)).toMatchObject({ status: "sent", kind: "non_trading" });
  });
});

describe("pause, recipient and the production switch", () => {
  beforeEach(async () => {
    await tradingDay(db);
  });

  it("paused: stored in the app, no email, status paused; unpausing sends", async () => {
    await setConfig(db, {
      key: "evening_review_paused",
      value: "on",
      userId: null,
      now: clock.toISOString(),
    });
    const r = await run();
    expect(r).toMatchObject({ ok: true, status: "paused", kind: "full", version: 1 });
    expect(mock.calls).toHaveLength(0);
    expect((await msg(`review:${D}~paused`))!.status).toBe("suppressed_paused");
    expect(await msg(`review:${D}`)).toBeUndefined();
    await setConfig(db, {
      key: "evening_review_paused",
      value: "off",
      userId: null,
      now: clock.toISOString(),
    });
    at("20:05");
    expect((await run()).status).toBe("sent");
    expect(mock.outbox).toHaveLength(1);
  });

  it("no recipient: stored, no email, the real key stays free", async () => {
    const r = await run(D, { env: { ...ENV, OWNER_EMAIL: undefined } });
    expect(r).toMatchObject({ ok: true, status: "no_recipient", version: 1 });
    expect(mock.calls).toHaveLength(0);
    expect((await msg(`review:${D}~no_recipient`))!.status).toBe("no_recipient");
    at("20:05");
    expect((await run()).status).toBe("sent");
  });

  it("email_mode off (the default): stored, suppressed_off, no unread incident", async () => {
    await db.execute("DELETE FROM worker_state");
    await seedUnread(DAYS_7);
    const r = await run();
    expect(r).toMatchObject({ ok: true, status: "suppressed_off" });
    expect(mock.calls).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS n FROM incident")).toBe(0);
  });

  it("incidents mode sends the review only on the one-off test date", async () => {
    await setMode("incidents");
    expect((await run()).status).toBe("suppressed_off");
    await setMode("incidents", D);
    at("20:05");
    expect((await run()).status).toBe("sent");
    expect(mock.outbox).toHaveLength(1);
  });

  it("no APP_BASE_URL: nothing is stored or sent", async () => {
    const r = await run(D, { env: { ...ENV, APP_BASE_URL: undefined } });
    expect(r).toMatchObject({ status: "suppressed_off", reason: "no_app_url", version: null });
    expect(await versions()).toBe(0);
  });
});

describe("one email per date across the route and the watchdog fallback (decision 12)", () => {
  beforeEach(async () => {
    await tradingDay(db);
  });

  it("route first, then the watchdog's direct fallback: a duplicate, never a second email", async () => {
    expect((await run()).status).toBe("sent");
    at("20:40");
    const fb = await sendFallbackReview(
      { db, env: ENV, now: () => clock, provider: mock },
      D,
      "route down",
    );
    expect(fb.status).toBe("duplicate");
    expect(mock.outbox).toHaveLength(1);
  });

  it("fallback first, then the route: the route stores the full version and sends nothing", async () => {
    at("20:40");
    const fb = await sendFallbackReview(
      { db, env: ENV, now: () => clock, provider: mock },
      D,
      "route down",
    );
    expect(fb.status).toBe("sent");
    expect(mock.outbox[0]!.subject.toLowerCase()).toContain("minimal");
    at("20:45");
    const r = await run();
    expect(r).toMatchObject({ ok: true, status: "complete_later", kind: "full", version: 1 });
    expect(mock.outbox).toHaveLength(1);
    expect(await versions()).toBe(1);
  });

  it("two concurrent calls send once", async () => {
    const [a, b] = await Promise.all([run(), run()]);
    expect([a.status, b.status].sort()).toEqual(["already_sent", "sent"].sort());
    expect(mock.outbox).toHaveLength(1);
  });
});

describe("provider failures", () => {
  beforeEach(async () => {
    await tradingDay(db);
  });

  it("a rejected send fails at once, the next tick reports failed and does not retry", async () => {
    mock.script = [{ outcome: "rejected", httpStatus: 422 }];
    const r = await run();
    expect(r).toMatchObject({ ok: false, status: "failed", reason: "rejected" });
    at("20:05");
    expect(await run()).toMatchObject({ ok: false, status: "failed", reason: "key_consumed" });
    expect(mock.outbox).toHaveLength(0);
    expect(await versions()).toBe(1);
  });

  it("401 opens the provider incident", async () => {
    mock.script = [{ outcome: "rejected", httpStatus: 401 }];
    await run();
    const inc = await db.execute("SELECT kind, severity FROM incident");
    expect(inc.rows.map((x) => String(x.kind))).toContain("provider_auth");
  });

  it("retryable twice, then a tick 61 s later sends", async () => {
    mock.script = [
      { outcome: "retryable", httpStatus: 503 },
      { outcome: "retryable", httpStatus: 503 },
    ];
    expect((await run()).status).toBe("pending");
    clock = new Date(clock.getTime() + 61_000);
    expect((await run()).status).toBe("sent");
    expect(mock.outbox).toHaveLength(1);
  });
});

describe("unread tracking (EML-036, NFR-006)", () => {
  beforeEach(async () => {
    await tradingDay(db);
  });

  it("three unread earlier reviews put UNREAD 3 DAYS in the subject", async () => {
    await seedUnread(["2026-10-14", "2026-10-15", "2026-10-16"]);
    const r = await run();
    expect(r.status).toBe("sent");
    expect(r.unread).toMatchObject({ days: 3, incident: "none" });
    expect(mock.outbox[0]!.subject).toContain("UNREAD 3 DAYS");
    expect(mock.outbox).toHaveLength(1);
  });

  it("two unread days or a read newest review: no prefix", async () => {
    await seedUnread(["2026-10-15", "2026-10-16"]);
    await run();
    expect(mock.outbox[0]!.subject).not.toContain("UNREAD");
  });

  it("seven unread days open the incident and send the one unread7 email", async () => {
    await seedUnread(DAYS_7);
    const r = await run();
    expect(r.status).toBe("sent");
    expect(r.unread).toMatchObject({ days: 7, incident: "opened" });
    const inc = await db.execute("SELECT severity, kind, resolved_at FROM incident");
    expect(inc.rows).toHaveLength(1);
    expect(inc.rows[0]).toMatchObject({
      kind: "review_unread_7",
      severity: "S3",
      resolved_at: null,
    });
    expect(mock.outbox.map((m) => m.subject)).toEqual([
      expect.stringContaining("UNREAD 3 DAYS"),
      expect.stringContaining("unread for 7 days"),
    ]);
    expect((await msg(`unread7:${D}`))!.status).toBe("sent");
  });

  it("the incident and its email happen once while the streak lasts; reading closes it", async () => {
    await seedUnread(DAYS_7);
    await run();
    // the next day: the streak is 8 (the earlier review is still unread)
    at("20:30", "2026-10-20");
    const next = await run("2026-10-20");
    expect(next.status).toBe("sent");
    expect(next.unread).toMatchObject({ incident: "open" });
    expect(await count("SELECT COUNT(*) AS n FROM incident WHERE kind = 'review_unread_7'")).toBe(
      1,
    );
    expect(await count("SELECT COUNT(*) AS n FROM email_message WHERE kind = 'unread7'")).toBe(1);
    // the Owner reads the latest review: the streak falls below seven and the incident closes
    for (const d of [...DAYS_7, D, "2026-10-20"]) await markRead(db, d, "page", clock);
    at("20:30", "2026-10-21");
    const third = await run("2026-10-21");
    expect(third.unread).toMatchObject({ days: 0, incident: "closed" });
    expect(
      (await db.execute("SELECT resolved_at FROM incident WHERE kind = 'review_unread_7'")).rows[0]!
        .resolved_at,
    ).not.toBeNull();
  });
});

describe("Melbourne local minute (DST)", () => {
  it("is 20:00 at 09:00Z in AEDT and 10:00Z in AEST, on both sides of both changes", () => {
    const cases: [string, string][] = [
      ["2026-10-03T10:00:00Z", "AEST Saturday before the October change"],
      ["2026-10-04T09:00:00Z", "AEDT Sunday after it"],
      ["2026-10-05T09:00:00Z", "AEDT Monday"],
      ["2027-04-03T09:00:00Z", "AEDT Saturday before the April change"],
      ["2027-04-04T10:00:00Z", "AEST Sunday after it"],
      ["2027-04-05T10:00:00Z", "AEST Monday"],
    ];
    for (const [iso, why] of cases) expect(melbourneMinute(new Date(iso)), why).toBe(20 * 60);
    // a send at 20:30 local is partial_at on every one of them
    expect(melbourneMinute(new Date("2026-10-04T09:30:00Z"))).toBe(20 * 60 + 30);
    expect(melbourneMinute(new Date("2027-04-04T10:30:00Z"))).toBe(20 * 60 + 30);
  });

  it("the review date never shifts: 20:00 local on a changeover Sunday is that Sunday's review", async () => {
    const sun = "2026-10-04"; // AEDT begins 02:00; a non-trading day
    await addMarker(db, sun, "non-trading");
    clock = new Date("2026-10-04T09:00:00Z"); // 20:00 AEDT
    const r = await run(sun);
    expect(r).toMatchObject({ status: "sent", d: sun, kind: "non_trading" });
    const apr = "2027-04-04"; // AEST begins 03:00
    await addMarker(db, apr, "non-trading");
    clock = new Date("2027-04-04T10:00:00Z"); // 20:00 AEST
    expect(await run(apr)).toMatchObject({ status: "sent", d: apr });
  });
});
