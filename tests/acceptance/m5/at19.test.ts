// @vitest-environment node
// AT-19 Alert tiers (M5 T15; AGT-115, EML-004, EML-020, EML-022, NFR-012; D-101). Verbatim: "Halt of a
// held code -> first P0 email within NFR-012 (<= 5 min median non-ASX, <= 9 min median ASX); P1/P2
// only in-app/digest; daily cap, reserved slots and batching respected". Real code, mock provider,
// synthetic data. Heavier cover: tests/alerts/deliver.test.ts, tests/alerts/tiers.test.ts,
// tests/time/m5Slots.test.ts ("NFR-012: median P0 latency"). Staging live "[STAGING]" P0 is pending (Owner).
import { afterEach, describe, expect, it } from "vitest";
import { flushAlerts } from "@/lib/alerts/flush";
import { processAssessments } from "@/lib/alerts/deliver";
import { buildFacts } from "@/lib/review/assemble";
import { sendEmail } from "@/lib/email/send";
import { emailKeys } from "@/lib/email/keys";
import { cleanupTempDbs } from "../../db/helpers";
import * as fx from "../../fixtures/email/facts";
import { APP, ENV, alertWorld, seedAnn, seedHolder } from "./alertWorld";

afterEach(cleanupTempDbs);

describe("AT-19 alert tiers", () => {
  it("a halt of a held code: the first P0 email goes at once, in the Owner's inbox, template text with source link and Melbourne time", async () => {
    const w = await alertWorld();
    const key = await seedAnn(w);
    const r = await processAssessments(w.ctx());
    expect(r.p0).toEqual([{ key, action: "sent", status: "sent" }]);
    expect(w.mock.outbox).toHaveLength(1);
    const m = w.mock.outbox[0]!;
    expect(m.to).toBe("owner@example.test");
    expect(m.subject).toContain("Praxis P0: ZZAA");
    expect(m.text).toContain("https://example.test/doc.pdf"); // EML-022 source link
    expect(m.text).toMatch(/AEDT|Melbourne/); // EML-022 time in Australia/Melbourne
    expect(m.text).toContain("12.0% of NAV");
    // NFR-012: published and detected at the same instant, accepted by the provider in the same call (0 min <= 9 min median)
    const a = (
      await w.rows("SELECT detected_at, published_at FROM alert WHERE alert_key = ?", [key])
    )[0]!;
    expect(a.published_at).toBe(w.clock.toISOString());
    const sent = (await w.rows("SELECT status FROM email_message WHERE kind = 'p0'"))[0]!;
    expect(sent.status).toBe("sent");
  });

  it("P1 and P2 are never emailed: they sit in the inbox and in review section 8 (digest)", async () => {
    const w = await alertWorld();
    await seedAnn(w, {
      code: "ZZBB",
      held: false,
      watch: true,
      materiality: 3,
      type: null,
      title: "Takeover offer received",
    });
    await seedAnn(w, {
      code: "ZZCC",
      held: false,
      materiality: 1,
      type: null,
      title: "Notice of meeting",
    });
    const r = await processAssessments(w.ctx());
    expect(r).toMatchObject({ created: 2, p1: 1, p2: 1 });
    expect(w.mock.outbox).toHaveLength(0);
    expect(await w.rows("SELECT 1 FROM email_message")).toHaveLength(0);
    const { facts } = await buildFacts(w.db, {
      market: "AU",
      d: "2026-10-19",
      env: "production",
      appUrl: APP,
      now: w.clock,
    });
    expect(facts.alerts.map((x) => x.tier).sort()).toEqual(["P1", "P2"]);
  });

  it("controls never alert: a code held only by a control execution is P2 with no execution", async () => {
    const w = await alertWorld();
    await seedHolder(w, { code: "ZZDD", exec: "C1", kind: "C1", valueMicro: 9, navMicro: 10 });
    const key = await seedAnn(w, {
      code: "ZZDD",
      held: false,
      materiality: 1,
      type: null,
      title: "Notice",
    });
    await processAssessments(w.ctx());
    const a = (await w.rows("SELECT tier, execution_id FROM alert WHERE alert_key = ?", [key]))[0]!;
    expect(a).toMatchObject({ tier: "P2", execution_id: null });
    expect(w.mock.outbox).toHaveLength(0);
  });

  it("batching: follow-ups inside 5 minutes wait and go out as ONE email at the flush", async () => {
    const w = await alertWorld();
    await seedAnn(w);
    await processAssessments(w.ctx());
    w.clock = w.at(1);
    await seedAnn(w, { title: "Suspension from quotation", type: "Suspension from Quotation" });
    w.clock = w.at(2);
    await seedAnn(w, { title: "Trading halt extended" });
    const r = await processAssessments(w.ctx());
    expect(r.p0.map((x) => x.action)).toEqual(["batched", "batched"]);
    expect(w.mock.outbox).toHaveLength(1);
    w.clock = w.at(5);
    expect((await flushAlerts(w.ctx())).email).toBe("sent");
    expect(w.mock.outbox).toHaveLength(2);
    expect(w.mock.outbox[1]!.subject).toMatch(/P0/);
  });

  it("duplicates are suppressed: the same announcement twice sends one email", async () => {
    const w = await alertWorld();
    await seedAnn(w);
    await processAssessments(w.ctx());
    w.clock = w.at(60);
    expect((await processAssessments(w.ctx())).created).toBe(0);
    expect(w.mock.outbox).toHaveLength(1);
  });

  it("given 12 P0 events in an hour: 10 sent, 2 suppressed_cap listed in section 9, and the reserved review slot still sends", async () => {
    const w = await alertWorld();
    for (let i = 0; i < 12; i++) {
      w.clock = w.at(i * 5 + 1 + i); // spaced past every 5-minute window, all inside ~1.2 h
      await seedAnn(w, { title: `Trading halt number ${i}` });
      await processAssessments(w.ctx());
    }
    expect(w.mock.outbox).toHaveLength(10);
    const st = await w.rows(
      "SELECT status, count(*) AS c FROM email_message WHERE kind = 'p0' GROUP BY status ORDER BY status",
    );
    expect(st.map((x) => [x.status, Number(x.c)])).toEqual([
      ["sent", 10],
      ["suppressed_cap", 2],
    ]);
    // the capped events stay in the alert inbox
    expect(await w.rows("SELECT 1 FROM alert WHERE tier = 'P0'")).toHaveLength(12);
    w.clock = w.at(70);
    const { facts } = await buildFacts(w.db, {
      market: "AU",
      d: "2026-10-19",
      env: "production",
      appUrl: APP,
      now: w.clock,
    });
    expect(facts.suppressedEmails).toBe(2); // section 9 lists them (04 AC, EML-004)
    const review = await sendEmail(
      { db: w.db, env: ENV, now: () => w.clock, provider: w.mock, sleep: async () => {} },
      "review",
      emailKeys.review("2026-10-19"),
      fx.REVIEW_FULL,
    );
    expect(review.status).toBe("sent"); // reserved slots intact
  });
});
