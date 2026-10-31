// @vitest-environment node
// M17 WP4 (AT-62 c d e, AT-60 b; EML-038..042, D-388/D-389, D-448..D-455): fixtures render with the
// subject prefixes, "delayed", the latency line and no LLM or broker text; one mail per pick per
// session; the own cap (13th suppressed) never touches the P0 slot; tick batching; quiet-hours hold
// and digest; a window ending after 16:00 goes to Evening Review section 9; preferences and staging.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activeAlerts, alertIdOf, insertTransition } from "@/lib/alerts/pick/store";
import type { AlertRow, MailerCtx } from "@/lib/alerts/pick/types";
import { claimKey, loadCaps } from "@/lib/email/caps";
import { emailKeys, slotCandidates } from "@/lib/email/keys";
import { createMockProvider, type MockProvider } from "@/lib/email/mock";
import {
  createPickMailer,
  itemOf,
  mailNewCandidates,
  pickCapRemaining,
  sendPickMail,
  type PickItem,
  type PickMailCtx,
} from "@/lib/email/pickMail";
import {
  renderPickBatch,
  renderPickCandidate,
  renderPickCleared,
  renderPickDigest,
  renderPickHit,
} from "@/lib/email/templates";
import { readPickReview, type Ctx } from "@/lib/review/sections";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import * as fx from "../fixtures/email/facts";

afterEach(cleanupTempDbs);

const T1045 = new Date("2026-11-03T23:45:00.000Z"); // Wed 4 Nov 2026 10:45 AEDT
const T1105 = new Date("2026-11-04T00:05:00.000Z"); // 11:05 AEDT
const SESSION = "2026-11-04";
const SHA = "a".repeat(64);
const ENV = {
  EMAIL_PROVIDER: "mock",
  OWNER_EMAIL: "owner@example.test",
  APP_BASE_URL: fx.APP,
  PII_HASH_KEY: "k".repeat(64),
  PRAXIS_ENV: "production",
} as Record<string, string | undefined>;

let db: Client;
let auth: Client;
let mock: MockProvider;
let clock: Date;

const ctx = (over: Partial<PickMailCtx> = {}): PickMailCtx => ({
  db,
  auth,
  env: ENV,
  now: () => clock,
  provider: mock,
  sleep: async () => {},
  ...over,
});
const mctx = (slot = "1045"): MailerCtx => ({
  db,
  now: clock,
  market: "AU",
  sessionD: SESSION,
  slot,
});
const scalar = async (c: Client, sql: string): Promise<number> =>
  Number((await c.execute(sql)).rows[0].n);

const profileOf = (i: number) => `P${Math.ceil(i / 10)}`;
const rankOf = (i: number) => ((i - 1) % 10) + 1;

async function seedPick(i: number): Promise<{ code: string; alertId: string }> {
  const code = `ZZ${String(i).padStart(2, "0")}`;
  await db.execute({
    sql: `INSERT INTO pick (market, d, profile, rank, code, family, tier, rule_version, signal_id, label,
            reference_micro, buy_max_micro, valid_until_d, stop_micro, aim_micro, n_similar, size_micro,
            risk_micro, factors_json, based_on_json, pick_sha, created_at)
          VALUES ('AU', '2026-11-03', ?, ?, ?, 'F1', 'U1', 'F1.v1', ?, ?, 10000000, 10000000, '2026-11-12',
            9000000, 11000000, 50, 2000000000, 100000000, '[]', '[]', ?, '2026-11-03T07:10:00.000Z')`,
    args: [profileOf(i), rankOf(i), code, `sig-${code}`, `Synthetic ${code}`, SHA],
  });
  return { code, alertId: alertIdOf("1", "AU", "2026-11-03", profileOf(i), rankOf(i)) };
}

async function transition(
  i: number,
  kind: "hit" | "below_stop" | "above_chase_cap" | "halted",
): Promise<string> {
  const { code, alertId } = await seedPick(i);
  const base: AlertRow = {
    alertId,
    seq: 1,
    userId: "1",
    market: "AU",
    pickD: "2026-11-03",
    profile: profileOf(i),
    rank: rankOf(i),
    code,
    sessionD: SESSION,
    state: "armed",
    limitMicro: 10_000_000n,
    stopMicro: 9_000_000n,
    at: clock.toISOString(),
    hitMicro: null,
    quoteAt: null,
    clearReason: null,
  };
  await insertTransition(db, base);
  const at = new Date(clock.getTime() + 1000).toISOString();
  await insertTransition(
    db,
    kind === "hit"
      ? { ...base, seq: 2, state: "hit", at, hitMicro: 9_950_000n, quoteAt: clock.toISOString() }
      : { ...base, seq: 2, state: "cleared", at, quoteAt: clock.toISOString(), clearReason: kind },
  );
  return alertId;
}

async function setPrefs(prefs: Record<string, unknown>): Promise<void> {
  await auth.execute({
    sql: "INSERT OR REPLACE INTO user_preference (user_id, prefs_json, updated_at) VALUES (1, ?, 't')",
    args: [JSON.stringify(prefs)],
  });
}
const setQuiet = (start: string, end: string) => setPrefs({ quiet_hours: { start, end } });

const mailRows = async () =>
  (await db.execute("SELECT kind, status FROM pick_alert_mail ORDER BY id")).rows.map(
    (r) => `${String(r.kind)}:${String(r.status)}`,
  );

beforeEach(async () => {
  db = await freshDb("main");
  auth = await freshDb("auth");
  mock = createMockProvider();
  clock = T1045;
  await db.execute(
    `INSERT INTO worker_state (key, value_json, updated_at) VALUES ('email_mode', '"full"', 't')`,
  );
  await auth.execute(
    "INSERT INTO app_user (id, email, role, status, created_at, updated_at) VALUES (1, 'owner@example.test', 'owner', 'active', 't', 't')",
  );
});

describe("templates (TST-129 fixtures, EML-038/039/040, NFR-041)", () => {
  const base = { env: "production" as const, appUrl: fx.APP };
  const outs = () => [
    renderPickHit({ ...base, facts: fx.PICK_HIT }),
    renderPickCleared({ ...base, facts: fx.PICK_CLEARED_BELOW }),
    renderPickCleared({ ...base, facts: fx.PICK_CLEARED_CAP }),
    renderPickCandidate({ ...base, facts: fx.PICK_CANDIDATE }),
    renderPickBatch({ ...base, window: "10:45", lines: fx.PICK_LINES }),
    renderPickDigest({ ...base, quietWindow: "22:00-07:00", lines: fx.PICK_LINES }),
  ];

  it("subjects carry the prefix, the code and (delayed)", () => {
    const [hit, below, cap, cand, batch, digest] = outs();
    expect(hit.subject).toBe("[Praxis] Buy price hit — ZZ01 (delayed)");
    expect(below.subject).toMatch(/^\[Praxis\] Pick cleared — ZZ02 .*\(delayed\)$/);
    expect(cap.subject).toMatch(/^\[Praxis\] Pick cleared — ZZ03 ran above its limit/);
    expect(cand.subject).toBe("[Praxis] Attention needed — ZZ04 found 11:42 (intraday, delayed)");
    expect(batch.subject).toBe("[Praxis] 3 pick alerts — ZZ01 and others (delayed)");
    expect(digest.subject).toMatch(/^\[Praxis\] Pick alerts held in quiet hours/);
  });

  it("every mail says delayed, shows the latency line and quote time; no real-time, no LLM, no broker link", () => {
    for (const o of outs()) {
      expect(o.text).toContain("delayed");
      expect(o.text).toContain("up to about 20 + 5 minutes after the trade");
      expect(o.text).toContain("Wed 4 Nov 2026 1");
      expect(`${o.html}${o.text}`).not.toMatch(/real[- ]?time/i);
      expect(o.text).toContain("Template text only; no AI wording");
      const hrefs = [...o.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
      for (const h of hrefs) expect(h.startsWith(fx.APP), h).toBe(true);
      expect(o.oversize).toBe(false);
    }
  });

  it("hit mail has the own-stop line and the simulated footer; candidate says Unvalidated stream", () => {
    const [hit, , , cand] = outs();
    expect(hit.text).toContain("Place your own stop with your broker");
    expect(hit.text).toContain("Simulation for personal information only");
    expect(cand.text).toContain("Unvalidated stream");
    expect(cand.text).toContain("G01, G02, G08");
  });

  it("staging subjects are prefixed", () => {
    const o = renderPickHit({ env: "staging", appUrl: fx.APP, facts: fx.PICK_HIT });
    expect(o.subject.startsWith("[STAGING] [Praxis]")).toBe(true);
  });
});

describe("keys and slots (D-448)", () => {
  it("the five kinds take the pool slot only", () => {
    for (const k of [
      "pick_hit",
      "pick_cleared",
      "pick_candidate",
      "pick_batch",
      "pick_digest",
    ] as const)
      expect(slotCandidates(k)).toEqual(["pool"]);
  });
});

describe("one mail per pick per session (AT-60 b)", () => {
  it("a hit is mailed once over duplicate ticks and repeated notify calls", async () => {
    await transition(1, "hit");
    const mailer = createPickMailer(ctx());
    await mailer.notify(mctx(), []);
    await mailer.notify(mctx(), []);
    await mailer.notify(mctx("1050"), []);
    expect(mock.outbox).toHaveLength(1);
    expect(mock.outbox[0].subject).toBe("[Praxis] Buy price hit — ZZ01 (delayed)");
    expect(mock.outbox[0].text).toContain("A$9.950");
    expect(mock.outbox[0].text).toContain("200 shares");
    expect(await mailRows()).toEqual(["pick_hit:sent"]);
  });

  it("the same pick and session claimed twice sends once (claimKey)", async () => {
    await transition(1, "hit");
    const item = await itemOf(db, (await activeAlerts(db, "AU"))[0].latest);
    const x = {
      kind: "pick_hit" as const,
      userId: "1",
      alertIds: [item.alertId],
      facts: { market: "AU", sessionD: SESSION, hhmm: "1045", items: [item] },
    };
    expect(await sendPickMail(ctx(), x)).toBe("sent");
    expect(await sendPickMail(ctx(), x)).toBe("sent");
    expect(mock.outbox).toHaveLength(1);
    expect(
      await scalar(db, "SELECT COUNT(*) AS n FROM email_message WHERE kind = 'pick_hit'"),
    ).toBe(1);
  });

  it("only below_stop and above_chase_cap clears are mailed", async () => {
    await transition(1, "below_stop");
    await transition(2, "halted");
    await transition(3, "above_chase_cap");
    await createPickMailer(ctx()).notify(mctx(), []);
    expect(mock.outbox).toHaveLength(1); // two mailable clears in one tick: one batch
    expect(mock.outbox[0].subject).toMatch(/2 pick alerts/);
  });

  it("a single clear is a pick_cleared mail", async () => {
    await transition(1, "below_stop");
    await createPickMailer(ctx()).notify(mctx(), []);
    expect(mock.outbox[0].subject).toMatch(/Pick cleared — ZZ01 fell under its stop/);
    expect(await mailRows()).toEqual(["pick_cleared:sent"]);
  });
});

describe("cap, pool slot and P0 (EML-041, D-389)", () => {
  it("the 13th pick mail of the day is suppressed_cap; the P0 slot is still claimable", async () => {
    for (let i = 1; i <= 13; i++) {
      await transition(i, "hit");
      clock = new Date(T1045.getTime() + i * 60_000);
      await createPickMailer(ctx()).notify(mctx(`10${String(45 + i)}`), []);
    }
    expect(mock.outbox).toHaveLength(12);
    const st = (
      await db.execute(
        "SELECT status, COUNT(*) AS n FROM pick_alert_mail GROUP BY status ORDER BY status",
      )
    ).rows;
    expect(st.map((r) => `${String(r.status)}:${Number(r.n)}`)).toEqual([
      "sent:12",
      "suppressed_cap:1",
    ]);
    expect(
      await scalar(
        db,
        "SELECT COUNT(*) AS n FROM email_message WHERE status = 'suppressed_cap' AND kind = 'pick_hit'",
      ),
    ).toBe(1);
    // pool slot only: nothing in the P0 slot or a reserved slot
    expect(
      await scalar(
        db,
        "SELECT COUNT(*) AS n FROM email_message WHERE kind LIKE 'pick_%' AND slot <> 'pool'",
      ),
    ).toBe(0);
    // a P0 alert still gets its own slot
    const claim = await claimKey(db, {
      key: emailKeys.p0("ann:AU:asx:9"),
      kind: "p0",
      env: "production",
      d: SESSION,
      nowIso: clock.toISOString(),
      recipientSha: null,
      caps: await loadCaps(db),
    });
    expect(claim).toEqual({ kind: "claimed", slot: "p0" });
    expect(await pickCapRemaining(db, "production", SESSION)).toBe(0);
  });

  it("candidate mail has its own sub-cap of 3 inside the pick cap", async () => {
    for (let i = 0; i < 4; i++) {
      const item: PickItem = {
        alertId: `cand:AU:${SESSION}:ZY0${i}`,
        event: "candidate",
        candidate: { ...fx.PICK_CANDIDATE, code: `ZY0${i}` },
        line: { code: `ZY0${i}`, what: "Candidate", price: "n/a", quoteTime: "t" },
      };
      const r = await sendPickMail(ctx(), {
        kind: "pick_candidate",
        userId: "1",
        alertIds: [item.alertId],
        facts: { market: "AU", sessionD: SESSION, hhmm: "1100", items: [item] },
      });
      expect(r).toBe(i < 3 ? "sent" : "suppressed_cap");
    }
  });
});

describe("batching (EML-041)", () => {
  it("hits found in one tick go out as one pick_batch listing the codes", async () => {
    await transition(1, "hit");
    await transition(2, "hit");
    await transition(3, "hit");
    await createPickMailer(ctx()).notify(mctx(), []);
    expect(mock.outbox).toHaveLength(1);
    expect(mock.outbox[0].subject).toBe("[Praxis] 3 pick alerts — ZZ01 and others (delayed)");
    for (const c of ["ZZ01", "ZZ02", "ZZ03"]) expect(mock.outbox[0].text).toContain(c);
    expect(await mailRows()).toEqual([
      "pick_batch:batched",
      "pick_batch:batched",
      "pick_batch:batched",
    ]);
    expect(
      await scalar(db, "SELECT COUNT(*) AS n FROM email_message WHERE kind = 'pick_batch'"),
    ).toBe(1);
  });
});

describe("quiet hours, digest and Evening Review (D-388)", () => {
  it("held in quiet hours, one digest at the first tick after they end, never twice", async () => {
    await setQuiet("10:00", "11:00");
    await transition(1, "hit");
    await transition(2, "below_stop");
    const mailer = createPickMailer(ctx());
    await mailer.notify(mctx(), []);
    expect(mock.outbox).toHaveLength(0);
    expect(await mailRows()).toEqual(["pick_hit:held", "pick_cleared:held"]);
    await mailer.digest(mctx("1050")); // still quiet: nothing
    expect(mock.outbox).toHaveLength(0);
    clock = T1105; // window over
    await mailer.digest(mctx("1105"));
    await mailer.digest(mctx("1110"));
    expect(mock.outbox).toHaveLength(1);
    expect(mock.outbox[0].subject).toMatch(/^\[Praxis\] Pick alerts held in quiet hours — 2 items/);
    expect(
      await scalar(db, "SELECT COUNT(*) AS n FROM email_message WHERE kind = 'pick_digest'"),
    ).toBe(1);
    expect(await mailRows()).toEqual([
      "pick_hit:held",
      "pick_cleared:held",
      "pick_digest:sent",
      "pick_digest:sent",
    ]);
    await mailer.notify(mctx("1115"), []); // the held rows are not mailed a second time
    expect(mock.outbox).toHaveLength(1);
  });

  it("quiet hours ending after 16:00: held_to_review, no digest, listed in section 9", async () => {
    await setQuiet("09:00", "17:00");
    await transition(1, "hit");
    const mailer = createPickMailer(ctx());
    await mailer.notify(mctx(), []);
    clock = T1105;
    await mailer.digest(mctx("1105"));
    expect(mock.outbox).toHaveLength(0);
    expect(await mailRows()).toEqual(["pick_hit:held_to_review"]);
    const rv = await readPickReview({ db, market: "AU", d: SESSION } as Ctx, true);
    expect(rv?.held).toEqual(["ZZ01: buy-price alert, held in quiet hours"]);
    expect(rv?.lines[0]).toBe("Buy-price alerts today: 1 hit, 0 cleared.");
  });

  it("a window wrapping midnight (start > end) is held_to_review: no tick today can digest it", async () => {
    await setQuiet("10:30", "02:00");
    await transition(1, "hit");
    const mailer = createPickMailer(ctx());
    await mailer.notify(mctx(), []);
    expect(mock.outbox).toHaveLength(0);
    expect(await mailRows()).toEqual(["pick_hit:held_to_review"]);
  });

  it("a day without pick activity adds nothing to the review", async () => {
    expect(await readPickReview({ db, market: "AU", d: SESSION } as Ctx, true)).toBeNull();
  });

  it("section 8 lines: clear reasons, candidates gated by the preference", async () => {
    await transition(1, "below_stop");
    await db.execute({
      sql: `INSERT INTO intraday_candidate (market, session_d, code, found_slot, found_at, item_source, item_ann_id,
              item_category, materiality, move_ppm, gates_json) VALUES ('AU', ?, 'ZY01', '1130', ?, 'asx', 'a1', 'Contract', 2, 60000, '{}')`,
      args: [SESSION, clock.toISOString()],
    });
    const on = await readPickReview({ db, market: "AU", d: SESSION } as Ctx, true);
    expect(on?.lines).toEqual([
      "Buy-price alerts today: 0 hit, 1 cleared (1 fell under the stop).",
      "Intraday candidates today: 1 found, 0 carried into tonight's decision.",
    ]);
    expect(on?.candidates).toEqual([
      { code: "ZY01", trigger: "Contract", outcome: "not yet decided" },
    ]);
    const off = await readPickReview({ db, market: "AU", d: SESSION } as Ctx, false);
    expect(off?.candidates).toBeNull();
  });
});

describe("preferences and staging (D-444)", () => {
  it("pick_alerts off: nothing is sent", async () => {
    await setPrefs({ pick_alerts: "off" });
    await transition(1, "hit");
    await createPickMailer(ctx()).notify(mctx(), []);
    expect(mock.outbox).toHaveLength(0);
    expect(await mailRows()).toEqual(["pick_hit:off"]);
  });

  it("cleared_pick_emails off keeps hits but drops clear mail", async () => {
    await setPrefs({ cleared_pick_emails: "off" });
    await transition(1, "hit");
    await transition(2, "below_stop");
    await createPickMailer(ctx()).notify(mctx(), []);
    expect(mock.outbox).toHaveLength(1);
    expect(mock.outbox[0].subject).toMatch(/Buy price hit — ZZ01/);
  });

  it("staging sends none to the inbox", async () => {
    await transition(1, "hit");
    await createPickMailer(ctx({ env: { ...ENV, PRAXIS_ENV: "staging" } })).notify(mctx(), []);
    expect(mock.outbox).toHaveLength(0);
    expect(await mailRows()).toEqual(["pick_hit:off"]);
  });
});

describe("new intraday candidates (EML-040)", () => {
  const seed = async (code: string, failed: string | null = null) =>
    db.execute({
      sql: `INSERT INTO intraday_candidate (market, session_d, code, found_slot, found_at, item_source, item_ann_id,
              item_category, materiality, move_ppm, rel_volume_ppm, gates_json, indicative_limit_micro,
              indicative_stop_micro, latest_quote_at)
            VALUES ('AU', ?, ?, '11:30', ?, 'asx', 'a1', 'Contract', 2, 62000, 2400000, ?, 3100000, 2850000, ?)`,
      args: [
        SESSION,
        code,
        clock.toISOString(),
        JSON.stringify({ passed: ["G01", "G02"], failed, stream_state: "shadow" }),
        clock.toISOString(),
      ],
    });
  const run = () =>
    mailNewCandidates(ctx(), { db, now: clock, market: "AU", sessionD: SESSION, slot: "10:30" }, [
      "1",
    ]);

  it("two scan runs give one candidate mail, and the key is recorded", async () => {
    await seed("ZY01");
    await seed("ZY02", "G08"); // failed a gate: never mailed
    await run();
    await run();
    expect(mock.outbox).toHaveLength(1);
    expect(mock.outbox[0].subject).toMatch(/^\[Praxis\] Attention needed — ZY01 found /);
    expect(mock.outbox[0].text).toContain("Unvalidated stream");
    const k = await db.execute("SELECT code, email_key FROM intraday_candidate ORDER BY code");
    expect(String(k.rows[0].email_key)).toBe(`pickcand:AU:${SESSION}:ZY01`);
    expect(k.rows[1].email_key).toBeNull();
  });

  it("intraday_candidate_emails off sends none", async () => {
    await setPrefs({ intraday_candidate_emails: "off" });
    await seed("ZY01");
    await run();
    await run();
    expect(mock.outbox).toHaveLength(0);
    expect(await mailRows()).toEqual(["pick_candidate:off"]);
  });
});
