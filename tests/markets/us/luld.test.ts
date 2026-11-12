// @vitest-environment node
// M20 A5 (DAT-244, CTX-016, D-1110 F; AT-70 LULD clause): `trading_halt` rows drive the same halt machine as AU through
// the US halt model. A halt covering the session open = a halted session: no exit fill inside [halted_at, resumed_at),
// the position marked at the last trade, re-scored at the reopen bar (the first session whose open is outside the
// window); a suspension row takes the CTX-016 suspension path with its declining mark; an intraday pause that does not
// cover the open is not a halted session. AU's cx16 model leaves the machine byte-identical.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import { fillOrder, type FillOrderEnv } from "@/lib/arena/fills";
import { COST_PROFILES } from "@/lib/arena/costs";
import { buildAsOfView } from "@/lib/cortex/pit/asOfView";
import {
  CX16_MODEL,
  haltStateAt,
  markAtPct,
  stepHalt,
  suspensionMarkPct,
  type HaltSourceRow,
  type HaltState,
  type HaltStep,
} from "@/lib/cortex/states/halt";
import {
  haltCoversInstant,
  haltedAtInstant,
  haltModelFor,
  loadHaltRows,
  luldModel,
} from "@/lib/cortex/states/luld";
import { haltReader } from "@/lib/cortex/profileReaders";
import { staticProfile } from "@/lib/market/staticProfile.mjs";
import { allowMarket, cleanupTempDbs, freshDb } from "../../db/helpers";
import { CENT, path, SESSIONS, statesWorld, type FixtureSpec } from "../../cortex/states/zzStates";

const open = (d: string): string => `${d}T14:30:00.000Z`; // 09:30 New York, winter time (the test sessions are in February)
const model = luldModel({ sessionOpenUtc: open });
const S = (i: number): string => SESSIONS[i]!;
const c = (cents: number): bigint => BigInt(cents) * CENT;

function spec(opens: Record<number, number> = {}): FixtureSpec {
  const closes = path(1000, SESSIONS.length, []);
  return {
    code: "ZZ1",
    tier: "U1",
    bars: { closesCents: closes, opensCents: closes.map((v, i) => opens[i] ?? v) },
  };
}

function walk(s: FixtureSpec, upTo: number, rows: readonly HaltSourceRow[], m = model): HaltStep[] {
  const view = buildAsOfView(statesWorld([s]));
  const out: HaltStep[] = [];
  let prev: HaltState | null = null;
  for (let t = 0; t <= upTo; t += 1) {
    const step = stepHalt(view, s.code, t, prev, undefined, { model: m, rows });
    out.push(step);
    prev = step.next;
  }
  return out;
}

describe("a halt row covers a session when it covers the session open", () => {
  it("[halted_at, resumed_at) is half-open; no resumed_at = still halted", () => {
    const r: HaltSourceRow = {
      kind: "luld",
      haltedAt: "2026-02-10T14:00:00Z",
      resumedAt: "2026-02-10T14:30:00Z",
    };
    expect(haltCoversInstant(r, "2026-02-10T14:00:00Z")).toBe(true);
    expect(haltCoversInstant(r, "2026-02-10T14:29:59Z")).toBe(true);
    expect(haltCoversInstant(r, "2026-02-10T14:30:00Z")).toBe(false);
    expect(haltCoversInstant(r, "2026-02-10T13:59:59Z")).toBe(false);
    expect(
      haltCoversInstant(
        { kind: "halt", haltedAt: "2026-02-10T14:00:00Z", resumedAt: null },
        "2026-03-01T00:00:00Z",
      ),
    ).toBe(true);
  });
});

describe("a luld halt over the open of two sessions", () => {
  // halted from 09:00 on session 20 to 09:35 on session 21: the open of 20 and of 21 fall inside; 22 reopens
  const rows: HaltSourceRow[] = [
    { kind: "luld", haltedAt: `${S(20)}T14:00:00.000Z`, resumedAt: `${S(21)}T14:35:00.000Z` },
  ];

  it("starts a halt on the first covered session: entries and exit fills blocked, marked at the last trade", () => {
    const steps = walk(spec(), 22, rows);
    const s = steps[20]!;
    expect(s.next).toMatchObject({ state: "halt", sinceD: S(20), markMicro: c(1000) });
    expect(s.reason).toBe("halt_start");
    expect(s.effects).toMatchObject({
      entriesBlocked: true,
      exitFillsBlocked: true,
      markMicro: c(1000),
    });
    expect(steps[21]!.effects).toMatchObject({ exitFillsBlocked: true, entriesBlocked: true });
    expect(steps[19]!.next).toEqual({ state: "none" });
  });

  it("no exit fill inside the window, a fill at the reopen open (fill model)", () => {
    const env = (instant: string): FillOrderEnv => ({
      bar: { openMicro: c(1000), highMicro: c(1010), lowMicro: c(990), closeMicro: c(1000) },
      advMicro: 5_000_000_000_000n,
      profile: COST_PROFILES.P5,
      halted: haltedAtInstant(rows, instant),
    });
    expect(fillOrder({ kind: "exit_cs", qty: 10n }, env(open(S(20))))).toEqual({
      status: "unfilled",
      reason: "halted",
    });
    expect(fillOrder({ kind: "exit_cs", qty: 10n }, env(open(S(21))))).toEqual({
      status: "unfilled",
      reason: "halted",
    });
    expect(fillOrder({ kind: "exit_cs", qty: 10n }, env(open(S(22)))).status).toBe("filled");
  });

  it("re-scores at the reopen bar: a reopen within the loss budget is a plain reopen", () => {
    const steps = walk(spec(), 22, rows);
    const r = steps[22]!;
    expect(r.next).toEqual({ state: "none" });
    expect(r.reason).toBe("halt_reopened");
    expect(r.effects.reopenGapExit).toBe(false);
    expect(r.row).toMatchObject({
      state: "none",
      basis: { after: "halt", since: S(20), reopenGapExit: false },
    });
  });

  it("a reopen far below the pre-halt close exits at the reopen open (the gap beyond the 18 % budget)", () => {
    // pre-halt close 10.00; reopens at 7.00 (-30 %)
    const steps = walk(spec({ 22: 700 }), 22, rows);
    expect(steps[22]!.reason).toBe("reopen_gap_exit");
    expect(steps[22]!.effects.reopenGapExit).toBe(true);
  });

  it("the same machine for the cx16 model with the view's own flags: no rows, no halt", () => {
    const steps = walk(spec(), 22, [], CX16_MODEL);
    expect(steps.every((s) => s.next.state === "none")).toBe(true);
  });
});

describe("an intraday pause that does not cover the open", () => {
  it("is not a halted session: the machine stays none and the open fill is allowed", () => {
    const rows: HaltSourceRow[] = [
      { kind: "luld", haltedAt: `${S(25)}T16:00:00.000Z`, resumedAt: `${S(25)}T16:05:00.000Z` },
    ];
    const steps = walk(spec(), 26, rows);
    expect(steps.every((s) => s.next.state === "none")).toBe(true);
    expect(haltedAtInstant(rows, open(S(25)))).toBe(false);
  });
});

describe("a suspension row takes the CTX-016 suspension path", () => {
  const rows: HaltSourceRow[] = [
    { kind: "suspension", haltedAt: `${S(10)}T13:00:00.000Z`, resumedAt: `${S(15)}T13:00:00.000Z` },
  ];
  const steps = walk(spec(), 30, rows);

  it("is a suspension from the first covered session (the notice), marked at the last trade", () => {
    const s = steps[10]!;
    expect(s.next).toMatchObject({ state: "suspension", sinceD: S(10), lastTradeMicro: c(1000) });
    expect(s.reason).toBe("suspension_notice");
    expect(s.effects).toMatchObject({ entriesBlocked: true, exitFillsBlocked: true, markPct: 100 });
    expect(s.row).toMatchObject({ kind: "halt", state: "suspension", fromD: S(10) });
  });

  it("the mark declines by the policy while the code does not trade, then it trades again", () => {
    // sessions 10..14 are untraded (5 sessions): the policy keeps 100 % for the first five
    expect(steps[14]!.effects.markPct).toBe(suspensionMarkPct(5));
    expect(steps[14]!.effects.markMicro).toBe(markAtPct(c(1000), suspensionMarkPct(5)));
    // 15 onward the code trades (the row is over): exit fills allowed, the mark is the market
    expect(steps[15]!.effects.exitFillsBlocked).toBe(false);
    expect(steps[15]!.effects.markMicro).toBeNull();
  });

  it("ends after ten consecutive traded sessions", () => {
    expect(steps[24]!.reason).toBe("suspension_ended");
    expect(steps[24]!.next).toEqual({ state: "none" });
  });

  it("haltStateAt folds the same way", () => {
    expect(
      haltStateAt(buildAsOfView(statesWorld([spec()])), "ZZ1", 10, undefined, { model, rows }).next,
    ).toMatchObject({
      state: "suspension",
    });
  });
});

describe("the notice kind of a source row", () => {
  it("suspension rows are suspension notices; luld and halt rows are halts", () => {
    expect(model.noticeKind({ kind: "suspension" })).toBe("suspension");
    expect(model.noticeKind({ kind: "luld" })).toBe("halt");
    expect(model.noticeKind({ kind: "halt" })).toBe("halt");
    expect(model.noticeKind({})).toBeNull();
  });
  it("the cx16 model reads the ASX words, as today", () => {
    expect(CX16_MODEL.noticeKind({ type: "trading halt", title: "Trading Halt" })).toBe("halt");
    expect(CX16_MODEL.noticeKind({ title: "Voluntary Suspension" })).toBe("suspension");
  });
});

describe("the model a profile selects", () => {
  it("each market's halt reader maps to its model; the US one reads the profile's session open in its zone", () => {
    expect(haltReader(staticProfile("AU"))).toBe("cx16");
    expect(haltModelFor(staticProfile("AU")).id).toBe("cx16");
    expect(haltReader(staticProfile("IN"))).toBe("in_bands");
    expect(haltModelFor(staticProfile("IN")).id).toBe("in_bands");
    expect(haltReader(staticProfile("US"))).toBe("us_luld");
    const us = haltModelFor(staticProfile("US"));
    expect(us.id).toBe("us_luld");
    // 09:30 New York in February is 14:30Z; a row 14:00Z-14:45Z covers the open
    const view = buildAsOfView(statesWorld([spec()]));
    const v = us.viewFor(view, "ZZ1", [
      { kind: "luld", haltedAt: `${S(5)}T14:00:00.000Z`, resumedAt: `${S(5)}T14:45:00.000Z` },
    ]);
    expect(v.halted("ZZ1", 5)).toBe(true);
    expect(v.halted("ZZ1", 6)).toBe(false);
  });
});

describe("loadHaltRows reads the A2 table shape", () => {
  let db: Client;
  beforeEach(async () => {
    db = await freshDb("main");
    await allowMarket(db, "US");
  });
  afterEach(cleanupTempDbs);

  it("returns the rows touching the window, with the open ones", async () => {
    const ins = (kind: string, at: string, resumed: string | null) =>
      db.execute({
        sql: "INSERT INTO trading_halt (market, code, kind, halted_at, resumed_at, reason, source) VALUES ('US', 'ZZ1', ?, ?, ?, 'LULD', 'nasdaq_halts')",
        args: [kind, at, resumed],
      });
    await ins("luld", "2026-02-10T14:00:00Z", "2026-02-10T14:05:00Z");
    await ins("suspension", "2026-02-20T00:00:00Z", null);
    await ins("halt", "2026-01-05T15:00:00Z", "2026-01-05T16:00:00Z"); // before the window
    const rows = await loadHaltRows(
      db,
      "US",
      "ZZ1",
      "2026-02-09T00:00:00Z",
      "2026-02-28T00:00:00Z",
    );
    expect(rows.map((r) => r.kind)).toEqual(["luld", "suspension"]);
    expect(rows[1]).toMatchObject({ resumedAt: null, reason: "LULD", source: "nasdaq_halts" });
    expect(
      haltedAtInstant(
        rows.map((r) => ({ kind: r.kind, haltedAt: r.haltedAt, resumedAt: r.resumedAt })),
        "2026-02-25T14:30:00Z",
      ),
    ).toBe(true);
  });
});
