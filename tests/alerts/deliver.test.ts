// @vitest-environment node
// M5 T6 (AGT-115, EML-020, EML-022, NFR-012, UXN-251; D-096 decisions 9, 24, 40; D-101): alert rows
// from assessments (idempotent by key), P0 immediate then batched, the alert-flush, caps interplay
// with the email core (T3), the production switch, P1/P2 never emailed, controls never alert, the
// regime P1 and the R1 wording through the mock router. Real SQLite with all migrations, the mock
// e-mail provider only (the real Resend API is never called), synthetic ZZ* data.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  attachR1Text,
  deliverP0,
  loadHolders,
  processAssessments,
  r1AlertText,
  raiseAnnouncementAlerts,
  type AlertCtx,
} from "@/lib/alerts/deliver";
import { flushAlerts, raiseRegimeAlert } from "@/lib/alerts/flush";
import { setConfig } from "@/lib/config/store";
import { createMockProvider, type MockProvider } from "@/lib/email/mock";
import { sendEmail } from "@/lib/email/send";
import { emailKeys } from "@/lib/email/keys";
import type { LlmProvider } from "@/lib/llm/providers";
import { MemoryStore } from "@/lib/llm/store";
import { makeRouter } from "../llm/helpers";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import * as fx from "../fixtures/email/facts";

afterEach(cleanupTempDbs);

const T0 = new Date("2026-10-19T09:00:00.000Z"); // Mon 20:00 AEDT
const MIN = 60_000;
const OWNER = "owner@example.test";
const ENV = {
  EMAIL_PROVIDER: "mock",
  OWNER_EMAIL: OWNER,
  APP_BASE_URL: fx.APP,
  PII_HASH_KEY: "k".repeat(64),
  PRAXIS_ENV: "production",
} as Record<string, string | undefined>;
const SRC = "asx_announcements";

let db: Client;
let mock: MockProvider;
let clock: Date;
let n = 0;

const at = (min: number) => new Date(T0.getTime() + min * MIN);
const ctx = (over: Partial<AlertCtx> = {}): AlertCtx => ({
  db,
  env: ENV,
  now: () => clock,
  provider: mock,
  sleep: async () => {},
  ...over,
});
const run = (sql: string, args: (string | number | null)[] = []) => db.execute({ sql, args });
const rows = async (sql: string, args: (string | number | null)[] = []) =>
  (await db.execute({ sql, args })).rows.map((r) => ({ ...r }));

async function setMode(mode: string) {
  await run(
    `INSERT INTO worker_state (key, value_json, updated_at) VALUES ('email_mode', ?, 'x')
     ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
    [JSON.stringify(mode)],
  );
}

/** A held position: E execution, live cohort, open trade and (optionally) the NAV snapshot. */
async function seedHolder(o: {
  code: string;
  exec: string;
  kind?: "E" | "C1";
  valueMicro?: number;
  navMicro?: number;
  live?: number;
}) {
  const kind = o.kind ?? "E";
  await run(
    `INSERT OR IGNORE INTO execution (id, market, kind, family, variant, twin_group, rule_version, cost_profile)
     VALUES (?, 'AU', ?, ?, ?, 'T1', 'rv1', 'P5')`,
    [o.exec, kind, kind === "E" ? "F1" : null, kind === "E" ? "U" : null],
  );
  const cid = `K${o.exec}${o.code}`;
  await run(
    `INSERT INTO cohort (id, execution_id, start_d, seed_micro, rule_version, params_json,
       cost_profile_version, rng_seed, live) VALUES (?, ?, '2026-10-12', 600000000, 'rv1', '{}', 1, 42, ?)`,
    [cid, o.exec, o.live ?? 1],
  );
  await run(
    `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty, status)
     VALUES (?, ?, '2026-10-12', ?, 'buy', 'entry', 10, 'pending')`,
    [`O${cid}`, cid, o.code],
  );
  await run(
    `INSERT INTO fill (id, order_id, cohort_id, d, code, side, qty, rule, ref_price_micro,
       slip_micro, fill_price_micro, value_micro, brokerage_micro, cost_profile,
       bar_o_micro, bar_h_micro, bar_l_micro, bar_c_micro)
     VALUES (?, ?, ?, '2026-10-13', ?, 'buy', 10, 'open', 1000000, 5000, 1005000, 10050000,
       30000000, 'P5', 1000000, 1100000, 900000, 1050000)`,
    [`F${cid}`, `O${cid}`, cid, o.code],
  );
  await run("UPDATE arena_order SET status = 'filled', fill_d = '2026-10-13' WHERE id = ?", [
    `O${cid}`,
  ]);
  await run(
    "INSERT INTO trade (id, cohort_id, code, entry_fill_id, stop_micro) VALUES (?, ?, ?, ?, 900000)",
    [`T${cid}`, cid, o.code, `F${cid}`],
  );
  if (o.navMicro !== undefined) {
    await run(
      `INSERT INTO nav_daily (cohort_id, d, cash_settled_micro, recv_micro, pay_micro, positions_micro,
         div_recv_micro, sleeve_margin_micro, sleeve_unreal_micro, fin_accrued_micro, nav_micro,
         liq_nav_micro, open_positions, invariants_ok) VALUES (?, '2026-10-16', 0,0,0,?,0,0,0,0,?,?,1,1)`,
      [cid, o.valueMicro ?? 0, o.navMicro, o.navMicro],
    );
    await run(
      `INSERT INTO nav_daily_pos (cohort_id, d, code, qty, close_micro, value_micro)
       VALUES (?, '2026-10-16', ?, 10, 1000000, ?)`,
      [cid, o.code, o.valueMicro ?? 0],
    );
  }
}

type Ann = {
  code?: string;
  title?: string;
  type?: string | null;
  priceSensitive?: boolean;
  materiality?: 0 | 1 | 2 | 3;
  held?: boolean;
  watch?: boolean;
  at?: Date;
};

/** An announcement and its assessment, as the Sentinel ingest would have written them. */
async function seedAnn(o: Ann = {}): Promise<string> {
  const annId = `a${++n}`;
  const t = o.at ?? clock;
  await run(
    `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, price_sensitive, title, url, source)
     VALUES ('AU', ?, ?, ?, ?, ?, ?, ?, 'https://example.test/doc.pdf', ?)`,
    [
      o.code ?? "ZZAA",
      annId,
      t.toISOString(),
      t.toISOString(),
      o.type === undefined ? "Trading Halt" : o.type,
      o.priceSensitive ? 1 : 0,
      o.title ?? "Trading halt pending an announcement",
      SRC,
    ],
  );
  await run(
    `INSERT INTO item_assessment (source, ann_id, market, code, materiality, rule_version, polarity,
       held, watch, candidate, tracked, assessed_at) VALUES (?, ?, 'AU', ?, ?, 'materiality-v1', 0, ?, ?, ?, 1, ?)`,
    [
      SRC,
      annId,
      o.code ?? "ZZAA",
      o.materiality ?? 3,
      o.held === false ? 0 : 1,
      o.watch ? 1 : 0,
      o.watch ? 1 : 0,
      t.toISOString(),
    ],
  );
  return `ann:AU:${SRC}:${annId}`;
}

const alertRow = async (key: string) =>
  (await rows("SELECT * FROM alert WHERE alert_key = ?", [key]))[0];
const mails = () => mock.outbox.length;

async function freshWorld() {
  db = await freshDb("main");
  n = 0;
  await run("UPDATE market SET mode = 'full' WHERE code = 'AU'");
  await setMode("full");
  await seedHolder({ code: "ZZAA", exec: "E01", valueMicro: 120_000_000, navMicro: 1_000_000_000 });
}

beforeEach(async () => {
  mock = createMockProvider();
  clock = new Date(T0);
  await freshWorld();
});

describe("holders and weight", () => {
  it("reads the live E executions only, with the stored snapshot (controls never count)", async () => {
    await seedHolder({ code: "ZZAA", exec: "C1", kind: "C1", valueMicro: 5, navMicro: 10 });
    await seedHolder({ code: "ZZAA", exec: "E02", live: 0, valueMicro: 5, navMicro: 10 });
    const h = (await loadHolders(db, "AU", ["ZZAA"])).get("ZZAA") ?? [];
    expect(h.map((x) => x.executionId)).toEqual(["E01"]);
    expect(h[0]).toMatchObject({ valueMicro: 120_000_000n, navMicro: 1_000_000_000n });
  });
});

describe("raising alerts (tier + idempotent key)", () => {
  it("writes one alert per announcement with the tier, key, weight and template facts", async () => {
    const p0 = await seedAnn({ held: true });
    const p1 = await seedAnn({
      code: "ZZBB",
      held: false,
      watch: true,
      materiality: 3,
      type: null,
      title: "Takeover offer received",
    });
    const p2 = await seedAnn({
      code: "ZZCC",
      held: false,
      materiality: 1,
      type: null,
      title: "Notice of meeting",
    });
    const r = await raiseAnnouncementAlerts(ctx());
    expect(r).toMatchObject({ created: 3, p1: 1, p2: 1 });
    expect(r.p0Keys).toEqual([p0]);
    const a = await alertRow(p0);
    expect(a).toMatchObject({
      tier: "P0",
      kind: "halt",
      code: "ZZAA",
      execution_id: "E01",
      weight_ppm: 120_000,
      materiality: 3,
    });
    const f = JSON.parse(String(a.facts_json));
    expect(f).toMatchObject({
      rule: "p0:held_halt",
      type: "Trading Halt",
      url: "https://example.test/doc.pdf",
    });
    expect(f.executions).toEqual([{ id: "E01", label: "F1 U", weightPct: 12 }]);
    expect((await alertRow(p1)).tier).toBe("P1");
    expect((await alertRow(p2)).tier).toBe("P2");
    expect(a.detected_at).toBe(clock.toISOString());
    expect(a.published_at).toBe(clock.toISOString()); // NFR-012 evidence: both instants stored
  });

  it("a repeated call (or a repeated feed) creates nothing new and emails nothing again", async () => {
    await seedAnn();
    const first = await processAssessments(ctx());
    expect(first.created).toBe(1);
    expect(mails()).toBe(1);
    clock = at(60);
    const again = await processAssessments(ctx());
    expect(again.created).toBe(0);
    expect(mails()).toBe(1);
    expect(await rows("SELECT 1 FROM alert")).toHaveLength(1);
  });

  it("materiality 0 and assessments older than 48 h raise nothing", async () => {
    await seedAnn({ materiality: 0, held: false });
    await seedAnn({ at: new Date(clock.getTime() - 49 * 60 * MIN) });
    expect((await raiseAnnouncementAlerts(ctx())).created).toBe(0);
  });

  it("controls and shadow cohorts never alert: a code held only by them is not a holder", async () => {
    await seedHolder({ code: "ZZDD", exec: "C1", kind: "C1", valueMicro: 9, navMicro: 10 });
    const key = await seedAnn({
      code: "ZZDD",
      held: false,
      materiality: 1,
      type: null,
      title: "Notice of meeting",
    });
    await raiseAnnouncementAlerts(ctx());
    const a = await alertRow(key);
    expect(a).toMatchObject({ tier: "P2", execution_id: null, weight_ppm: null });
    expect(JSON.parse(String(a.facts_json)).executions).toEqual([]);
  });

  it("the P0 weight is read from the registry key alert_p0_weight", async () => {
    // 12 % held, materiality 3, not a halt: with the weight raised to 15 % it is only P1.
    await setConfig(db, {
      key: "alert_p0_weight",
      value: 0.15,
      userId: null,
      now: clock.toISOString(),
    });
    const key = await seedAnn({ type: null, title: "Takeover offer received" });
    await raiseAnnouncementAlerts(ctx());
    expect((await alertRow(key)).tier).toBe("P1");
  });
});

describe("P0 delivery: first immediately, the rest batched (decision 40)", () => {
  it("the first P0 is emailed at once, in the p0 slot, template text only", async () => {
    const key = await seedAnn();
    const r = await processAssessments(ctx());
    expect(r.p0).toEqual([{ key, action: "sent", status: "sent" }]);
    expect(mails()).toBe(1);
    const m = mock.outbox[0];
    expect(m.to).toBe(OWNER);
    expect(m.subject).toContain("Praxis P0: ZZAA");
    expect(m.text).toContain("Trading halt pending an announcement");
    expect(m.text).toContain("12.0% of NAV");
    expect(m.text).toContain("https://example.test/doc.pdf");
    const row = (await rows("SELECT * FROM email_message"))[0];
    expect(row).toMatchObject({
      email_key: emailKeys.p0(key),
      kind: "p0",
      slot: "p0",
      status: "sent",
    });
    expect((await alertRow(key)).email_key).toBe(emailKeys.p0(key));
  });

  it("follow-ups inside the window wait; the flush sends ONE batch when the window closes", async () => {
    const k1 = await seedAnn();
    await processAssessments(ctx());
    clock = at(1);
    const k2 = await seedAnn({
      title: "Suspension from quotation",
      type: "Suspension from Quotation",
    });
    clock = at(2);
    const k3 = await seedAnn({ title: "Trading halt extended" });
    const r = await processAssessments(ctx());
    expect(r.p0.map((x) => x.action)).toEqual(["batched", "batched"]);
    expect(mails()).toBe(1);
    const due = await rows("SELECT value_json FROM worker_state WHERE key = 'alert_flush_due'");
    expect(JSON.parse(String(due[0].value_json))).toBe(at(5).toISOString());

    clock = at(3);
    expect((await flushAlerts(ctx())).status).toBe("not_due");
    expect(mails()).toBe(1);

    clock = at(5);
    const f = await flushAlerts(ctx());
    expect(f).toMatchObject({ status: "flushed", batched: 2, email: "sent", due: null });
    expect(mails()).toBe(2);
    expect(mock.outbox[1].text).toContain("Suspension from quotation");
    expect(mock.outbox[1].text).toContain("Trading halt extended");
    const batchKey = emailKeys.p0Batch(k2);
    expect((await alertRow(k2)).email_key).toBe(batchKey);
    expect((await alertRow(k3)).email_key).toBe(batchKey);
    expect((await alertRow(k1)).email_key).toBe(emailKeys.p0(k1));
    expect(await rows("SELECT 1 FROM worker_state WHERE key = 'alert_flush_due'")).toHaveLength(0);

    clock = at(7);
    expect((await flushAlerts(ctx())).status).toBe("idle"); // idempotent
    expect(mails()).toBe(2);
  });

  it("a lone pending P0 goes out as a normal single mail when the window closes", async () => {
    await seedAnn();
    await processAssessments(ctx());
    clock = at(2);
    const k2 = await seedAnn({ title: "Trading halt extended" });
    await processAssessments(ctx());
    clock = at(5);
    const f = await flushAlerts(ctx());
    expect(f).toMatchObject({ status: "flushed", batched: 1, email: "sent" });
    expect((await alertRow(k2)).email_key).toBe(emailKeys.p0(k2));
    expect(mails()).toBe(2);
  });

  it("a P0 after the window has closed is immediate again", async () => {
    await seedAnn();
    await processAssessments(ctx());
    clock = at(6);
    const k2 = await seedAnn({ title: "Another halt" });
    const r = await processAssessments(ctx());
    expect(r.p0).toEqual([{ key: k2, action: "sent", status: "sent" }]);
    expect(mails()).toBe(2);
  });

  it("a duplicate of an already emailed announcement (same code and id, other source) is not emailed", async () => {
    const k1 = await seedAnn();
    await processAssessments(ctx());
    const annId = k1.split(":").slice(3).join(":");
    clock = at(30);
    await run(
      `INSERT INTO alert (alert_key, market, code, kind, tier, detected_at, facts_json)
       VALUES (?, 'AU', 'ZZAA', 'halt', 'P0', ?, '{}')`,
      [`ann:AU:other_source:${annId}`, clock.toISOString()],
    );
    const r = await deliverP0(ctx(), [`ann:AU:other_source:${annId}`]);
    expect(r[0]).toMatchObject({ action: "skipped", status: "duplicate" });
    expect(mails()).toBe(1);
    expect((await alertRow(`ann:AU:other_source:${annId}`)).email_key).toBe(emailKeys.p0(k1));
  });

  it("P1 and P2 are never emailed (they feed the inbox and review section 8)", async () => {
    await seedAnn({ held: true, type: null, title: "Takeover offer received", materiality: 2 }); // P1
    await seedAnn({
      code: "ZZEE",
      held: false,
      materiality: 1,
      type: null,
      title: "Notice of meeting",
    });
    const r = await processAssessments(ctx());
    expect(r).toMatchObject({ created: 2, p1: 1, p2: 1, p0: [] });
    await flushAlerts(ctx());
    expect(mails()).toBe(0);
    expect(await rows("SELECT 1 FROM email_message")).toHaveLength(0);
  });
});

describe("caps interplay with the email core (T3)", () => {
  it("12 P0 spaced outside the window: 10 sent, then suppressed_cap; the reserved review still sends", async () => {
    const keys: string[] = [];
    for (let i = 0; i < 12; i++) {
      clock = at(i * 6); // outside every 5-minute window, so each is a single
      keys.push(await seedAnn({ title: `Trading halt number ${i}` }));
      await processAssessments(ctx());
    }
    expect(mails()).toBe(10);
    const st = await rows(
      "SELECT status, count(*) AS c FROM email_message WHERE kind = 'p0' GROUP BY status ORDER BY status",
    );
    expect(st.map((x) => [x.status, Number(x.c)])).toEqual([
      ["sent", 10],
      ["suppressed_cap", 2],
    ]);
    // the capped ones are handled (not retried) and stay listed as suppressed rows
    for (const k of keys.slice(10)) expect((await alertRow(k)).email_key).toBe(emailKeys.p0(k));
    const review = await sendEmail(
      { db, env: ENV, now: () => clock, provider: mock, sleep: async () => {} },
      "review",
      emailKeys.review("2026-10-19"),
      fx.REVIEW_FULL,
    );
    expect(review.status).toBe("sent");
  });

  it("a batch counts as one P0 email against the cap", async () => {
    await setConfig(db, {
      key: "p0_email_daily_cap",
      value: 2,
      userId: null,
      now: clock.toISOString(),
    });
    await seedAnn();
    await processAssessments(ctx());
    clock = at(1);
    await seedAnn({ title: "Halt b" });
    await seedAnn({ title: "Halt c" });
    await processAssessments(ctx());
    clock = at(5);
    expect((await flushAlerts(ctx())).email).toBe("sent");
    expect(mails()).toBe(2);
  });
});

describe("production switch and staleness", () => {
  it("email_mode off: the alert exists, nothing is sent, the key is not consumed", async () => {
    await setMode("off");
    const key = await seedAnn();
    const r = await processAssessments(ctx());
    expect(r.p0).toEqual([{ key, action: "sent", status: "suppressed_off" }]);
    expect(mails()).toBe(0);
    expect((await alertRow(key)).email_key).toBeNull();
    // switched on within 30 minutes: the flush delivers it
    await setMode("full");
    clock = at(10);
    const f = await flushAlerts(ctx());
    expect(f.email).toBe("sent");
    expect(mails()).toBe(1);
  });

  it("a P0 older than 30 minutes is no longer emailed", async () => {
    await setMode("off");
    const key = await seedAnn();
    await processAssessments(ctx());
    await setMode("full");
    clock = at(31);
    expect((await flushAlerts(ctx())).status).toBe("idle");
    expect(mails()).toBe(0);
    expect((await alertRow(key)).email_key).toBeNull();
  });

  it("no Owner address: recorded as no_recipient, never a failure", async () => {
    const key = await seedAnn();
    const r = await processAssessments(ctx({ env: { ...ENV, OWNER_EMAIL: undefined } }));
    expect(r.p0[0].status).toBe("no_recipient");
    expect((await alertRow(key)).email_key).toBeNull();
  });
});

describe("regime-change P1 (UXN-251)", () => {
  const regime = (d: string, state: string, version = 1, target: Client = db) =>
    target.execute({
      sql: `INSERT INTO regime_daily (market, d, version, close_micro, raw_state, state)
            VALUES ('AU', ?, ?, 1, ?, ?)`,
      args: [d, version, state, state],
    });

  it("a transition writes one P1 with the executions it gates, once, and never emails", async () => {
    await regime("2026-10-16", "RISK-ON");
    await regime("2026-10-19", "RISK-OFF");
    clock = new Date("2026-10-19T10:00:00.000Z");
    const key = await raiseRegimeAlert(ctx());
    expect(key).toBe("regime:AU:2026-10-19");
    const a = await alertRow("regime:AU:2026-10-19");
    expect(a).toMatchObject({ tier: "P1", kind: "regime_shift", code: null, execution_id: null });
    const f = JSON.parse(String(a.facts_json));
    expect(f).toMatchObject({ from: "RISK-ON", to: "RISK-OFF" });
    expect(f.gated).toEqual([{ id: "E01", label: "F1 U", effect: "no new entries" }]);
    expect(await raiseRegimeAlert(ctx())).toBeNull(); // once per transition
    await flushAlerts(ctx());
    expect(await rows("SELECT 1 FROM alert WHERE kind = 'regime_shift'")).toHaveLength(1);
    expect(mails()).toBe(0);
  });

  it("no change, a warm-up side and an old transition raise nothing", async () => {
    const now = () => new Date("2026-10-19T10:00:00.000Z");
    await regime("2026-10-16", "NEUTRAL");
    await regime("2026-10-19", "NEUTRAL");
    expect(await raiseRegimeAlert(ctx({ now }))).toBeNull();

    const warm = await freshDb("main");
    await regime("2026-10-16", "unknown", 1, warm);
    await regime("2026-10-19", "NEUTRAL", 1, warm);
    expect(await raiseRegimeAlert({ db: warm, env: ENV, now })).toBeNull();

    const old = await freshDb("main");
    await regime("2026-09-01", "NEUTRAL", 1, old);
    await regime("2026-09-02", "SHOCK", 1, old);
    expect(await raiseRegimeAlert({ db: old, env: ENV, now })).toBeNull();
  });

  it("the flush raises it (batch 2b needs no change) and uses the latest version of the day", async () => {
    await regime("2026-10-16", "RISK-ON");
    await regime("2026-10-19", "NEUTRAL", 1);
    await regime("2026-10-19", "SHOCK", 2);
    clock = new Date("2026-10-19T10:00:00.000Z");
    const f = await flushAlerts(ctx());
    expect(f.regime).toBe("regime:AU:2026-10-19");
    const a = await alertRow("regime:AU:2026-10-19");
    expect(JSON.parse(String(a.facts_json)).to).toBe("SHOCK");
  });
});

describe("R1 wording (mock router, grounded, in-app only)", () => {
  const answer = (text: string): LlmProvider => ({
    id: "mock",
    kind: "mock",
    paid: false,
    trainsOnPrompts: false,
    modelFor: () => "mock-1",
    available: () => true,
    call: async () => ({ text: JSON.stringify({ text }), tokensIn: 40, tokensOut: 20 }),
  });

  it("a grounded answer is stored once on the alert and changes no tier or email byte", async () => {
    const { router } = makeRouter(
      "mock",
      [answer("ZZAA is halted and E01 holds it.")],
      new MemoryStore(),
    );
    const plain = createMockProvider();
    const key = await seedAnn();
    await processAssessments(ctx({ provider: plain }));
    const bytes = JSON.stringify(plain.outbox);
    expect((await alertRow(key)).text_llm).toBeNull();

    // the same run with a router: identical tier and identical e-mail bytes
    await freshWorld();
    const withRouter = createMockProvider();
    const key2 = await seedAnn();
    await processAssessments(ctx({ provider: withRouter, router }));
    const a = await alertRow(key2);
    expect(a.tier).toBe("P0");
    expect(a.text_llm).toBe("ZZAA is halted and E01 holds it.");
    expect(JSON.stringify(withRouter.outbox)).toBe(bytes);
    // NULL -> value once: a second request changes nothing
    expect(await attachR1Text(ctx({ router }), [key2])).toBe(0);
  });

  it("an ungrounded answer (a number not in the facts) is rejected: rules text, nothing stored", async () => {
    const { router } = makeRouter("mock", [answer("ZZAA fell 99.5 percent.")], new MemoryStore());
    const key = await seedAnn();
    await processAssessments(ctx({ router }));
    const a = await alertRow(key);
    expect(a.text_llm).toBeNull();
    const t = await r1AlertText(
      router,
      a as never,
      { rule: "p0:held_halt", why: "w", executions: [], title: "T" },
      "2026-10-19",
    );
    expect(t.llm).toBe(false);
    expect(t.text).toContain("P0");
  });

  it("rules-only mode and no router give the rules text and store nothing", async () => {
    const { router } = makeRouter("rules-only", [], new MemoryStore());
    const key = await seedAnn();
    await processAssessments(ctx({ router }));
    const a = await alertRow(key);
    expect(a.text_llm).toBeNull();
    const none = await r1AlertText(
      null,
      a as never,
      { rule: "", why: "", executions: [] },
      "2026-10-19",
    );
    expect(none.llm).toBe(false);
  });
});
