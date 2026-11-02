// @vitest-environment node
// Evening Review section readers (M5 T9; EML-011/012/014/035/037, ARN-073/075/077, AT-20 content).
// Each of the 10 sections is produced from synthetic database state and compared with the facts the
// T4 renderer expects. Synthetic data only; no network, no clock inside the readers.
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { closeBooksKey } from "@/lib/arena/closeBooks";
import { signalsKey } from "@/lib/agents/batch2b";
import { reviewKey } from "@/lib/agents/batch3";
import { buildFacts } from "@/lib/review/assemble";
import { REVIEW_SECTION_NAMES, missingSections, runKeys } from "@/lib/review/facts";
import { sentinelScore } from "@/lib/review/sections";
import { cleanupTempDbs } from "../db/helpers";
import {
  APP,
  D,
  MARKET,
  NOW,
  PREV,
  SAT,
  addAlert,
  addCard,
  addClosedTrade,
  addFilled,
  addMarker,
  addNav,
  addPending,
  addRun,
  cohortOf,
  exec,
  mainWorld,
  tradingDay,
} from "./helpers";

afterEach(cleanupTempDbs);

const opts = (d = D) => ({ market: MARKET, d, env: "production" as const, appUrl: APP, now: NOW });

describe("keys", () => {
  it("the review module uses the same run keys as the batches", () => {
    expect(runKeys.close(MARKET, D)).toBe(closeBooksKey(MARKET, D));
    expect(runKeys.signals(MARKET, D)).toBe(signalsKey(MARKET, D));
    expect(runKeys.review(MARKET, D)).toBe(reviewKey(MARKET, D));
    expect(REVIEW_SECTION_NAMES).toHaveLength(10);
  });
});

describe("partial map", () => {
  const base = {
    arenaActive: true,
    tradingDay: true,
    marker: true,
    closeOk: true,
    signalsOk: true,
    reviewOk: true,
    learnOk: true,
  };
  it("is empty when every input is there, in data-only mode and on a non-trading day", () => {
    expect(missingSections(base)).toEqual([]);
    expect(missingSections({ ...base, arenaActive: false, closeOk: false })).toEqual([]);
    expect(missingSections({ ...base, tradingDay: false, marker: false })).toEqual([]);
  });
  it("lists sections 1-7 when the marker is missing (EML-035)", () => {
    expect(missingSections({ ...base, marker: false }).map((m) => m.n)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
  });
  it("maps each missing run to its sections, with names", () => {
    expect(missingSections({ ...base, closeOk: false }).map((m) => m.n)).toEqual([1, 2, 3]);
    expect(missingSections({ ...base, signalsOk: false }).map((m) => m.n)).toEqual([2]);
    // sections 4-6 read the A6 `learn` run (M6 T11); section 7 reads batch 3
    const m = missingSections({ ...base, learnOk: false });
    expect(m.map((x) => x.n)).toEqual([4, 5, 6]);
    expect(m[0]!.name).toBe("What was learned today");
    expect(missingSections({ ...base, reviewOk: false }).map((x) => x.n)).toEqual([7]);
  });
});

describe("sections 1 and 3: executions", () => {
  it("reads NAV, day P/L, progress to target, realised/unrealised and costs for the date only", async () => {
    const db = await mainWorld();
    await tradingDay(db);
    const { facts, variant, missing } = await buildFacts(db, opts());
    expect(variant).toBe("full");
    expect(missing).toEqual([]);
    const e01 = facts.executions.find((e) => e.id === "E01")!;
    expect(e01.navCents).toBe(60450);
    expect(e01.dayPlCents).toBe(350); // 604.5 - 601
    expect(e01.currency).toBe("AUD");
    expect(e01.progressPct).toBeGreaterThanOrEqual(0);
    expect(e01.progressPct).toBeLessThanOrEqual(100);
    expect(e01.distanceToTargetCents).toBeGreaterThan(0);
    expect(e01.path).toBe("/executions/E01");
    const e02 = facts.executions.find((e) => e.id === "E02")!;
    expect(e02.dayPlCents).toBe(-300);
    expect(e02.sleeve).toBe("unlocked");
    expect(facts.scorecard.best?.id).toBe("E01");
    expect(facts.scorecard.worst?.id).toBe("E02");
  });

  it("never uses a previous day's NAV when the date's own books are missing (EML-035)", async () => {
    const db = await mainWorld();
    const e01 = await cohortOf(db, "E01");
    await addNav(db, e01, PREV, 601_000_000n); // only yesterday exists
    await addRun(db, runKeys.signals(MARKET, D), "success");
    const { facts, variant, missing } = await buildFacts(db, opts());
    expect(variant).toBe("partial");
    expect(missing.map((m) => m.n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(facts.executions).toEqual([]);
    expect(facts.orders).toEqual([]);
    expect(facts.narrative).toBeNull();
    expect(facts.stats).toBeNull();
    expect(JSON.stringify(facts)).not.toContain("60100");
  });
});

describe("section 2: orders", () => {
  it("lists orders filled on D and orders created for the next session, with card links", async () => {
    const db = await mainWorld();
    const { e01, e02 } = await tradingDay(db);
    const card = await addCard(db, e01);
    await addFilled(db, e02, "o-filled", "ZZF");
    await addPending(db, e02, "o-pend", "ZZP");
    const { facts } = await buildFacts(db, opts());
    expect(facts.orders.map((o) => [o.executionId, o.code, o.state])).toEqual([
      ["E01", "ZZUP", "created"],
      ["E02", "ZZF", "filled"],
      ["E02", "ZZP", "created"],
    ]);
    const created = facts.orders[0]!;
    expect(created.cardPath).toBe(`/cards/${encodeURIComponent(card)}`);
    expect(created.reason).toBe("Guidance upgrade with a rising trend.");
    expect(created.priceCents).toBe(150);
    const filled = facts.orders[1]!;
    expect(filled.priceCents).toBe(100);
    expect(filled.costsCents).toBe(950);
    expect(filled.cardPath).toBe(`/reviews/${D}`);
    expect(facts.orders[2]!.stopCents).toBe(140);
  });

  it("is empty ('No paper orders today') when nothing happened", async () => {
    const db = await mainWorld();
    await tradingDay(db);
    const { facts } = await buildFacts(db, opts());
    expect(facts.orders).toEqual([]);
  });
});

describe("sections 4-6: narrative facts and the no-AI fallback", () => {
  it("falls back to deterministic facts-only lists when there is no R5 row (EML-014)", async () => {
    const db = await mainWorld();
    const { e01 } = await tradingDay(db);
    await addPending(db, e01, "o-pend", "ZZP");
    const { facts, narrative } = await buildFacts(db, opts());
    expect(narrative).toBe("rules");
    expect(facts.narrative?.kind).toBe("rules");
    expect(facts.narrative!.s4.join(" ")).toMatch(/No lesson was graded or changed/);
    expect(facts.narrative!.s5.join(" ")).toMatch(/No position finished today/);
    expect(facts.narrative!.s6.join(" ")).toMatch(/No plan items for the next session/);
    expect(facts.narrative!.s5[0]).toMatch(/^Best day: E01 AUD \+3\.50/);
    expect(facts.narrative!.s6).toContain("Next trading session: 2026-10-20.");
    expect(facts.narrative!.s6).toContain("1 order queued for the next session.");
  });
});

describe("section 7: statistics, ARN-073 and ARN-075", () => {
  it("computes cumulative trade statistics and shows 'n/a' for agents without a success test", async () => {
    const db = await mainWorld();
    const { e01 } = await tradingDay(db);
    await addClosedTrade(db, e01, "a", true);
    await addClosedTrade(db, e01, "b", false);
    await exec(
      db,
      `INSERT INTO label (id, execution_id, rule_version, variant, label, n, d) VALUES ('l1', 'E01', 'F1.v1', 'U', 'UNVALIDATED', 2, ?)`,
      [D],
    );
    const { facts } = await buildFacts(db, opts());
    const s = facts.stats!;
    expect(s.headline).toContain("2 closed trades");
    const row = (l: string) => s.rows.find((r) => r.label === l)!;
    expect(row("Closed trades").value).toBe("2");
    expect(row("Win rate").value).toBe("50.0%");
    expect(row("Profit factor").value).toBe("0.25"); // wins 10 vs losses 40
    expect(row("E01 label").value).toBe("UNVALIDATED");
    expect(s.agents.map((a) => [a.agent, a.successPct])).toEqual([
      ["A1 Sentinel (ARN-073)", null],
      ["Pattern agent (ARN-074)", null],
      ["LLM roles (ARN-075)", null],
    ]);
  });

  it("scores the Sentinel against measured moves of 5 % or more (ARN-073)", async () => {
    const db = await mainWorld();
    await tradingDay(db);
    for (const [i, ar] of [60_000, 10_000, -70_000].entries()) {
      const annId = `ann${i}`;
      await exec(
        db,
        `INSERT INTO event (market, source, ann_id, code, published_at, timed, day0_d, group_key, category,
           price_sensitive, ar_ppm, ar_num, ar_den, polarity, rule_version)
         VALUES (?, 'asx', ?, 'ZZUP', ?, 1, ?, 'g', 'results', 1, ?, ?, '1000000', 1, 'v1')`,
        [MARKET, annId, `${D}T01:00:00.000Z`, D, ar, String(ar)],
      );
      await addAlert(db, `a${i}`, "P1", `${D}T01:0${i}:00.000Z`, { source: "asx", annId });
    }
    const score = await sentinelScore(db, MARKET, D);
    expect(score).toMatchObject({ n: 3, hits: 2, falseAlarms: 1 });
    const { facts } = await buildFacts(db, opts());
    expect(facts.stats!.agents[0]).toMatchObject({ successPct: 67, n: 3 });
  });
});

describe("section 8: Sentinel recap", () => {
  it("lists the alerts of the Melbourne date only, P0 first, with the regime notice", async () => {
    const db = await mainWorld();
    await tradingDay(db);
    // 2026-10-19 00:30 Melbourne (AEDT) = 2026-10-18T13:30Z; the alert before it belongs to the 18th
    await addAlert(db, "old", "P0", "2026-10-18T12:00:00.000Z", { title: "Yesterday", why: "x" });
    await addAlert(db, "p2", "P2", `${D}T00:10:00.000Z`, { title: "Small", why: "minor" });
    await addAlert(db, "p0", "P0", `${D}T01:00:00.000Z`, {
      title: "Halt ZZUP",
      why: "held, 12 %",
      url: "https://example.test/a",
    });
    await addAlert(
      db,
      "rg",
      "P1",
      `${D}T02:00:00.000Z`,
      {
        from: "NEUTRAL",
        to: "SHOCK",
        why: "regime",
        gated: [{ id: "E01", effect: "entries paused" }],
      },
      "regime_shift",
      null,
    );
    const { facts } = await buildFacts(db, opts());
    expect(facts.alerts.map((a) => a.tier)).toEqual(["P0", "P1", "P2"]);
    expect(facts.alerts[0]).toMatchObject({
      code: "ZZUP",
      title: "Halt ZZUP",
      time: "12:00",
      url: "https://example.test/a",
    });
    expect(facts.regimeNotice).toBe(
      "Market regime changed from NEUTRAL to SHOCK. E01: entries paused.",
    );
  });

  it("lists thesis-breaker hits with their effect", async () => {
    const db = await mainWorld();
    const { e01 } = await tradingDay(db);
    await addCard(db, e01);
    await exec(
      db,
      `INSERT INTO thesis_breaker_eval (subject_id, breaker_id, d, phase, subject_kind, card_id, market, code, status,
         value_text, trigger_text, rule_version) VALUES ('t1', 'TB-NEG', ?, 'nightly', 'trade', ?, ?, 'ZZUP', 'red', 'v', 't', 'v1')`,
      [D, "card:sig:" + D + ":ZZUP:E01", MARKET],
    );
    const { facts } = await buildFacts(db, opts());
    expect(facts.breakerHits).toEqual([
      {
        execution: "ZZUP",
        breaker: "TB-NEG (red)",
        effect: "held position exits at the next open",
      },
    ]);
  });
});

describe("section 9: system and quota health", () => {
  it("reports the ASX switch, jobs, models, incidents and suppressed emails", async () => {
    const db = await mainWorld();
    await tradingDay(db);
    await exec(
      db,
      "UPDATE source_status SET mode = 'off', reason = 'Owner switch' WHERE source = 'asx_announcements'",
    );
    await exec(db, "INSERT INTO incident (at, severity, kind) VALUES (?, 'S2', 'worker_blind')", [
      `${D}T01:00:00.000Z`,
    ]);
    await exec(
      db,
      `INSERT INTO llm_call (id, role, provider, fallback_depth, outcome, market, d) VALUES ('c1', 'R5', 'rules-only', 'rules-only', 'rules-only', ?, ?)`,
      [MARKET, D],
    );
    await exec(
      db,
      `INSERT INTO email_message (email_key, env, kind, d, slot, status, created_at) VALUES ('p0:a', 'production', 'p0', ?, 'p0', 'suppressed_cap', ?)`,
      [D, `${D}T01:00:00.000Z`],
    );
    const { facts } = await buildFacts(db, opts());
    const line = (l: string) => facts.health.find((h) => h.label === l)!;
    expect(line("ASX feed")).toMatchObject({ status: "attention" });
    expect(line("ASX feed").detail).toContain("off: Owner switch");
    expect(line("Nightly run").status).toBe("ok");
    expect(line("Data freshness").status).toBe("ok");
    expect(line("AI models").detail).toContain("1 call, 1 answered by rules");
    expect(line("Incidents")).toMatchObject({ status: "attention", detail: "1 open incident." });
    expect(line("Backups").status).toBe("attention");
    expect(facts.suppressedEmails).toBe(1);
    expect(facts.scorecard.attention.map((a) => a.name)).toContain("ASX feed");
  });

  it("uses the stored health snapshot of the review when there is one", async () => {
    const db = await mainWorld();
    await tradingDay(db);
    await exec(
      db,
      "INSERT INTO health_snapshot (d, purpose, components_json) VALUES (?, 'review', ?)",
      [
        D,
        JSON.stringify({
          components: [
            { id: "sentinel", state: "healthy", items: [] },
            {
              id: "market_data",
              state: "attention",
              items: [
                { key: "k", label: "Yahoo slow", state: "attention", since_d: PREV, fix: "Wait" },
              ],
            },
          ],
        }),
      ],
    );
    const { facts } = await buildFacts(db, opts());
    expect(facts.scorecard).toMatchObject({ healthyComponents: 1, totalComponents: 2 });
    expect(facts.scorecard.attention).toEqual([
      { name: "Yahoo slow", status: "attention", daysOpen: 4, fix: "Wait" },
    ]);
  });
});

describe("section 9: the steelman budget-state line (D-484, AT-37)", () => {
  const night = (db: Client, n: { written: number; noModel: number; budget: number }) =>
    exec(
      db,
      `INSERT INTO steelman_night (market, d, requested, written, not_written_limit, not_written_budget,
         not_written_no_model, not_written_critic, claims_total, claims_valid, validity_ppm, critic_hidden, created_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, 0, 0, 0, 0, 0, ?)`,
      [
        MARKET,
        D,
        n.written + n.noModel + n.budget,
        n.written,
        n.budget,
        n.noModel,
        `${D}T09:00:00.000Z`,
      ],
    );

  it("has no line on a night without a steelman row", async () => {
    const db = await mainWorld();
    await tradingDay(db);
    const { facts } = await buildFacts(db, opts());
    expect(facts.health.some((h) => h.label === "Steelman")).toBe(false);
  });

  it("says no model was available, informational and OK", async () => {
    const db = await mainWorld();
    await tradingDay(db);
    await night(db, { written: 0, noModel: 3, budget: 0 });
    const { facts } = await buildFacts(db, opts());
    const l = facts.health.find((h) => h.label === "Steelman")!;
    expect(l.status).toBe("ok");
    expect(l.detail).toContain("0 of 3 written; 3 with no model available");
  });

  it("asks for attention when the AI budget stopped it", async () => {
    const db = await mainWorld();
    await tradingDay(db);
    await night(db, { written: 1, noModel: 0, budget: 2 });
    const { facts } = await buildFacts(db, opts());
    const l = facts.health.find((h) => h.label === "Steelman")!;
    expect(l.status).toBe("attention");
    expect(l.detail).toContain("1 of 3 written; 2 stopped by the AI budget");
  });
});

describe("variants", () => {
  it("data-only mode is not partial: sections 1-7 carry the 'not active' notice", async () => {
    const db = await mainWorld({ mode: "data_only" });
    const { facts, variant, missing } = await buildFacts(db, opts());
    expect(variant).toBe("full");
    expect(missing).toEqual([]);
    expect(facts.arenaActive).toBe(false);
    expect(facts.executions).toEqual([]);
  });

  it("non-trading day: carried NAV, no day P/L, no yesterday-as-today, still all ten headings", async () => {
    const db = await mainWorld();
    const { e01 } = await tradingDay(db);
    void e01;
    await addMarker(db, SAT, "non-trading");
    const { facts, variant, kind } = await buildFacts(db, opts(SAT));
    expect(variant).toBe("nonTrading");
    expect(kind).toBe("non_trading");
    expect(facts.orders).toEqual([]);
    const e = facts.executions.find((x) => x.id === "E01")!;
    expect(e.navCents).toBe(60100); // Friday's NAV, carried over the weekend
    expect(e.dayPlCents).toBe(0);
    expect(facts.scorecard.best).toBeUndefined();
    expect(facts.narrative?.s6[0]).toBe("Next trading session: 2026-10-19.");
  });

  it("minimal review: this date's data only, with the reason", async () => {
    const db = await mainWorld();
    await tradingDay(db);
    const { facts, variant } = await buildFacts(db, {
      ...opts(),
      minimal: { reason: "Normal path failed." },
    });
    expect(variant).toBe("minimal");
    expect(facts.executions).toHaveLength(2);
    expect(facts.orders).toEqual([]);
    expect(facts.stats).toBeNull();
    expect(facts.minimalReason).toBe("Normal path failed.");
    const empty = await mainWorld();
    const none = await buildFacts(empty, { ...opts(), minimal: { reason: "Normal path failed." } });
    expect(none.facts.executions).toEqual([]);
    expect(none.facts.minimalReason).toBe(`Normal path failed. No data for ${D}.`);
  });
});

export type { Client };
