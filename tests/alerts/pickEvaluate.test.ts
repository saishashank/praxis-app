// @vitest-environment node
// M17 WP3 (AT-60 a): the pure alert transition over the seven stream shapes (ARN-112..114, D-394, D-395).
// ZZ prices only, no database. A stale quote or a quote without volume never hits or clears.
import { describe, expect, it } from "vitest";
import { chaseCapMicro, evaluateAlert } from "@/lib/alerts/pick/evaluate";
import type { AlertState, ClearReason, EvalCtx, Transition } from "@/lib/alerts/pick/types";
import type { DelayedQuote } from "@/lib/data/quotes/types";

const NOW = new Date("2026-11-03T23:45:00.000Z");
const M = 1_000_000n;
const LIMIT = 10n * M;
const STOP = 9n * M;
const PARAMS = { chaseCapPct: 3, maxSessions: 3, maxAgeMin: 10, delayMin: 20 };

const state = (over: Partial<AlertState> = {}): AlertState => ({
  state: "armed",
  limitMicro: LIMIT,
  stopMicro: STOP,
  armedSession: "2026-11-04",
  sessionsArmed: 1,
  hitThisSession: false,
  ...over,
});
const ctx = (over: Partial<EvalCtx> = {}): EvalCtx => ({
  session: "2026-11-04",
  now: NOW,
  halted: false,
  inList: true,
  filled: false,
  muted: false,
  params: PARAMS,
  ...over,
});
const quote = (price: bigint, over: Partial<DelayedQuote> = {}): DelayedQuote => ({
  code: "ZZ01",
  lastMicro: price,
  quoteAt: new Date(NOW.getTime() - 20 * 60_000).toISOString(),
  prevCloseMicro: 10n * M,
  cumVolume: 1000,
  halted: null,
  fetchedAt: NOW.toISOString(),
  ...over,
});
const cleared = (reason: ClearReason): Transition => ({
  state: "cleared",
  reason,
  quoteAt: expect.any(String),
});

describe("evaluateAlert: the seven shapes", () => {
  it("hit: at the limit and below it, above the stop", () => {
    expect(evaluateAlert(state(), quote(LIMIT), ctx())).toMatchObject({
      state: "hit",
      hitMicro: LIMIT,
    });
    expect(evaluateAlert(state(), quote(9_500_000n), ctx())).toMatchObject({ state: "hit" });
  });

  it("hit then rise: nothing more in the same session (no re-arm), price clears included", () => {
    const hit = state({ state: "hit", hitThisSession: true });
    expect(evaluateAlert(hit, quote(11n * M), ctx())).toBeNull();
    expect(evaluateAlert(hit, quote(8n * M), ctx())).toBeNull();
    expect(evaluateAlert(hit, quote(9_500_000n), ctx())).toBeNull();
  });

  it("a hit from an earlier session can hit again in a new session (one mail per session)", () => {
    const old = state({ state: "hit", hitThisSession: false, sessionsArmed: 2 });
    expect(evaluateAlert(old, quote(LIMIT), ctx())).toMatchObject({ state: "hit" });
  });

  it("below stop before a hit clears with below_stop; at the stop it stays armed", () => {
    expect(evaluateAlert(state(), quote(STOP - 1n), ctx())).toEqual(cleared("below_stop"));
    expect(evaluateAlert(state(), quote(STOP), ctx())).toBeNull();
  });

  it("above the chase cap clears; between limit and cap stays armed (D-395)", () => {
    expect(chaseCapMicro(LIMIT, 3)).toBe(10_300_000n);
    expect(evaluateAlert(state(), quote(10_300_001n), ctx())).toEqual(cleared("above_chase_cap"));
    expect(evaluateAlert(state(), quote(10_300_000n), ctx())).toBeNull();
    expect(evaluateAlert(state(), quote(10_100_000n), ctx())).toBeNull();
  });

  it("halt clears with halted", () => {
    expect(evaluateAlert(state(), quote(LIMIT), ctx({ halted: true }))).toEqual({
      state: "cleared",
      reason: "halted",
    });
  });

  it("expiry after pick_alert_max_sessions sessions", () => {
    expect(evaluateAlert(state({ sessionsArmed: 3 }), null, ctx())).toBeNull();
    expect(evaluateAlert(state({ sessionsArmed: 4 }), null, ctx())).toEqual({
      state: "cleared",
      reason: "expired",
    });
  });

  it("left the list, muted and filled need no quote (filled outranks left_list)", () => {
    expect(evaluateAlert(state(), null, ctx({ inList: false }))).toEqual({
      state: "cleared",
      reason: "left_list",
    });
    expect(evaluateAlert(state(), null, ctx({ muted: true }))).toEqual({
      state: "cleared",
      reason: "muted",
    });
    expect(evaluateAlert(state(), null, ctx({ filled: true, inList: false }))).toEqual({
      state: "cleared",
      reason: "filled",
    });
  });
});

describe("evaluateAlert: fail-closed on the quote", () => {
  it("no quote, a stale quote and a quote without volume never hit or clear", () => {
    expect(evaluateAlert(state(), null, ctx())).toBeNull();
    const stale = quote(LIMIT, { quoteAt: new Date(NOW.getTime() - 31 * 60_000).toISOString() });
    expect(evaluateAlert(state(), stale, ctx())).toBeNull();
    expect(evaluateAlert(state(), { ...stale, lastMicro: STOP - 1n }, ctx())).toBeNull();
    expect(evaluateAlert(state(), quote(LIMIT, { cumVolume: null }), ctx())).toBeNull();
    expect(evaluateAlert(state(), quote(STOP - 1n, { cumVolume: null }), ctx())).toBeNull();
  });

  it("a cleared alert is never re-armed", () => {
    expect(evaluateAlert(state({ state: "cleared" }), quote(LIMIT), ctx())).toBeNull();
  });
});

describe("ten picks, mixed shapes: exactly one transition each, as expected", () => {
  const shapes: Array<[string, AlertState, DelayedQuote | null, Partial<EvalCtx>, string | null]> =
    [
      ["hit", state(), quote(LIMIT), {}, "hit"],
      ["hit-then-rise", state({ state: "hit", hitThisSession: true }), quote(11n * M), {}, null],
      ["below-stop", state(), quote(8n * M), {}, "below_stop"],
      ["above-cap", state(), quote(11n * M), {}, "above_chase_cap"],
      ["halt", state(), quote(LIMIT), { halted: true }, "halted"],
      ["expiry", state({ sessionsArmed: 9 }), quote(LIMIT), {}, "expired"],
      ["left-list", state(), quote(LIMIT), { inList: false }, "left_list"],
      ["filled", state(), quote(LIMIT), { filled: true }, "filled"],
      ["muted", state(), quote(LIMIT), { muted: true }, "muted"],
      ["waiting", state(), quote(10_200_000n), {}, null],
    ];
  it.each(shapes)("%s", (_n, s, q, c, want) => {
    const t = evaluateAlert(s, q, ctx(c));
    expect(t === null ? null : t.state === "hit" ? "hit" : t.reason).toBe(want);
  });
});
