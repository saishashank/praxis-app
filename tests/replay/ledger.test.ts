// @vitest-environment node
// T11 signal-ledger replay on a synthetic world (ZZ codes): de-duplication of signals and event
// groups, the one-open-row rule per (family, rule version, variant, code), the live re-entry block
// after an IS exit, rows and controls in the migration 0008 shape, byte-identical replays and the
// no-look-ahead property (poisoned future bars, family inputs that throw beyond the cut).
import { describe, expect, it } from "vitest";
import { AGENT_COLUMNS } from "@/lib/agents/schema";
import { buildAgentParams, defaultAgentParams } from "@/lib/agents/params";
import { CONFIG_KEYS, type ConfigKey } from "@/lib/config/keys";
import {
  dailySeries,
  ledgerDigest,
  replayLedger,
  serializeLedger,
  type LedgerEntry,
  type LedgerResult,
} from "@/lib/replay/ledger";
import { periodReturn } from "@/lib/replay/returns";
import type { CorpActionRecord } from "@/lib/arena/corpActions";
import { CENT, DOLLAR, ev, makeBars, wobble } from "../fixtures/agents/families/builders";
import {
  buildWorld,
  SESSIONS,
  type WorldCode,
  type WorldOptions,
} from "../fixtures/replay/ledgerWorld";

const p = defaultAgentParams();
const withBlock = (n: number) =>
  buildAgentParams((k: ConfigKey) => (k === "reentry_block" ? n : CONFIG_KEYS[k].default));

// ZZA: a steady leader, a crash at 283 (IS exit of the row entered after 280), a jump at 285.
const SPIKES = new Set([280, 282, 285, 288, 295]);
const leaderClose = (i: number): bigint => {
  let c = DOLLAR + BigInt(i) * CENT;
  if (i >= 283) c -= 20n * CENT;
  if (i >= 285) c += 70n * CENT;
  return c;
};
const leader: WorldCode = {
  code: "ZZA",
  tier: "U1",
  bars: makeBars({
    close: leaderClose,
    volume: (i) => (SPIKES.has(i) ? 2_000_000n : 1_000_000n),
  }),
};
const peers: WorldCode[] = Array.from({ length: 40 }, (_, i) => ({
  code: `ZZP${String(i).padStart(2, "0")}`,
  tier: "U1" as const,
  bars: makeBars({ close: wobble(2n * DOLLAR + BigInt(i) * 3n * CENT) }),
}));

// ZZE: flat, a positive results event on 290, a crash at 292 right after the entry.
const eventCode: WorldCode = {
  code: "ZZE",
  tier: "U1",
  bars: makeBars({ close: (i) => (i < 292 ? 2n * DOLLAR + BigInt(i % 2) * CENT : 1_500_000n) }),
};
const resultsEvent = (timed = true) =>
  ev({
    code: "ZZE",
    category: "results",
    polarity: 1,
    ar: "0.05",
    day0: SESSIONS[290]!,
    low: 1_950_000n,
    timed,
  });

const ix = (d: string) => SESSIONS.indexOf(d);
const rowsOf = (r: LedgerResult, code: string) => r.entries.filter((e) => e.code === code);

function run(
  codes: WorldCode[],
  opts: WorldOptions & {
    family: "F1" | "F2";
    from?: number;
    to?: number;
    controls?: boolean;
    params?: typeof p;
    seed?: bigint;
  },
) {
  const params = opts.params ?? p;
  const world = buildWorld(codes, params, opts);
  const result = replayLedger(world, {
    params,
    from: SESSIONS[opts.from ?? 270]!,
    to: opts.to === undefined ? undefined : SESSIONS[opts.to]!,
    familyOptions: { families: [opts.family] },
    controls: opts.controls,
    masterSeed: opts.seed,
  });
  return { world, result };
}

describe("F1 signals: de-duplication, one open row, re-entry block", () => {
  const { result } = run([leader, ...peers], { family: "F1" });
  const zza = rowsOf(result, "ZZA");

  it("opens a row on the first signal and skips later signals while it is open", () => {
    expect(zza.map((e) => e.decisionD)).toEqual([SESSIONS[280], SESSIONS[295]]);
    const first = zza[0]!;
    expect(first.row.entry_d).toBe(SESSIONS[281]);
    expect(first.row.exit_d).toBe(SESSIONS[283]);
    expect(first.row.exit_tag).toBe("IS");
    expect(first.exitRule).toBe("stop");
    const skip = (i: number) =>
      result.skipped.find((s) => s.code === "ZZA" && s.d === SESSIONS[i])?.reason;
    expect(skip(282)).toBe("open_row"); // signal while the first row is still open
  });

  it("blocks re-entry for reentry_block sessions after an IS exit, then allows it", () => {
    const skip = (i: number) =>
      result.skipped.find((s) => s.code === "ZZA" && s.d === SESSIONS[i])?.reason;
    // exit on 283: decisions 285 and 288 fall inside the 10-session block, 295 is allowed
    expect(skip(285)).toBe("reentry_block");
    expect(skip(288)).toBe("reentry_block");
    expect(zza[1]!.decisionD).toBe(SESSIONS[295]);
    expect(zza[1]!.row.entry_d).toBe(SESSIONS[296]);
  });

  it("takes the block length from the key reentry_block (5 sessions lets 288 in)", () => {
    const { result: r5 } = run([leader, ...peers], { family: "F1", params: withBlock(5) });
    const dec = rowsOf(r5, "ZZA").map((e) => ix(e.decisionD));
    expect(dec).toContain(280);
    expect(dec).toContain(288); // 288 - 283 = 5 >= block
    expect(dec).not.toContain(285); // 285 - 283 = 2 < block
  });

  it("never has two open rows for one key and respects the block between rows", () => {
    for (const code of new Set(result.entries.map((e) => e.code))) {
      const rows = rowsOf(result, code);
      for (let i = 1; i < rows.length; i++) {
        const prev = rows[i - 1]!;
        expect(prev.row.exit_d).not.toBeNull();
        expect(rows[i]!.row.entry_d > prev.row.exit_d!).toBe(true);
        if (prev.row.exit_tag === "IS") {
          expect(ix(rows[i]!.decisionD) - ix(prev.row.exit_d!)).toBeGreaterThanOrEqual(
            p.reentryBlock,
          );
        }
      }
    }
  });

  it("leaves a row open at the end of the data, marked to market to the last close", () => {
    const open = zza[1]!;
    expect(open.row).toMatchObject({
      exit_d: null,
      exit_tag: null,
      fill_out_micro: null,
      brok_out_micro: null,
      stress_out_micro: null,
      gross_num: null,
      gross_den: null,
      forward: 0,
      timed: 1,
    });
    expect(open.row.stress_in_micro > 0n).toBe(true);
    expect(open.net).toBeNull();
    expect(open.controls).toBeNull();
    expect(open.mtm.map((m) => m.d)).toEqual(SESSIONS.slice(296, 300));
  });
});

describe("rows in the ledger_row shape with exact amounts", () => {
  const { result } = run([leader, ...peers], { family: "F1" });
  const first = rowsOf(result, "ZZA")[0]!;

  it("has exactly the migration columns, ids from the lineage and signal conventions", () => {
    expect(Object.keys(first.row).sort()).toEqual([...AGENT_COLUMNS.ledger_row].sort());
    expect(first.row.id).toBe(`lr:AU:F1:F1.v1:F1:ZZA:${SESSIONS[281]}`);
    expect(first.row.signal_id).toBe(`sig:AU:${SESSIONS[280]}:F1:F1.v1:F1:ZZA`);
    expect(first.lineage).toBe("AU:F1");
    expect(first.row.group_key).toBeNull();
  });

  it("returns follow from the stored amounts: cost, proceeds, net, gross, stress", () => {
    const r = first.row;
    const qty = BigInt(r.qty);
    const cost = qty * r.fill_in_micro + r.brok_in_micro;
    const proceeds = qty * r.fill_out_micro! - r.brok_out_micro!;
    expect(r.qty).toBeGreaterThan(0);
    expect(qty * r.fill_in_micro <= 600_000_000n).toBe(true); // floor(A$600 / fill)
    expect((qty + 1n) * r.fill_in_micro > 600_000_000n).toBe(true);
    expect(r.brok_in_micro).toBe(5_000_000n); // P5, order value below A$1,000
    expect(first.net).toEqual({ num: proceeds - cost, den: cost });
    expect(first.stress!.den).toBe(r.stress_in_micro);
    expect(first.stress!.num).toBe(r.stress_out_micro! - r.stress_in_micro);
    expect(r.gross_den! > 0n).toBe(true);
    // a stop exit loses money here, and the stress column is no better than the base
    expect(first.net!.num < 0n).toBe(true);
    expect(first.stress!.num * first.net!.den <= first.net!.num * first.stress!.den).toBe(true);
  });

  it("daily MTM P/L of a closed row sums to its net P/L; period return uses the notional", () => {
    const sum = first.mtm.reduce((a, m) => a + m.pnlMicro, 0n);
    expect(sum).toBe(first.net!.num);
    const pts = dailySeries(result, (e) => e.row.id === first.row.id);
    expect(pts.map((x) => x.open)).toEqual([1, 1, 1]);
    const ret = periodReturn(pts, p.replay.ledgerNotionalMicro, pts[0]!.d, pts[2]!.d)!;
    expect(ret.num * p.replay.ledgerNotionalMicro).toBe(sum * ret.den);
  });
});

describe("matched controls", () => {
  const { result } = run([leader, ...peers], { family: "F1" });
  const first = rowsOf(result, "ZZA")[0]!;

  it("every closed row carries 20 controls from other codes, with the pool size recorded", () => {
    const c = first.controls!;
    expect(c.controls).toHaveLength(p.stats.c2ControlsPerRow);
    expect(c.controls.every((k) => k.code !== "ZZA" && k.row_id === first.row.id)).toBe(true);
    expect(c.controls.every((k) => k.entry_d === first.row.entry_d && k.exit_d >= k.entry_d)).toBe(
      true,
    );
    expect(c.poolSize).toBeGreaterThan(0);
    expect(c.poolSize).toBeLessThan(40);
    expect(c.withReplacement).toBe(c.usableSize < 20);
    expect(Object.keys(c.controls[0]!).sort()).toEqual([...AGENT_COLUMNS.ledger_control].sort());
  });

  it("the paired excess is exactly the row return minus the mean control return", () => {
    const c = first.controls!;
    let sum = { num: 0n, den: 1n };
    for (const k of c.controls) {
      sum = { num: sum.num * k.net_den + k.net_num * sum.den, den: sum.den * k.net_den };
    }
    const n = BigInt(c.controls.length);
    const r = first.net!;
    // e = r - sum / n  =>  e x (r.den x sum.den x n) = r.num x sum.den x n - sum.num x r.den
    const e = first.excess!;
    expect(e.num * (r.den * sum.den * n)).toBe((r.num * sum.den * n - sum.num * r.den) * e.den);
  });

  it("controls are optional", () => {
    const { result: bare } = run([leader, ...peers], { family: "F1", controls: false });
    expect(bare.entries.every((e) => e.controls === null && e.excess === null)).toBe(true);
    expect(bare.controlPaths).toBe(0);
    expect(bare.entries.map((e) => e.row)).toEqual(result.entries.map((e) => e.row));
  });
});

describe("F2 event groups: one row per event", () => {
  it("creates one row for an event that fires on 5 sessions, even after the row has exited", () => {
    const { result } = run([eventCode, ...peers], {
      family: "F2",
      from: 285,
      events: [resultsEvent()],
    });
    const rows = rowsOf(result, "ZZE");
    expect(rows).toHaveLength(1);
    const e = rows[0]!;
    expect(e.row.group_key).toBe(`ZZE:${SESSIONS[290]}`);
    expect(e.variant).toBe("F2-no-fundamentals");
    expect(e.row.entry_d).toBe(SESSIONS[291]);
    expect(e.row.exit_d).toBe(SESSIONS[292]);
    expect(e.row.exit_tag).toBe("IS");
    const dupes = result.skipped.filter((s) => s.code === "ZZE");
    expect(dupes.map((s) => [s.d, s.reason])).toEqual(
      [291, 292, 293, 294].map((i) => [SESSIONS[i], "duplicate_group"]),
    );
    expect(e.controls!.note).toBeNull();
    expect(e.controls!.controls).toHaveLength(20);
  });

  it("an event with an assumed time makes an untimed row (timed = 0)", () => {
    const { result } = run([eventCode, ...peers], {
      family: "F2",
      from: 289,
      to: 291,
      events: [resultsEvent(false)],
      controls: false,
    });
    const e = rowsOf(result, "ZZE")[0]!;
    expect(e.row.timed).toBe(0);
    expect(e.flags).toContain("assumed-time");
  });
});

describe("determinism and look-ahead", () => {
  it("same snapshot, parameters and seed give byte-identical output", () => {
    const a = run([leader, ...peers], { family: "F1", seed: 11n }).result;
    const b = run([leader, ...peers], { family: "F1", seed: 11n }).result;
    expect(serializeLedger(a)).toBe(serializeLedger(b));
    expect(ledgerDigest(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(ledgerDigest(a)).toBe(ledgerDigest(b));
    expect(serializeLedger(a)).toContain(`"qty":`);
    expect(serializeLedger(a)).not.toContain("undefined");
    const c = run([leader, ...peers], { family: "F1", seed: 12n }).result;
    expect(c.entries.map((e) => e.row)).toEqual(a.entries.map((e) => e.row)); // rows ignore the seed
  });

  it("uses no data after the cut: poisoned future bars and throwing future inputs change nothing", () => {
    const CUT = 290;
    const clean = run([leader, ...peers], { family: "F1", to: CUT }).result;
    const { world, result: poisoned } = run([leader, ...peers], {
      family: "F1",
      to: CUT,
      poisonAfter: CUT,
      failInputsAfter: CUT,
    });
    expect(world.inputsCalls.every((d) => d <= SESSIONS[CUT]!)).toBe(true);
    const closed = (r: LedgerResult): LedgerEntry[] =>
      r.entries.filter((e) => e.row.exit_d !== null && e.row.exit_d <= SESSIONS[CUT]!);
    expect(closed(clean).length).toBeGreaterThan(0);
    const pick = (e: LedgerEntry) => [e.row, e.net, e.stress, e.mtm, e.exitRule, e.flags];
    expect(closed(poisoned).map(pick)).toEqual(closed(clean).map(pick));
    expect(poisoned.skipped).toEqual(clean.skipped);
  });
});

describe("D-091: the close sets the re-based quantity and the dividends (ledger_row columns)", () => {
  const withActions = (actions: CorpActionRecord[]) => {
    const world = buildWorld([leader, ...peers], p, {});
    world.corpActions = (code) => actions.filter((a) => a.code === code);
    const result = replayLedger(world, {
      params: p,
      from: SESSIONS[270]!,
      familyOptions: { families: ["F1"] },
    });
    return rowsOf(result, "ZZA")[0]!;
  };

  it("with no corporate action the shares sold are the shares bought and no dividend is credited", () => {
    const first = withActions([]);
    expect(first.row.qty_out).toBe(first.row.qty);
    expect(first.row.dividend_micro).toBe(0n);
  });

  it("a cash dividend in the hold: dividend_micro = qty x dps, inside net, gross and the stressed amount", () => {
    const base = withActions([]);
    const dividend: CorpActionRecord = {
      id: "1",
      code: "ZZA",
      type: "cash_dividend",
      exDate: SESSIONS[282]!, // inside the hold 281..283
      payload: { dps: "0.10", pay_date: SESSIONS[290]! },
    };
    const first = withActions([dividend]);
    const r = first.row;
    expect(r.dividend_micro).toBe(BigInt(r.qty) * 100_000n);
    const cost = BigInt(r.qty) * r.fill_in_micro + r.brok_in_micro;
    const proceeds = BigInt(r.qty_out!) * r.fill_out_micro! - r.brok_out_micro! + r.dividend_micro;
    expect(first.net).toEqual({ num: proceeds - cost, den: cost });
    expect(r.stress_out_micro! - base.row.stress_out_micro!).toBe(r.dividend_micro);
    expect(r.gross_num! - base.row.gross_num!).toBe(r.dividend_micro);
  });
});
