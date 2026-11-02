// @vitest-environment node
// AT-42 Go-live fixes (M8.1), the recorded day (spec v2/14_acceptance_delta.md; GL-01 to GL-06 of
// v2/10_fixes_and_enhancements_delta.md; decisions D-207 to D-212).
//
//   "Recorded day with: a 48% fall with no announcement; a corporate action confirmed at D+5; an order
//    whose open gaps +3%; a bar with null adj_close; an announcement published 18:08 / ingested 18:11;
//    a forced HTTP 401 dispatch. GL-01...GL-06 behave as ch. 10 V2 states; replay = live for the 18:08
//    item once GL-05 is in."
//
// The day is synthetic (ZZ codes, invented numbers; repo hygiene SEC-110 forbids real market data).
// Each part drives the REAL stage function on a throwaway libSQL file with every migration applied:
//
//   1 GL-01  batch 1 (runBatch1 with its corporate-actions stage) for nine sessions, the Owner queue
//            read model, the data-quality gate
//   2 GL-02  the corporate-actions stage on D+5, the adjusted-bar reader and the decision/replay
//            readers (loadConfirmedActions, knownBy, splitsKnownOn, corpRecordsOf)
//   3 GL-03  batch 2a (closeBooksDay) live and as a replay over the same orders and bars
//   4 GL-04  the same batch 1 nights: a bar with null adj_close
//   5 GL-05  the ASX store step (asxIngestMain) writing the item and the cut-off poll marker, the
//            decision view (live and replay flags), the offline snapshot rule, batch 2b's bounded wait
//   6 GL-06  the Worker clock (runClock) with a refused GitHub dispatch, then the evening heartbeat
//
// A timeline of the recorded day is the RECORDED table below; the tests read their dates from it.
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adjustBars, splitActionsByCode, splitsKnownOn } from "@/lib/agents/candidates";
import { createDecisionView, decisionCutoffUtc } from "@/lib/agents/decisionView";
import { defaultAgentParams } from "@/lib/agents/params";
import { closeBooksDay, type CloseBooksResult } from "@/lib/arena/closeBooks";
import { knownBy } from "@/lib/arena/corpActions";
import { loadConfirmedActions } from "@/lib/arena/corpActionWriter";
import { toBig } from "@/lib/arena/ledgerWriter";
import { asxIngestMain } from "@/lib/data/asxIngest";
import { adjustedBars } from "@/lib/data/adjusted";
import { loadActions, runCorporateActions } from "@/lib/data/corporateActions/engine.mjs";
import { loadReviewQueue } from "@/lib/data/corporateActions/queue";
import { carryTiers, runBatch1 } from "@/lib/data/pipeline/batch1";
import { entriesAllowed } from "@/lib/data/quality/gate";
import { createHeartbeatHandler } from "@/lib/heartbeat/handler";
import { createMockProvider } from "@/lib/email/mock";
import { corpRecordsOf, snapshotAnnouncementVisible } from "@/lib/replay/snapshotWorld";
import {
  CUTOFF_POLL_WINDOW_MS,
  loadIngestBound,
  readCutoffPoll,
  waitForCutoffPoll,
} from "@/lib/sentinel/cutoffPoll";
import { AU_SLOTS } from "../../../worker/src/schedule";
import { runClock, type ClockEnv } from "../../../worker/src/clock";
import {
  announced,
  caDb,
  D0,
  D1,
  D2,
  D3,
  D4,
  D5,
  D6,
  io,
  nowOf,
  putBar,
  rows,
} from "../../corporateActions/helpers";
import { loadMigrations, migrateUp } from "@/lib/db/migrate-core.mjs";
import { cleanupTempDbs, freshDb, MIGRATIONS, tempDbUrl, track } from "../../db/helpers";
import { dumpTables, MARKET, NOW, setupReplay, type FullSetup } from "../../arena/replayHarness";
import { at1730, bar, count, pipelineDb, runs, text } from "../../pipeline/helpers";

vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });
afterEach(() => {
  cleanupTempDbs();
  vi.restoreAllMocks();
});

const HHMM = defaultAgentParams().decisionCutoff; // 18:10 Melbourne

/** The recorded day: what happens and when (Melbourne time, AEDT = UTC+11 from 2026-10-04). */
const RECORDED = {
  // GL-01 and GL-04 share batch 1's nine nights s0..s8 (Mon 12 Oct to Thu 22 Oct 2026)
  sessions: [
    "2026-10-12",
    "2026-10-13",
    "2026-10-14",
    "2026-10-15",
    "2026-10-16",
    "2026-10-19",
    "2026-10-20",
    "2026-10-21",
    "2026-10-22",
  ],
  fallSession: 1, // ZZA closes 48 % lower on s1, no announcement of any kind
  nullAdjSession: 3, // ZZC's bar on s3 has adj_close null
  // GL-05: Mon 26 Oct 2026
  annDay: "2026-10-26",
  published: "2026-10-26T07:08:00.000Z", // 18:08
  stored: "2026-10-26T07:11:20.000Z", // 18:11:20 (the poll that stores it ends here)
  // GL-06: Tue 13 Oct 2026, the Worker dispatches the 17:30 batch-1 slot and GitHub answers 401
  dispatchDay: "2026-10-13",
} as const;
const S = RECORDED.sessions;

// ------------------------------------------------------------------------------------------------
// Parts 1 and 4: batch 1 over nine nights
// ------------------------------------------------------------------------------------------------

const go = (db: Client, date: string, bars: unknown[]) =>
  runBatch1(db, {
    nowMs: () => at1730(date),
    barsText: text(bars),
    commitSha: "a".repeat(40),
    tiersHook: carryTiers,
  });
const details = (r: Record<string, unknown>) => JSON.parse(String(r.details_json));

/** One night of the recorded feed: ZZA falls 48 % on s1, ZZB and ZZC drift; ZZC's s3 bar has no adj_close. */
function nightBars(i: number): ReturnType<typeof bar>[] {
  const d = S[i]!;
  const drift = (code: string, px: number) =>
    bar(code, d, {
      open: px - 0.05,
      high: px + 0.2,
      low: px - 0.2,
      close: px,
      adj_close: px,
      volume: 1000 + 10 * i,
    });
  const a = i < RECORDED.fallSession ? 10.5 : 5.46; // 10.50 -> 5.46 is a 48 % fall
  return [
    drift("ZZA", a + (i % 2) * 0.01),
    drift("ZZB", 11.5 + (i % 3) * 0.01),
    i === RECORDED.nullAdjSession
      ? { ...drift("ZZC", 12.5), adj_close: null }
      : drift("ZZC", 12.5 + (i % 2) * 0.01),
  ];
}

describe("AT-42 parts 1 and 4: batch 1 over the recorded nights (GL-01, GL-04)", () => {
  async function recorded() {
    const db = await pipelineDb();
    const results = [];
    for (let i = 0; i < S.length; i++) results.push(await go(db, S[i]!, nightBars(i)));
    return { db, results };
  }

  it("GL-01: a 48 % fall with no announcement is queued, never auto-applied after 5+ sessions, entries stay blocked", async () => {
    const db = await pipelineDb();
    const fall = RECORDED.fallSession;
    for (let i = 0; i <= fall; i++) expect((await go(db, S[i]!, nightBars(i))).exit).toBe(0);

    // the night of the fall: one inferred action, queued for the Owner, a factor was NOT written
    let [action] = await loadActions(db, io(), "AU");
    expect(await count(db, "corporate_action")).toBe(1);
    expect(action).toMatchObject({ code: "ZZA", state: "owner", sources: ["price"] });
    expect(await count(db, "adjustment_factor")).toBe(0);
    expect(await entriesAllowed(db, "ZZA", S[fall]!)).toEqual({
      allowed: false,
      reason: "code_blocked",
    });
    // the Owner queue shows it, flagged "never applied automatically"
    const queue = await loadReviewQueue(db);
    expect(queue.cards).toHaveLength(1);
    expect(queue.cards[0]).toMatchObject({ code: "ZZA", neverAuto: true, queuedOn: S[fall] });

    // seven more sessions (the 5-session timer of DAT-221 is due from s6): nothing is applied
    for (let i = fall + 1; i < S.length; i++) {
      expect((await go(db, S[i]!, nightBars(i))).exit).toBe(0);
      expect(await count(db, "adjustment_factor")).toBe(0);
      expect(await entriesAllowed(db, "ZZA", S[i]!)).toMatchObject({ allowed: false });
    }
    const recs = (await runs(db)).filter((r) => r.job === "ingest-batch1");
    const appliedLate = recs
      .filter((r) => String(r.scheduled_for) >= S[6]!)
      .map((r) => details(r).stages.corporate_actions.applied_best_evidence);
    expect(appliedLate).toEqual([0, 0, 0]);
    [action] = await loadActions(db, io(), "AU");
    expect(action!.state).toBe("owner"); // still waiting for the Owner
    expect((await loadReviewQueue(db)).cards).toHaveLength(1);
    // the other codes are untouched
    for (const code of ["ZZB", "ZZC"]) {
      expect(await entriesAllowed(db, code, S[S.length - 1]!)).toMatchObject({ allowed: true });
    }
  });

  it("GL-04: a bar with a null adj_close is stored; it never rejects an otherwise valid bar", async () => {
    const { db, results } = await recorded();
    expect(results.every((r) => r.exit === 0)).toBe(true);
    const d = S[RECORDED.nullAdjSession]!;
    const stored = await rows(db, "SELECT code, c FROM price_bar WHERE d = ? ORDER BY code", [d]);
    expect(stored.map((r) => r.code)).toEqual(["ZZA", "ZZB", "ZZC"]);
    expect(stored.find((r) => r.code === "ZZC")).toMatchObject({ c: 12.5 });
    // nothing was quarantined or rejected for it, and the night's counts say so
    expect(await count(db, "price_bar")).toBe(S.length * 3);
    const rec = (await runs(db)).find((r) => r.scheduled_for === d)!;
    expect(rec.status).toBe("success");
    expect(details(rec).bars).toMatchObject({ valid: 3, inserted: 3, rejected: {} });
  });
});

// ------------------------------------------------------------------------------------------------
// Part 2: a corporate action confirmed at D+5
// ------------------------------------------------------------------------------------------------

describe("AT-42 part 2: a corporate action confirmed at D+5 (GL-02)", () => {
  const split21 = { new: 2, old: 1 };

  /** ZZB halves on the ex-date D1; the announcement is only confirmed on the evening of D5 (18:30). */
  async function lateSplit() {
    const db = await caDb(["ZZB"]);
    for (const d of [D0, D1, D2, D3, D4, D5, D6]) await putBar(db, "ZZB", d, d === D0 ? 10 : 5.1);
    await runCorporateActions({
      db,
      market: "AU",
      d: D5,
      io: io(),
      now: nowOf(D5),
      candidates: [announced("ZZB", "split", D1, split21)] as never,
    });
    return db;
  }

  it("decisions and replays for D..D+4 use the unadjusted bars; from D+5's evening cut-off the factor applies", async () => {
    const db = await lateSplit();
    const known = String((await rows(db, "SELECT known_at FROM corporate_action"))[0]!.known_at);
    expect(known.slice(0, 19)).toBe(nowOf(D5).slice(0, 19));
    // the confirmation is after D5's own 18:10 cut-off
    expect(known > decisionCutoffUtc(D5, HHMM)).toBe(true);

    // the decision/replay bar reader (cut-off bound) for each session
    for (const d of [D1, D2, D3, D4, D5]) {
      const bars = await adjustedBars(db, "ZZB", D0, d, {
        asOf: d,
        knownBy: decisionCutoffUtc(d, HHMM),
      });
      expect([bars[0]!.c, bars[0]!.factor], d).toEqual([10, 1]);
    }
    const after = await adjustedBars(db, "ZZB", D0, D5, {
      asOf: D6,
      knownBy: decisionCutoffUtc(D6, HHMM),
    });
    expect(after[0]!.c).toBe(5);

    // the decision's candidate layer (batch 2b): splitsKnownOn on the loaded confirmed actions
    const actions = await loadConfirmedActions(db, "AU", D6);
    expect(knownBy(actions, decisionCutoffUtc(D5, HHMM))).toEqual([]);
    expect(knownBy(actions, decisionCutoffUtc(D6, HHMM))).toHaveLength(1);
    const splits = splitActionsByCode(actions).byCode.get("ZZB")!;
    const raw = [D0, D1, D2].map((d) => ({
      d,
      open: 10_000_000n,
      high: 10_000_000n,
      low: 10_000_000n,
      close: 10_000_000n,
      volume: 1000n,
    }));
    for (const d of [D1, D2, D3, D4, D5]) {
      expect(
        adjustBars(raw, splitsKnownOn(splits, d, HHMM)).map((b) => b.close),
        d,
      ).toEqual(raw.map((b) => b.close));
    }
    expect(adjustBars(raw, splitsKnownOn(splits, D6, HHMM))[0]!.close).toBe(5_000_000n);

    // the offline replay snapshot carries known_at and applies the same rule
    const rec = corpRecordsOf({
      corporateActions: [
        { code: "ZZB", ex_date: D1, action_id: 1, type: "split", factor: 0.5, known_at: known },
      ],
    } as never);
    const replaySplits = splitActionsByCode(rec).byCode.get("ZZB")!;
    for (const d of [D1, D2, D3, D4, D5]) expect(splitsKnownOn(replaySplits, d, HHMM)).toEqual([]);
    expect(splitsKnownOn(replaySplits, D6, HHMM)).toHaveLength(1);
  });
});

// ------------------------------------------------------------------------------------------------
// Part 3: an order whose open gaps +3 %
// ------------------------------------------------------------------------------------------------

describe("AT-42 part 3: an order whose open gaps +3 % (GL-03)", () => {
  const TICK = 10_000n;
  const roundTick = (v: bigint): bigint => (v / TICK) * TICK;

  /**
   * The harness world up to session 1 (the future does not exist), then session 2 written by hand:
   * ZZA opens `gapBps` above session 1's close and stays there (o = h = l = c), ZZB is flat.
   * `live` runs batch 2a as production does (market full, no replay flag); otherwise as a replay.
   */
  async function world(gapBps: bigint, live: boolean) {
    const s: FullSetup = await setupReplay({
      startD: "2030-01-07",
      sessions: 70,
      seed: 3,
      keep: ["E01"],
      stopAfter: 1,
    });
    const { db, ds } = s;
    const cohort = s.cohortIds.find((id) => id.startsWith("E01@")) as string;
    const [d1, d2] = [ds.dates[1]!, ds.dates[2]!];
    const mode = live ? "full" : "data_only";
    await db.execute({ sql: "UPDATE market SET mode = ? WHERE code = ?", args: [mode, MARKET] });
    const close = (code: string) => ds.closes.get(`${d1}|${code}`)!;
    const openA = roundTick((close("ZZA") * (10_000n + gapBps)) / 10_000n);
    const px = (v: bigint) => Number(v) / 1e6;
    const stmts: { sql: string; args: (string | number)[] }[] = [];
    for (const [code, v] of [
      ["ZZA", openA],
      ["ZZB", close("ZZB")],
    ] as const) {
      stmts.push({
        sql: `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
              VALUES ('AU', ?, ?, ?, ?, ?, ?, ?, 'synthetic', ?, ?)`,
        args: [
          code,
          d2,
          px(v),
          px(v),
          px(v),
          px(v),
          5_000_000,
          `${d2}T06:30:00.000Z`,
          `${d2}T07:00:00.000Z`,
        ],
      });
    }
    for (const code of ["ZZA", "ZZB"]) {
      stmts.push({
        sql: `INSERT INTO universe_snapshot (market, d, code, status, tier, mcap_est, adv, halted)
              VALUES ('AU', ?, ?, 'active', 'U1', NULL, NULL, 0)`,
        args: [d2, code],
      });
    }
    for (const tier of ["U1", "U2", "U3"]) {
      stmts.push({
        sql: "INSERT INTO quality_score (market, d, tier, valid, expected, score, gate_pass) VALUES ('AU', ?, ?, 10, 10, 100, 1)",
        args: [d2, tier],
      });
    }
    stmts.push({
      sql: "INSERT INTO completion_marker (market, d, kind, at, run_id, outcome) VALUES ('AU', ?, 'data', ?, 3, 'ok')",
      args: [d2, `${d2}T07:30:00.000Z`],
    });
    await db.batch(stmts as never, "write");

    const run = (d: string): Promise<CloseBooksResult> =>
      closeBooksDay(
        db,
        live ? { market: MARKET, d, now: NOW } : { market: MARKET, d, replay: true, now: NOW },
      );
    expect((await run(ds.dates[0]!)).status).toBe("success");
    expect((await run(d1)).status).toBe("success");
    // the plan: 98.5 % of the cohort's cash at session 1's close, decided after the close of d1
    const cash = toBig(
      (
        await db.execute({
          sql: "SELECT nav_micro AS n FROM nav_daily WHERE cohort_id = ? AND d = ?",
          args: [cohort, d1],
        })
      ).rows[0]!.n,
    );
    const planned = (cash * 985n) / 1000n / close("ZZA");
    const order = (id: string, code: string, qty: bigint) =>
      db.execute({
        sql: `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty, ref_stop_micro, tier)
              VALUES (?, ?, ?, ?, 'buy', 'entry', ?, 500000, 'U1')`,
        args: [id, cohort, d1, code, qty],
      });
    await order("O1", "ZZA", planned);
    await order("O2", "ZZB", 400n); // would need a marketable parcel from what is left
    expect((await run(d2)).status).toBe("success");
    const one = async (sql: string) => (await db.execute(sql)).rows[0]!;
    return {
      db,
      planned,
      o1: await one("SELECT status, reject_reason FROM arena_order WHERE id = 'O1'"),
      o2: await one("SELECT status, reject_reason FROM arena_order WHERE id = 'O2'"),
      fillQty: async (id: string) =>
        toBig(
          (await db.execute({ sql: "SELECT qty FROM fill WHERE order_id = ?", args: [id] })).rows[0]
            ?.qty ?? 0,
        ),
      badInvariants: toBig(
        (await one("SELECT COUNT(*) AS n FROM nav_daily WHERE invariants_ok = 0")).n,
      ),
      dump: await dumpTables(db),
    };
  }

  it("+3 % gap: the order is resized (not cancelled); the second order cancels as cash; invariants hold", async () => {
    const w = await world(300n, true);
    expect(w.planned).toBeGreaterThan(20n);
    expect(String(w.o1.status)).toBe("filled");
    const qty = await w.fillQty("O1");
    expect(qty).toBeGreaterThan(0n);
    expect(qty).toBeLessThan(w.planned); // cut to what the cash buys at the actual open
    // the cut is "the largest affordable parcel": about 3 % smaller than the plan
    expect(qty * 10_000n).toBeGreaterThan(w.planned * 9_500n);
    // one marketable parcel is unaffordable for the rest: cancelled, reason cash, no fill row
    expect(String(w.o2.status)).toBe("cancelled");
    expect(String(w.o2.reject_reason)).toBe("cash");
    expect(await w.fillQty("O2")).toBe(0n);
    expect(w.badInvariants).toBe(0n);
  });

  it("no gap: the planned quantity is kept (nothing is resized)", async () => {
    const w = await world(0n, true);
    expect(String(w.o1.status)).toBe("filled");
    expect(await w.fillQty("O1")).toBe(w.planned);
    expect(w.badInvariants).toBe(0n);
  });

  it("replay = live: the same orders and bars give the same fills, ledger and NAV", async () => {
    const live = await world(300n, true);
    const replay = await world(300n, false);
    expect(String(replay.o1.status)).toBe("filled");
    expect(await replay.fillQty("O1")).toBe(await live.fillQty("O1"));
    expect(String(replay.o2.reject_reason)).toBe("cash");
    expect(replay.dump).toEqual(live.dump);
  });
});

// ------------------------------------------------------------------------------------------------
// Part 5: an announcement published 18:08 and ingested 18:11
// ------------------------------------------------------------------------------------------------

describe("AT-42 part 5: an announcement published 18:08, ingested 18:11 (GL-05)", () => {
  const DAY = RECORDED.annDay;
  const CUT = decisionCutoffUtc(DAY, HHMM);
  const at = (hms: string) => `${DAY}T${hms}.000Z`;
  const item = (key: string, symbol: string, published: string) => ({
    symbol,
    date: published,
    documentKey: key,
    headline: `Update ${key}`,
    isPriceSensitive: true,
    announcementTypes: ["Trading update"],
  });

  /** A migrated file DB plus a feed directory: the store step (asxIngestMain) is the real one. */
  async function station() {
    const dbFile = await freshDbFile();
    const dir = mkdtempSync(path.join(tmpdir(), "at42-asx-"));
    /** One poll: the feed fetched at `fetched`, its store step finishing at `stored`. */
    const poll = async (items: unknown[], fetched: string, stored: string) => {
      writeFileSync(path.join(dir, "feed.json"), JSON.stringify({ data: { items } }));
      const t = new Date(fetched);
      utimesSync(path.join(dir, "feed.json"), t, t);
      const lines: string[] = [];
      const exit = await asxIngestMain(
        ["--dir", dir],
        { TURSO_MAIN_URL: dbFile.url, TURSO_MAIN_TOKEN: "t" },
        {
          nowMs: () => Date.parse(stored),
          out: (l) => lines.push(l),
          openDb: (u) => createClient({ url: u }),
        },
      );
      expect(exit, lines.join("|")).toBe(0);
    };
    return { db: dbFile.db, poll };
  }

  /** Who sees what for the decision of DAY: the live view, the replay view and the offline snapshot. */
  async function views(db: Client) {
    const { bound, missing } = await loadIngestBound(db, "AU", DAY, CUT);
    const ids = async (live: boolean) =>
      (
        await createDecisionView(db, {
          market: "AU",
          d: DAY,
          cutoff: CUT,
          liveIngestBound: live,
          announcementIngestBound: bound,
        }).announcements({ codes: ["ZZA", "ZZB"] })
      )
        .map((a) => a.ann_id)
        .sort();
    const marker = await readCutoffPoll(db, "AU", DAY);
    const markers = new Map(marker === null ? [] : [[DAY, marker]]);
    const all = await rows(
      db,
      "SELECT code, ann_id, published_at, first_ingested_at FROM announcement ORDER BY ann_id",
    );
    const snapshot = all
      .filter((a) =>
        snapshotAnnouncementVisible(
          {
            code: String(a.code),
            ann_id: String(a.ann_id),
            published_at: String(a.published_at),
            first_ingested_at: a.first_ingested_at === null ? null : String(a.first_ingested_at),
          },
          markers,
          HHMM,
        ),
      )
      .map((a) => String(a.ann_id))
      .sort();
    return { bound, missing, live: await ids(true), replay: await ids(false), snapshot };
  }

  it("published 18:08 and stored by the poll that finishes 18:11:20: visible, live = replay = snapshot", async () => {
    const { db, poll } = await station();
    await poll([item("A1", "ZZA", RECORDED.published)], at("07:11:00"), RECORDED.stored);
    expect(await readCutoffPoll(db, "AU", DAY)).toBe(RECORDED.stored); // the marker: 18:11:20
    const stored = await rows(db, "SELECT published_at, first_ingested_at FROM announcement");
    expect(stored).toEqual([
      { published_at: RECORDED.published, first_ingested_at: RECORDED.stored },
    ]);
    const v = await views(db);
    expect(v.bound).toBe(RECORDED.stored);
    expect(v.missing).toBe(false);
    expect(v.live).toHaveLength(1);
    expect(v.replay).toEqual(v.live);
    expect(v.snapshot).toEqual(v.live);
  });

  it("an item first stored after the marker poll is invisible to the decision in all three readers", async () => {
    const { db, poll } = await station();
    // the first poll fetched after 18:10 finishes at 18:10:30 and carries only an older item ...
    await poll([item("OLD", "ZZB", at("07:00:00"))], at("07:10:05"), at("07:10:30"));
    // ... the 18:08 item reaches us with the next poll, at 18:11:20: after the marker
    await poll(
      [item("OLD", "ZZB", at("07:00:00")), item("A1", "ZZA", RECORDED.published)],
      at("07:11:00"),
      RECORDED.stored,
    );
    expect(await readCutoffPoll(db, "AU", DAY)).toBe(at("07:10:30")); // insert-once: the first stays
    const v = await views(db);
    expect(v.bound).toBe(at("07:10:30"));
    expect(v.live).toHaveLength(1);
    expect(v.replay).toEqual(v.live);
    expect(v.snapshot).toEqual(v.live);
    const ids = (await rows(db, "SELECT ann_id FROM announcement WHERE code = 'ZZB'")).map((r) =>
      String(r.ann_id),
    );
    expect(v.live).toEqual(ids); // only the ZZB item the decision could have seen
  });

  it("a poll that completes after 18:14 does not count as the marker: the 18:14 bound applies, live = replay", async () => {
    const { db, poll } = await station();
    await poll([item("A1", "ZZA", RECORDED.published)], at("07:09:00"), at("07:09:20")); // before the cut-off
    await poll(
      [item("A1", "ZZA", RECORDED.published), item("LATE", "ZZB", at("07:09:30"))],
      at("07:16:00"),
      at("07:16:20"),
    );
    const v = await views(db);
    expect(v.missing).toBe(true); // the late marker (18:16:20) is treated as missing
    expect(v.bound).toBe(at("07:14:00"));
    expect(v.live.length).toBe(1); // A1 (stored 18:09:20); LATE (stored 18:16:20) is out
    expect(v.replay).toEqual(v.live);
    expect(v.snapshot).toEqual(v.live);
  });

  it("batch 2b's wait is bounded by the same 4-minute window", async () => {
    const { db, poll } = await station();
    let t = Date.parse(at("07:10:05"));
    const clock = { nowMs: () => t, sleep: async (ms: number) => void (t += ms) };
    // no marker: it gives up at cut-off + 4 minutes and never waits longer than that
    expect(await waitForCutoffPoll(db, { market: "AU", d: DAY, cutoffIso: CUT, ...clock })).toBe(
      false,
    );
    expect(t - Date.parse(at("07:10:05"))).toBeLessThanOrEqual(CUTOFF_POLL_WINDOW_MS);
    expect(t).toBe(Date.parse(at("07:14:00")));
    // with the 18:11:20 marker it returns at once
    await poll([item("A1", "ZZA", RECORDED.published)], at("07:11:00"), RECORDED.stored);
    const before = t;
    expect(await waitForCutoffPoll(db, { market: "AU", d: DAY, cutoffIso: CUT, ...clock })).toBe(
      true,
    );
    expect(t).toBe(before);
  });
});

async function freshDbFile(): Promise<{ url: string; db: Client }> {
  // the store step opens its own connection to the same file
  const url = tempDbUrl();
  const db = track(createClient({ url }));
  await migrateUp(db, await loadMigrations(MIGRATIONS("main")));
  return { url, db };
}

// ------------------------------------------------------------------------------------------------
// Part 6: a forced HTTP 401 dispatch
// ------------------------------------------------------------------------------------------------

describe("AT-42 part 6: a forced HTTP 401 dispatch (GL-06)", () => {
  const TOKEN = "ghp_AT42_SECRET_dispatch_value";
  const WENV: ClockEnv = {
    PRAXIS_ENV: "production",
    GITHUB_DISPATCH_TOKEN: TOKEN,
    TURSO_MAIN_URL: "libsql://at42-main.turso.io",
    TURSO_MAIN_TOKEN: "turso-at42",
  };
  /** Turso HTTP pipeline over the libSQL file, and a GitHub that answers every dispatch with 401. */
  function net(db: Client) {
    const github: string[] = [];
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://api.github.com/")) {
        github.push(url);
        return new Response('{"message":"Bad credentials"}', { status: 401 });
      }
      const reqs = JSON.parse(String(init?.body)).requests as {
        type: string;
        stmt?: { sql: string; args?: { type: string; value?: string }[] };
      }[];
      const results: unknown[] = [];
      for (const r of reqs) {
        if (r.type !== "execute" || !r.stmt) {
          results.push({ type: "ok" });
          continue;
        }
        const args = (r.stmt.args ?? []).map((a) =>
          a.type === "null" ? null : a.type === "integer" ? Number(a.value) : (a.value ?? null),
        );
        const res = await db.execute({ sql: r.stmt.sql, args });
        const out = res.rows.map((row) =>
          Array.from({ length: res.columns.length }, (_, i) => {
            const v = row[i];
            if (v === null || v === undefined) return { type: "null" };
            return typeof v === "number" || typeof v === "bigint"
              ? { type: "integer", value: String(v) }
              : { type: "text", value: String(v) };
          }),
        );
        results.push({
          type: "ok",
          response: {
            type: "execute",
            result: { rows: out, affected_row_count: res.rowsAffected },
          },
        });
      }
      return Response.json({ results });
    }) as typeof fetch;
    return { f, github };
  }

  it("the refused dispatch is recorded with its status; the evening heartbeat raises one S2 incident and one email", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const db = await freshDb("main");
    await db.execute(
      "INSERT INTO worker_state (key, value_json, updated_at) VALUES ('dispatch_enabled', '\"1\"', 'x')",
    );
    const { f, github } = net(db);
    const t0 = Date.UTC(2026, 9, 13, 17 - 11, 30); // Tue 13 Oct, 17:30 AEDT: the batch-1 slot
    for (let k = 0; k < 4; k++) {
      await runClock(WENV, t0 + k * 60_000, { fetch: f, nowMs: () => t0 + k * 60_000 }, AU_SLOTS);
    }
    expect(github.length).toBeGreaterThanOrEqual(3);
    const failed = await rows(
      db,
      "SELECT concurrency_key, details_json FROM run_record WHERE status = 'failed' AND concurrency_key LIKE 'dispatch-failed:%' ORDER BY id",
    );
    expect(failed.length).toBe(3); // MAX_ATTEMPTS, then no fourth
    for (const r of failed) {
      expect(JSON.parse(String(r.details_json))).toMatchObject({
        slot: "ingest-batch1",
        status: 401,
        reason: "HTTP 401",
      });
      expect(String(r.details_json) + String(r.concurrency_key)).not.toContain(TOKEN);
    }

    // the same night: evening heartbeat 22:10 Melbourne
    await db.execute(
      "INSERT INTO worker_state (key, value_json, updated_at) VALUES ('email_mode', '\"incidents\"', 'x')",
    );
    const mock = createMockProvider();
    const env = {
      EMAIL_PROVIDER: "mock",
      OWNER_EMAIL: "owner@example.test",
      APP_BASE_URL: "https://praxis.example.test",
      PII_HASH_KEY: "k".repeat(64),
      PRAXIS_ENV: "production",
      CRON_SECRET: "c".repeat(32),
      BACKUP_PUBLIC_KEY: "age1fake",
    };
    const handler = createHeartbeatHandler("evening", {
      env,
      mainDb: () => db,
      now: () => new Date(`${RECORDED.dispatchDay}T11:10:00.000Z`),
      provider: mock,
      sleep: async () => {},
    });
    const req = () =>
      new Request("https://x.test/api/cron/heartbeat-evening", {
        headers: { Authorization: `Bearer ${env.CRON_SECRET}` },
      });
    expect((await handler(req())).status).toBe(200);
    await handler(req()); // idempotent per date

    const inc = await rows(
      db,
      "SELECT id, kind, severity, resolved_at FROM incident WHERE kind = 'dispatch_auth'",
    );
    expect(inc).toHaveLength(1);
    expect(inc[0]).toMatchObject({ severity: "S2" });
    const mails = await rows(
      db,
      "SELECT email_key, status FROM email_message WHERE email_key = ?",
      [`inc:${inc[0]!.id}:open`],
    );
    expect(mails).toHaveLength(1);
    expect(mails[0]!.status).toBe("sent");
    expect(mock.outbox.filter((m) => /dispatch/i.test(m.subject))).toHaveLength(1);
    // the credential never reaches the incident, the email or the run record
    const everything = JSON.stringify([
      await rows(db, "SELECT * FROM incident"),
      await rows(db, "SELECT * FROM run_record"),
      mock.outbox,
    ]);
    expect(everything).not.toContain(TOKEN);
  });
});
