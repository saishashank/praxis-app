// @vitest-environment node
// AT-72 (M23 R1; D-1605, D-1627, D-1628): a synthetic lineage set through the research engine. A planted edge ends PASS,
// a null NULL, and a lineage whose n is short INCONCLUSIVE with no registry row and no outcome read. The larger-parcel
// sensitivity variant carries its label and is never counted among the base lineages. The registry itself is task A2's
// (tests/acceptance/v3/at72Registry.test.ts); here a recorder with the same contract (a verdict writes one row, below
// sample writes none) stands in for it. Every code and price is synthetic.
import { describe, expect, it } from "vitest";
import type { ControlCandidate } from "@/lib/research/controls";
import {
  ASSUMED_HAIRCUT_RULE,
  LARGER_ACCOUNT_LABEL,
  parcelLabel,
  PARCEL_BASE_MICRO,
  PARCEL_LARGE_MICRO,
  profileCostFn,
} from "@/lib/research/costs";
import {
  bonferroniAlpha,
  eventStudy,
  lookOutcome,
  type EventStudyParams,
  type LookOutcome,
  type Setup,
} from "@/lib/research/eventStudy";
import type { PriceBook } from "@/lib/research/exits";
import { renderReport, type ReportInput } from "@/lib/research/report";
import { belowInt, scopedPrng } from "@/lib/stats/rng";

const HOLD = 10;
const UNIT = 1_000_000n;
const CONTROLS: ControlCandidate[] = Array.from({ length: 20 }, (_, i) => ({
  code: `ZZCTRL${String(i).padStart(2, "0")}`,
  tier: "T1",
  volDecile: 4,
}));

/** Open price of a code at a session: 10.00 plus noise of up to 3 % either way (a hash of code and session). */
function noisy(code: string, session: number): bigint {
  const n = BigInt(belowInt(scopedPrng(`at72:${code}:${session}`), 61) - 30);
  return 10_000_000n + n * 10_000n;
}

/** A synthetic price book; the setups' exit opens carry `edgePermille` of planted extra return (0 for a null). */
function book(setups: readonly Setup[], edgePermille: number): PriceBook {
  const exits = new Map<string, number>();
  for (const s of setups) exits.set(s.code, s.signalSession + 1 + s.hold);
  return {
    open: (code, session) => {
      const base = noisy(code, session);
      return exits.get(code) === session
        ? base + (10n * UNIT * BigInt(edgePermille)) / 1000n
        : base;
    },
  };
}

function lineage(n: number): Setup[] {
  return Array.from({ length: n }, (_, i) => ({
    code: `ZZ${String(i).padStart(3, "0")}`,
    signalSession: 2 + i * 3,
    hold: HOLD,
    tier: "T1",
    volDecile: 4,
  }));
}

const params = (lineageKey: string, over: Partial<EventStudyParams> = {}): EventStudyParams => ({
  lineage: lineageKey,
  parcelMicro: PARCEL_BASE_MICRO,
  cost: profileCostFn("P6"),
  floors: { minSetups: 60, minBlocks: 20 },
  haircut: ASSUMED_HAIRCUT_RULE,
  matchOn: ["tier", "volDecile"],
  alpha: bonferroniAlpha(3),
  replicates: 400,
  ...over,
});

/** The registry contract of A2's takeLook, as a recorder: a verdict writes one row, below sample none. */
function recorder() {
  const rows: { lineage: string; verdict: string; nSetups: number; nBlocks: number }[] = [];
  return {
    rows,
    take(lineageKey: string, outcome: LookOutcome) {
      if ("status" in outcome) return outcome.status;
      rows.push({
        lineage: lineageKey,
        verdict: outcome.verdict,
        nSetups: outcome.nSetups,
        nBlocks: outcome.nBlocks,
      });
      return "recorded";
    },
  };
}

describe("AT-72: PASS, NULL and INCONCLUSIVE from the engine", () => {
  const long = lineage(80);
  const pool = () => CONTROLS;

  it("a planted edge of 3 % is PASS, with the bound above zero at the Bonferroni level", () => {
    const r = eventStudy(long, { prices: book(long, 30), pool }, params("zz_planted"));
    if (r.status !== "looked") throw new Error("expected a look");
    expect(r.counts.setups).toBe(80);
    expect(r.counts.blocks).toBeGreaterThanOrEqual(20);
    expect(r.withHaircut.alpha).toBeCloseTo(0.1 / 3, 12);
    expect(r.withHaircut.lowerPpm!).toBeGreaterThan(0);
    expect(r.verdict).toBe("PASS");
  });

  it("the same lineage with no edge is NULL", () => {
    const r = eventStudy(long, { prices: book(long, 0), pool }, params("zz_null"));
    if (r.status !== "looked") throw new Error("expected a look");
    expect(r.withHaircut.lowerPpm!).toBeLessThanOrEqual(0);
    expect(r.verdict).toBe("NULL");
  });

  it("a short lineage is INCONCLUSIVE: no outcome read, no registry row, the look unspent", () => {
    const short = lineage(30);
    const reg = recorder();
    const reads: string[] = [];
    const watching: PriceBook = {
      open: (c, s) => {
        reads.push(`${c}:${s}`);
        return book(short, 30).open(c, s);
      },
    };
    const r = eventStudy(short, { prices: watching, pool }, params("zz_short"));
    expect(r.status).toBe("below_sample");
    expect(reads).toEqual([]);
    expect(reg.take("zz_short", lookOutcome(r))).toBe("below_sample");
    expect(reg.rows).toEqual([]);
    // later, with enough setups, the same lineage can still take its one look
    const later = eventStudy(long, { prices: book(long, 30), pool }, params("zz_short"));
    expect(reg.take("zz_short", lookOutcome(later))).toBe("recorded");
    expect(reg.rows).toHaveLength(1);
  });

  it("the three lineages together: one row each for the two with a verdict, none for the short one", () => {
    const reg = recorder();
    const plan: [string, readonly Setup[], number][] = [
      ["zz_planted", long, 30],
      ["zz_null", long, 0],
      ["zz_short", lineage(30), 30],
    ];
    for (const [key, setups, edge] of plan) {
      reg.take(
        key,
        lookOutcome(eventStudy(setups, { prices: book(setups, edge), pool }, params(key))),
      );
    }
    expect(reg.rows.map((x) => `${x.lineage}:${x.verdict}`)).toEqual([
      "zz_planted:PASS",
      "zz_null:NULL",
    ]);
    expect(reg.rows.every((x) => x.nSetups === 80 && x.nBlocks >= 20)).toBe(true);
  });

  it("a stricter family (k = 40 lineages) can turn a marginal PASS into NULL; k only ever tightens", () => {
    const loose = eventStudy(
      long,
      { prices: book(long, 30), pool },
      params("zz_k", { alpha: bonferroniAlpha(1) }),
    );
    const tight = eventStudy(
      long,
      { prices: book(long, 30), pool },
      params("zz_k", { alpha: bonferroniAlpha(40) }),
    );
    if (loose.status !== "looked" || tight.status !== "looked") throw new Error("expected looks");
    expect(tight.withHaircut.lowerPpm!).toBeLessThanOrEqual(loose.withHaircut.lowerPpm!);
  });
});

describe("AT-72: the larger-parcel sensitivity variant", () => {
  const long = lineage(80);
  const pool = () => CONTROLS;

  it("runs the same setups at the larger parcel, labelled, with higher nets from lower fee drag", () => {
    const base = eventStudy(long, { prices: book(long, 30), pool }, params("zz_planted"));
    const large = eventStudy(
      long,
      { prices: book(long, 30), pool },
      params("zz_planted_p5000", { parcelMicro: PARCEL_LARGE_MICRO }),
    );
    if (base.status !== "looked" || large.status !== "looked") throw new Error("expected looks");
    expect(large.counts).toEqual(base.counts);
    expect(large.meanNetPpm).toBeGreaterThan(base.meanNetPpm);
    expect(parcelLabel(PARCEL_BASE_MICRO)).toBeNull();
    expect(parcelLabel(PARCEL_LARGE_MICRO)).toBe(LARGER_ACCOUNT_LABEL);
  });

  it("its report carries the words Larger account, not your book on the title and the statistic", () => {
    const text = renderReport(variantReport());
    expect(text.split("\n")[0]).toContain("(Larger account, not your book)");
    expect(text).toContain("Label on every figure here: Larger account, not your book");
  });
});

function variantReport(): ReportInput {
  return {
    item: "CXA-902",
    title: "Synthetic variant",
    lineage: "zz_planted_p5000",
    market: "ZZ",
    verdict: "PASS",
    hypothesis: "Same setups at a larger parcel.",
    prereg: {
      file: "docs/research/prereg/CXA-902.json",
      sha256: "b".repeat(64),
      commit: "1111111",
      date: "2026-11-17",
      runnerCommit: "2222222",
    },
    data: {
      sourceClass: "synthetic",
      window: "synthetic",
      universe: "synthetic",
      knownTime: "none",
      caveats: [],
    },
    split: { kind: "full", reason: "synthetic" },
    n: { setups: 80, sessions: 80, blocks: 24, floorSetups: 60, floorBlocks: 20, floorMet: true },
    statistic: {
      definition: "Mean excess after the haircut.",
      costProfile: "P6",
      parcel: "5000",
      control: "up to 20 matched",
      haircut: "assumed",
      variantLabel: parcelLabel(PARCEL_LARGE_MICRO),
    },
    result: { unit: "ppm", alpha: null, rows: [{ window: "full", mean: 1, lower: null, n: 80 }] },
    verdictReason: "synthetic",
    looks: [],
    refusals: [],
    next: "Never able to trade.",
  };
}
