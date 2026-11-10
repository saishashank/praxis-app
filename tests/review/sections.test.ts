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
import {
  loadCtx,
  readAvailability,
  readHealth,
  readHealthSummary,
  sentinelScore,
} from "@/lib/review/sections";
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
    expect(REVIEW_SECTION_NAMES).toHaveLength(9);
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
    expect(m[0]!.name).toBe("What we learned today");
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
    // D-922: strategy names, the plain-share / leverage split, day and since-start percentages
    expect(e01).toMatchObject({ name: "Follow the trend", variant: "U" });
    expect(e02).toMatchObject({ name: "Follow the trend", variant: "L" });
    expect(e01.dayPlPpm).toBe(5_824); // +3.50 on 601.00 = 0.5824 %
    expect(e01.sinceStartCents).toBe(e01.navCents - 60_000);
    expect(e01.sinceStartPpm).not.toBeNull();
    expect(facts.scorecard.best).toBeUndefined();
    expect(facts.scorecard.worst).toBeUndefined();
    expect(facts.health).toEqual([]);
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
    await addFilled(db, e01, "o-filled", "ZZF");
    await addPending(db, e01, "o-pend", "ZZP");
    await addPending(db, e02, "o-lev", "ZZL"); // the leverage twin is never listed (D-922)
    const { facts } = await buildFacts(db, opts());
    expect(facts.orders.map((o) => [o.executionId, o.code, o.state])).toEqual([
      ["E01", "ZZF", "filled"],
      ["E01", "ZZP", "created"],
      ["E01", "ZZUP", "created"],
    ]);
    expect(facts.orders.every((o) => o.strategy === "Follow the trend")).toBe(true);
    const created = facts.orders[2]!;
    expect(created.cardPath).toBe(`/cards/${encodeURIComponent(card)}`);
    expect(created.reason).toBe("Guidance upgrade with a rising trend.");
    expect(created.priceCents).toBe(150);
    const filled = facts.orders[0]!;
    expect(filled.priceCents).toBe(100);
    expect(filled.costsCents).toBe(950);
    expect(filled.cardPath).toBe(`/reviews/${D}`);
    expect(facts.orders[1]!.stopCents).toBe(140);
    expect(facts.queuedOrders).toBe(2);
  });

  it("gives the company name (display form) of an order when the instrument is known", async () => {
    const db = await mainWorld();
    const { e01 } = await tradingDay(db);
    await addPending(db, e01, "o-pend", "ZZP");
    await exec(
      db,
      "INSERT INTO instrument (market, code, name) VALUES (?, 'ZZP', 'ZED PRODUCTS LIMITED')",
      [MARKET],
    );
    const { facts } = await buildFacts(db, opts());
    const o = facts.orders.find((x) => x.code === "ZZP")!;
    expect(o.companyName).toBe("Zed Products Limited");
  });

  it("is empty ('No paper orders today') when nothing happened", async () => {
    const db = await mainWorld();
    await tradingDay(db);
    const { facts } = await buildFacts(db, opts());
    expect(facts.orders).toEqual([]);
  });
});

describe("sections 4-6: narrative facts and the no-AI fallback", () => {
  it("builds the plain lists from the daily learning and the closed trades, never from a model (D-922)", async () => {
    const db = await mainWorld();
    const { e01 } = await tradingDay(db);
    await addPending(db, e01, "o-pend", "ZZP");
    const { facts, narrative } = await buildFacts(db, opts());
    expect(narrative).toBe("rules");
    expect(facts.narrative?.kind).toBe("rules");
    // the learning module is a stub that returns null in this branch: said plainly, not hidden
    expect(facts.learning).toBeNull();
    expect(facts.narrative!.s4).toEqual(["The learning step did not run tonight."]);
    expect(facts.narrative!.s5[0]).toBe("Nothing worked today: no strategy finished a trade.");
    expect(facts.narrative!.s6).toEqual(["1 order queued for the next session."]);
    expect(facts.queuedOrders).toBe(1);
    expect(facts.nextTradingNote).toBe("Next trading session: Tue 20 Oct.");
    expect(JSON.stringify(facts.narrative)).not.toMatch(/E01|ledger re-check|No lesson was graded/);
  });
});

describe("section 5: positions finished today", () => {
  it("lists the plain-share strategies' finished trades with the result and how they ended", async () => {
    const db = await mainWorld();
    const { e01, e02 } = await tradingDay(db);
    await addClosedTrade(db, e01, "a", false, D); // finished today, a loss
    await addClosedTrade(db, e02, "b", false, D); // leverage twin: never listed
    await addClosedTrade(db, e01, "c", true); // finished on the previous session: not today
    const { facts } = await buildFacts(db, opts());
    expect(facts.closedTrades).toEqual([
      {
        strategy: "Follow the trend",
        code: "ZZA",
        company: null,
        resultCents: -4000, // 80 - 10 brokerage - 100 - 10 brokerage
        exit: "closing signal",
      },
    ]);
    expect(facts.narrative!.s5[0]).toBe(
      "Nothing worked today: the one trade that finished lost money (-A$40.00 in all).",
    );
  });

  it("uses the learning attribution tag for the plain-word exit reason when it exists", async () => {
    const db = await mainWorld();
    const { e01 } = await tradingDay(db);
    await addClosedTrade(db, e01, "a", true, D);
    await exec(
      db,
      `INSERT INTO attribution (subject_kind, subject_id, version, market, d, final, tags_json, mfe_ppm, mae_ppm,
         hold_sessions, cost_micro, slippage_micro) VALUES ('trade', 't-a', 1, ?, ?, 1, ?, 0, 0, 1, 0, 0)`,
      [MARKET, D, JSON.stringify({ exit: { reason: "CS:close_above_sma" } })],
    );
    const { facts } = await buildFacts(db, opts());
    expect(facts.closedTrades![0]!.exit).toBe(
      "closing signal: the price crossed its average (the trend turned)",
    );
    expect(facts.closedTrades![0]!.resultCents).toBe(1000); // 130 - 10 - 100 - 10 = A$10
  });
});

describe("section 7: statistics, ARN-073 and ARN-075", () => {
  it("computes cumulative trade statistics in plain words, without labels, control rows or agent bars", async () => {
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
    expect(s.headline).toContain("2 finished trades");
    expect(s.headline).toContain("Mon 19 Oct");
    const row = (l: string) => s.rows.find((r) => r.label === l)!;
    expect(row("Finished trades").value).toBe("2");
    expect(row("Win rate").value).toBe("50.0%");
    expect(row("Profit factor").value).toBe("0.25"); // wins 10 vs losses 40
    expect(row("Average result per trade").value).toBe("-A$15.00");
    expect(s.rows.some((r) => /label|C2|Zero-edge|vs/.test(r.label))).toBe(false);
    expect(s.comparisons).toEqual([]);
    expect("agents" in s).toBe(false);
  });

  it("lists one comparison line per plain-share strategy, only when measured", async () => {
    const db = await mainWorld();
    await tradingDay(db);
    const head = (scope: string, cif: number | null) =>
      exec(
        db,
        `INSERT INTO replay_stat (run_id, d, scope, metric, value_json) VALUES (?, ?, ?, 'headline', ?)`,
        [
          runKeys.review(MARKET, D),
          D,
          scope,
          JSON.stringify({
            scope,
            comparator: "C2-F1",
            cifTargetMinusC2: cif,
            navMinusC2Micro: null,
            effectiveN: 12,
            comparatorEffectiveN: 14,
          }),
        ],
      );
    await head("E01", 0.025);
    await head("E02", 0.5); // the leverage twin is never listed
    const { facts } = await buildFacts(db, opts());
    expect(facts.stats!.comparisons).toEqual([
      "Follow the trend: 2.5 percentage points ahead of its random-pick twin at reaching the target (12 against 14 finished rounds).",
    ]);
    const unmeasured = await mainWorld();
    await tradingDay(unmeasured);
    expect((await buildFacts(unmeasured, opts())).facts.stats!.comparisons).toEqual([]);
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
  });
});

describe("section 8: today's alerts", () => {
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
      "The market mood changed from neutral to shock. Follow the trend: entries paused.",
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
        company: null,
        breaker: "TB-NEG (red)",
        effect: "held position exits at the next open",
      },
    ]);
  });
});

const healthOf = async (db: Client) => {
  const c = await loadCtx(db, opts());
  const av = await readAvailability(c);
  return { c, ...(await readHealth(c, av)) };
};

describe("system and quota health (no longer in the review, D-922; the reader stays for the app)", () => {
  it("leaves the review facts free of health lines and counts", async () => {
    const db = await mainWorld();
    await tradingDay(db);
    const { facts } = await buildFacts(db, opts());
    expect(facts.health).toEqual([]);
    expect(facts.suppressedEmails).toBe(0);
    expect(facts.scorecard.attention).toEqual([]);
  });

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
    const facts = {
      health: (await healthOf(db)).lines,
      suppressedEmails: (await healthOf(db)).suppressed,
    };
    const line = (l: string) => facts.health.find((h) => h.label === l)!;
    expect(line("ASX feed")).toMatchObject({ status: "attention" });
    expect(line("ASX feed").detail).toContain("off: Owner switch");
    expect(line("Nightly run").status).toBe("ok");
    expect(line("Data freshness").status).toBe("ok");
    expect(line("AI models").detail).toContain("1 call, 1 answered by rules");
    expect(line("Incidents")).toMatchObject({ status: "attention", detail: "1 open incident." });
    expect(line("Backups").status).toBe("attention");
    expect(facts.suppressedEmails).toBe(1);
    const h = await healthOf(db);
    const summary = await readHealthSummary(h.c, h.lines);
    expect(summary.attention.map((a) => a.name)).toContain("ASX feed");
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
    const h = await healthOf(db);
    const summary = await readHealthSummary(h.c, h.lines);
    expect(summary).toMatchObject({ healthyComponents: 1, totalComponents: 2 });
    expect(summary.attention).toEqual([
      { name: "Yahoo slow", status: "attention", daysOpen: 4, fix: "Wait" },
    ]);
  });
});

describe("health reader: the steelman budget-state line (D-484, AT-37)", () => {
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
    const facts = { health: (await healthOf(db)).lines };
    expect(facts.health.some((h) => h.label === "Steelman")).toBe(false);
  });

  it("says no model was available, informational and OK", async () => {
    const db = await mainWorld();
    await tradingDay(db);
    await night(db, { written: 0, noModel: 3, budget: 0 });
    const facts = { health: (await healthOf(db)).lines };
    const l = facts.health.find((h) => h.label === "Steelman")!;
    expect(l.status).toBe("ok");
    expect(l.detail).toContain("0 of 3 written; 3 with no model available");
  });

  it("asks for attention when the AI budget stopped it", async () => {
    const db = await mainWorld();
    await tradingDay(db);
    await night(db, { written: 1, noModel: 0, budget: 2 });
    const facts = { health: (await healthOf(db)).lines };
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

  it("non-trading day: carried NAV, no day P/L, no yesterday-as-today, no learning on a market-closed day", async () => {
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
    expect(facts.nextTradingNote).toBe("Next trading session: Mon 19 Oct.");
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
    expect(none.facts.minimalReason).toBe("Normal path failed. No data for Mon 19 Oct.");
  });
});

export type { Client };
