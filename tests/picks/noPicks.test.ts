// @vitest-environment node
// OPS-110 / D-941: a night with no picks says why, in plain words (never a silent zero).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import {
  countBlocks,
  firstBlock,
  noPicksSentence,
  readNoPicksLine,
  recordPicksNight,
} from "@/lib/picks/noPicks";
import { runPicksNight } from "@/lib/picks/nightly";
import type { PickInput } from "@/lib/picks/types";
import { cleanupTempDbs } from "../db/helpers";
import {
  D,
  MARKET,
  NOW,
  addBars,
  addSignal,
  addUniverse,
  params,
  world,
  type CodeSpec,
} from "./harness";

const base = (o: Partial<PickInput> = {}): PickInput =>
  ({
    signalId: "1",
    cardId: "1",
    family: "F1",
    ruleVersion: "F1.v1",
    variant: "U",
    code: "ZZA1",
    tier: "U1",
    rankScore: "1/1",
    label: "UNVALIDATED",
    referenceMicro: 10_000_000n,
    stopMicro: 9_000_000n,
    advValueMicro: 1n,
    vol: null,
    scenario: { n: 40, badPpm: -50_000, typicalPpm: 20_000, goodPpm: 90_000 },
    aimReachPpm: null,
    holdMedianSessions: 5,
    medianDropPpm: null,
    factors: [],
    basedOn: [],
    ...o,
  }) as PickInput;

describe("first blocking reason", () => {
  it("names the first missing piece", () => {
    expect(firstBlock(base())).toBeNull();
    expect(firstBlock(base({ scenario: null }))).toBe("no_history");
    expect(firstBlock(base({ stopMicro: null }))).toBe("no_stop");
    expect(firstBlock(base({ stopMicro: 10_000_000n }))).toBe("no_stop");
    expect(firstBlock(base({ holdMedianSessions: null }))).toBe("no_hold");
    expect(firstBlock(base({ scenario: { n: 40, badPpm: -1, typicalPpm: 0, goodPpm: 0 } }))).toBe(
      "no_aim",
    );
  });
  it("counts reasons and treats a candidate that passes the basics as profile rules", () => {
    expect(countBlocks([base({ scenario: null }), base({ scenario: null }), base()])).toEqual({
      no_history: 2,
      profile_rules: 1,
    });
  });
});

describe("the plain-words line", () => {
  it("explains missing history without a stock, a run time or a code", () => {
    const s = noPicksSentence({ signals: 8, shortlist: 0, blocked: { no_history: 8 } });
    expect(s).toBe(
      "No picks tonight: 8 strategy signals fired, but not enough similar past trades yet to show what it could gain or lose, and no stock passed the shortlist's trend rule.",
    );
    expect(s).not.toMatch(/\d{2}:\d{2}|ZZ|F1/);
  });
  it("says so when no strategy fired, singular signal, unreadable shortlist", () => {
    expect(noPicksSentence({ signals: 0, shortlist: -1, blocked: {} })).toBe(
      "No picks tonight: no strategy gave a buy signal, and the shortlist could not be read.",
    );
    expect(noPicksSentence({ signals: 1, shortlist: 3, blocked: { profile_rules: 1 } })).toBe(
      "No picks tonight: 1 strategy signal fired, but it did not fit any profile's rules, and none of the shortlist stocks fit any profile's rules.",
    );
    expect(
      noPicksSentence({
        signals: 3,
        shortlist: 0,
        blocked: { no_stop: 1, no_hold: 1, no_aim: 1 },
      }),
    ).toContain("no safe stop-loss level; no usable holding time or aim");
  });
});

describe("a night with candidates but no history publishes nothing and says why", () => {
  let db: Client;
  beforeAll(async () => {
    const w = await world();
    db = w.db;
    const spec: CodeSpec = { code: "ZZA1", tier: "U1", base: 10_000_000n, step: 0n };
    await addBars(w.run, spec, 0, 60);
    await addUniverse(w.run, D, [spec]);
    await addSignal(w.run, {
      d: D,
      family: "F1",
      rv: "F1.v1",
      code: "ZZA1",
      tier: "U1",
      closeMicro: 10_000_000n,
      rank: "9/1",
    });
  });
  afterAll(cleanupTempDbs);

  it("returns the reason, stores it with the night and reads it back", async () => {
    const r = await runPicksNight(db, {
      market: MARKET,
      d: D,
      params,
      calendar: [],
      now: NOW,
    });
    expect(r.published).toBe(0);
    expect(r.blocked.no_history ?? 0).toBeGreaterThanOrEqual(1);
    expect(r.noPicksLine).toMatch(/^No picks tonight: 1 strategy signal fired, but not enough/);
    await recordPicksNight(db, {
      market: MARKET,
      d: D,
      now: NOW,
      published: r.published,
      candidates: r.candidates,
      shortlist: r.shortlist,
      blocked: r.blocked,
      line: r.noPicksLine,
    });
    await recordPicksNight(db, {
      market: MARKET,
      d: D,
      now: NOW,
      published: 0,
      candidates: 0,
      shortlist: 0,
      blocked: {},
      line: "No picks tonight: second write is ignored.",
    });
    expect(await readNoPicksLine(db, MARKET, D)).toBe(r.noPicksLine);
    expect(await readNoPicksLine(db, MARKET, null)).toBe(r.noPicksLine);
    expect(await readNoPicksLine(db, MARKET, "2000-01-01")).toBeNull();
  });
});
