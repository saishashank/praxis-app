// @vitest-environment node
// D-909: the Evening Review's next-day check: last night's picks graded, and the session's biggest
// gainers and losers with what the system saw (picked, signalled and blocked why, not seen) and the
// news behind the move (before the open, during the day, none). Synthetic ZZ codes and dates.
import type { Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderReview } from "@/lib/email/templates";
import { newsWords, readMissedMovers, seenWords } from "@/lib/review/missedMovers";
import type { Ctx } from "@/lib/review/sections";
import { cleanupTempDbs, freshDb } from "../db/helpers";

const PREV = "2030-03-04"; // Monday
const D = "2030-03-05"; // Tuesday
let db: Client;

const bar = (code: string, d: string, c: number, h = c, l = c) =>
  db.execute({
    sql: `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
          VALUES ('AU', ?, ?, ?, ?, ?, ?, 100000, 'test', ?, ?)`,
    args: [code, d, c, h, l, c, `${d}T07:00:00.000Z`, `${d}T07:00:00.000Z`],
  });
const uni = (code: string, tier: string, status = "active") =>
  db.execute({
    sql: `INSERT INTO universe_snapshot (market, d, code, status, tier, mcap_est, adv, halted)
          VALUES ('AU', ?, ?, ?, ?, 1e9, 1e7, 0)`,
    args: [D, code, status, tier],
  });

beforeAll(async () => {
  db = await freshDb("main");
  // 12 liquid codes: ZZG1..ZZG6 rise 6 % .. 1 %, ZZL1..ZZL6 fall; one U3 code moves 50 % (ignored)
  for (let i = 1; i <= 6; i += 1) {
    await uni(`ZZG${i}`, "U1");
    await bar(`ZZG${i}`, PREV, 10);
    await bar(`ZZG${i}`, D, 10 * (1 + (7 - i) / 100), 11, 9.6);
    await uni(`ZZL${i}`, "U2");
    await bar(`ZZL${i}`, PREV, 10);
    await bar(`ZZL${i}`, D, 10 * (1 - (7 - i) / 100));
  }
  await uni("ZZU3", "U3");
  await bar("ZZU3", PREV, 1);
  await bar("ZZU3", D, 1.5);
  // ZZG1 was last night's pick; ZZG2 had an F4 signal whose trade was blocked by the stop distance
  await db.execute({
    sql: `INSERT INTO pick (market, d, profile, rank, code, family, tier, rule_version, signal_id, label,
            reference_micro, buy_max_micro, valid_until_d, stop_micro, aim_micro, n_similar, size_micro,
            risk_micro, factors_json, based_on_json, pick_sha, created_at)
          VALUES ('AU', ?, 'P1', 1, 'ZZG1', 'F1', 'U1', 'F1.v1', 'sig-p', 'UNVALIDATED', 10000000, 10050000,
            ?, 9500000, 10800000, 45, 1000000000, 50000000, '[]', '[]', ?, ?)`,
    args: [PREV, D, "a".repeat(64), `${PREV}T07:00:00.000Z`],
  });
  await db.execute({
    sql: `INSERT INTO signal (id, market, d, family, rule_version, variant, code, regime, rank_score,
            rules_json, evidence_json, partial, schema_version, agent_version, inputs_ref, decided_at)
          VALUES ('sig-g2', 'AU', ?, 'F4', 'F4.v1', 'U', 'ZZG2', 'NEUTRAL', '1/1', '[]', '{}', 0, 1, 't', 'r', ?)`,
    args: [PREV, `${PREV}T07:00:00.000Z`],
  });
  await db.execute({
    sql: `INSERT INTO blocked_trade (signal_id, execution_id, market, d, reason)
          VALUES ('sig-g2', 'F4-U', 'AU', ?, 'skipped_stop_distance')`,
    args: [PREV],
  });
  // ZZL1 fell on a price-sensitive announcement at 08:30 Sydney (before the open)
  await db.execute({
    sql: `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, price_sensitive, title, url, source)
          VALUES ('AU', 'ZZL1', 'a1', ?, ?, 'report', 1, 'Guidance downgrade', NULL, 'asx')`,
    args: [`${PREV}T21:30:00.000Z`, `${PREV}T21:31:00.000Z`],
  });
});

afterAll(cleanupTempDbs);

const ctx = (): Ctx =>
  ({
    db,
    market: "AU",
    d: D,
    env: "production",
    appUrl: "https://example.test",
    now: new Date(`${D}T09:00:00.000Z`),
    currency: "AUD",
    mode: "full",
    tradingDay: true,
    calendar: [],
  }) as unknown as Ctx;

describe("readMissedMovers", () => {
  it("lists the biggest liquid gainers and losers with what we saw and why", async () => {
    const f = (await readMissedMovers(ctx()))!;
    expect(f.gainers.map((g) => g.code)).toEqual(["ZZG1", "ZZG2", "ZZG3", "ZZG4", "ZZG5", "ZZG6"]);
    expect(f.losers.map((g) => g.code)).toEqual(["ZZL1", "ZZL2", "ZZL3", "ZZL4", "ZZL5", "ZZL6"]);
    expect(f.gainers.map((g) => g.code)).not.toContain("ZZU3"); // illiquid tier left out
    expect(f.gainers[0]).toMatchObject({ seen: "picked last night", movePpm: 60_000 });
    expect(f.gainers[1]!.seen).toBe("signalled by F4, trade blocked: the stop was too far away");
    expect(f.gainers[2]!.seen).toBe("no strategy signalled it");
    expect(f.losers[0]!.news).toBe('price-sensitive news before the open: "Guidance downgrade"');
    expect(f.losers[1]!.news).toBe("no announcement (market or sector move?)");
  });

  it("grades last night's picks against today's bar", async () => {
    const f = (await readMissedMovers(ctx()))!;
    expect(f.lines[0]).toBe(
      "Last night's pick today: 1 closed above the reference price, 1 touched the aim, 0 touched the stop.",
    );
    expect(f.lines[1]).toBe(
      "Track record: no pick has closed yet, so there is no hit rate to compare.",
    );
    expect(f.lines[2]).toBe(
      "Of today's 12 biggest movers (top gainers and losers, liquid shares), 2 were seen by a strategy or picked.",
    );
  });

  it("nothing on a non-trading day", async () => {
    expect(await readMissedMovers({ ...ctx(), tradingDay: false })).toBeNull();
  });
});

describe("plain words", () => {
  it("seenWords and newsWords", () => {
    expect(seenWords({ picked: false, families: ["F2", "F1", "F2"], blocked: [] })).toBe(
      "signalled by F1, F2, not a pick",
    );
    expect(seenWords({ picked: false, families: ["F1"], blocked: ["skipped_cash_short"] })).toBe(
      "signalled by F1, trade blocked: cash short",
    );
    const during = [
      { publishedAt: `${D}T03:00:00.000Z`, sensitive: true, title: "Takeover offer" },
    ];
    expect(newsWords(D, during)).toBe(
      'price-sensitive news during the day (not knowable at the open): "Takeover offer"',
    );
    expect(newsWords(D, [{ ...during[0]!, sensitive: false }])).toBe("only routine announcements");
  });

  it("renders in section 6 of the review", async () => {
    const f = (await readMissedMovers(ctx()))!;
    const html = JSON.stringify(
      renderReview({
        variant: "full",
        env: "production",
        date: D,
        appUrl: "https://example.test",
        arenaActive: true,
        executions: [],
        scorecard: { healthyComponents: 1, totalComponents: 1, attention: [] },
        orders: [],
        narrative: null,
        stats: null,
        alerts: [],
        breakerHits: [],
        health: [],
        suppressedEmails: 0,
        missedMovers: f,
      }),
    );
    expect(html).toContain("What we missed today");
    expect(html).toContain("Biggest gainers");
    expect(html).toContain("trade blocked: the stop was too far away");
  });
});

describe("track record (D-909)", () => {
  it("compares the closed picks' hit rate with what their history said and with the luck twins", async () => {
    const { trackRecordText } = await import("@/lib/review/missedMovers");
    expect(trackRecordText([])).toBe(
      "Track record: no pick has closed yet, so there is no hit rate to compare.",
    );
    const h = (p: number) =>
      JSON.stringify([
        `History: 45 similar past trades in the development replay; ${p} % of them ended with a net gain`,
      ]);
    expect(
      trackRecordText([
        { kind: "pick", netPpm: 20_000, basedOn: h(60) },
        { kind: "pick", netPpm: -10_000, basedOn: h(50) },
        { kind: "pick", netPpm: 5_000, basedOn: "[]" },
        { kind: "luck", netPpm: -1, basedOn: "[]" },
        { kind: "luck", netPpm: 3, basedOn: "[]" },
      ]),
    ).toBe(
      "Track record so far: 3 picks closed, 2 with a net gain (67 %); their history said 55 % on average; luck-check twins 1 of 2 (50 %).",
    );
  });
});
