// @vitest-environment node
// M19 integration step 0 (D-1007, CXA-001, A-20, AT-75 AU): the AU constants snapshot. Every AU constant
// the refactor removes is recorded by module, export and value in tests/market/au-constants.snapshot.json
// BEFORE the first M19 merge, and never rewritten. This test asserts equality in two ways:
//   (1) source check: while a module still exports the constant, its value equals the snapshot (so no
//       task changes an AU number on the way); once a task removes the export the check skips it, and
//   (2) profile check (added with the loader, A1): the snapshot's `fields` equal `loadProfile("AU")`.
// "Any difference is a defect, not a tuning." Record (pre-refactor tree only): `node scripts/market/snapshot-au.mjs`.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as agentsBatch2b from "@/lib/agents/batch2b";
import * as agentsCostGate from "@/lib/agents/costGate";
import * as agentsDecisionView from "@/lib/agents/decisionView";
import * as alertsDeliver from "@/lib/alerts/deliver";
import * as arenaCohort from "@/lib/arena/cohort";
import * as arenaCosts from "@/lib/arena/costs";
import * as arenaLedger from "@/lib/arena/ledger";
import * as arenaPreopen from "@/lib/arena/preopen";
import * as arenaSizing from "@/lib/arena/sizing";
import * as arenaSlippage from "@/lib/arena/slippage";
import * as configKeys from "@/lib/config/keys";
import * as cortexCost from "@/lib/cortex/economics/cost";
import * as cortexKnownTime from "@/lib/cortex/pit/knownTime";
import * as cortexPitTypes from "@/lib/cortex/pit/types";
import * as dataCalendar from "@/lib/data/calendar";
import * as dataIndexBars from "@/lib/data/index/indexBars.mjs";
import * as dataPipelineRules from "@/lib/data/pipeline/rules.mjs";
import * as dataQuotesLatest from "@/lib/data/quotes/latest";
import * as dataQuotesParse from "@/lib/data/quotes/parse";
import * as dataUniverseTiers from "@/lib/data/universe/tiers.mjs";
import * as heartbeatChecks from "@/lib/heartbeat/checks";
import * as jobsRunNow from "@/lib/jobs/runNow";
import * as learningOwnerActions from "@/lib/learning/ownerActions";
import * as moneyTick from "@/lib/money/tick";
import * as picksStreamCost from "@/lib/picks/streamCost";
import * as preferencesService from "@/lib/preferences/service";
import * as reviewSend from "@/lib/review/send";
import * as runsDeadlines from "@/lib/runs/deadlines";
import * as uiCommon from "@/lib/ui/loaders/common";
import * as uiShell from "@/lib/ui/loaders/shell";
import * as usersService from "@/lib/users/service";
import { OWNER_TZ } from "@/lib/market/profileCore.mjs";
import { loadProfile } from "@/lib/market/profile";
import { seedOf } from "@/lib/market/seed/index.mjs";
import { AU_COST_PROFILES } from "@/lib/market/seed/au/costProfiles.mjs";
import { freshDb } from "../db/helpers";

const SNAPSHOT_PATH = join(import.meta.dirname, "au-constants.snapshot.json");
const RECORD = process.env.RECORD_AU_SNAPSHOT === "1";

/** Canonical form: object keys sorted, bigint written "<n>n" (the repo's canonicalJson convention). */
export function canon(v: unknown): unknown {
  if (typeof v === "bigint") return `${v.toString()}n`;
  if (Array.isArray(v)) return v.map(canon);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, canon((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

type Entry = { module: string; export: string; field: string | null; value: unknown };

/** One row per constant: [module path, namespace, export name, the profile field it becomes (null = kept)]. */
const SOURCES: ReadonlyArray<readonly [string, Record<string, unknown>, string, string | null]> = [
  // the market code and the market lists
  ["src/lib/config/keys.ts", configKeys, "MODE_MARKETS", "code"],
  ["src/lib/data/calendar.ts", dataCalendar, "CALENDAR_MARKETS", "code"],
  ["src/lib/arena/cohort.ts", arenaCohort, "ARENA_MARKET", "code"],
  ["src/lib/ui/loaders/shell.ts", uiShell, "MARKET", "code"],
  ["src/lib/ui/loaders/common.ts", uiCommon, "DEFAULT_MARKET", "code"],
  ["src/lib/preferences/service.ts", preferencesService, "SELECTABLE_MARKETS", "code"],
  ["src/lib/review/send.ts", reviewSend, "MARKET", "code"],
  ["src/lib/alerts/deliver.ts", alertsDeliver, "MARKET", "code"],
  ["src/lib/jobs/runNow.ts", jobsRunNow, "RUN_NOW_MARKET", "code"],
  ["src/lib/runs/deadlines.ts", runsDeadlines, "DEADLINE_MARKET", "code"],
  ["src/lib/heartbeat/checks.ts", heartbeatChecks, "MARKET", "code"],
  ["src/lib/learning/ownerActions.ts", learningOwnerActions, "MARKET", "code"],
  ["src/lib/users/service.ts", usersService, "MARKETS", "code"],
  ["src/lib/users/service.ts", usersService, "DEFAULT_MARKET", "code"],
  ["src/lib/data/pipeline/rules.mjs", dataPipelineRules, "MARKET", "code"],
  ["src/lib/data/index/indexBars.mjs", dataIndexBars, "INDEX_MARKET", "code"],
  // time zones and times
  ["src/lib/heartbeat/checks.ts", heartbeatChecks, "TZ", "tz"],
  ["src/lib/data/pipeline/rules.mjs", dataPipelineRules, "TZ", "tz"],
  ["src/lib/data/quotes/latest.ts", dataQuotesLatest, "QUOTE_TZ", "tz"],
  ["src/lib/agents/decisionView.ts", agentsDecisionView, "AU_TIME_ZONE", "owner_tz"],
  ["src/lib/agents/batch2b.ts", agentsBatch2b, "LATE_2A_AFTER", "batch_schedule"],
  ["src/lib/arena/preopen.ts", arenaPreopen, "PREOPEN_AT", "preopen_recheck_min"],
  ["src/lib/cortex/pit/knownTime.ts", cortexKnownTime, "INDEX_US_KNOWN_LOCAL", "known_time_rules"],
  // money, parcels, settlement, ticks, costs, tiers
  ["src/lib/arena/ledger.ts", arenaLedger, "SETTLEMENT_LAG_SESSIONS", "settlement_days"],
  ["src/lib/arena/sizing.ts", arenaSizing, "MIN_MARKETABLE_PARCEL_MICRO", "parcel_floor"],
  ["src/lib/cortex/economics/cost.ts", cortexCost, "PARCEL_FLOOR_MICRO", "parcel_floor"],
  ["src/lib/cortex/economics/cost.ts", cortexCost, "ADV_FLOOR_PER_PARCEL_MICRO", "parcel_floor"],
  ["src/lib/cortex/economics/cost.ts", cortexCost, "HALF_SPREAD_PPM_BY_TIER", "slippage_buckets"],
  ["src/lib/money/tick.ts", moneyTick, "TICK_TABLE", "tick_table"],
  ["src/lib/arena/slippage.ts", arenaSlippage, "SLIPPAGE_BUCKETS", "slippage_buckets"],
  ["src/lib/arena/slippage.ts", arenaSlippage, "DEFAULT_TICK_CROSS_FACTOR", "slippage_buckets"],
  ["src/lib/arena/slippage.ts", arenaSlippage, "DEFAULT_STALL_FLOOR_BPS", "slippage_buckets"],
  ["src/lib/arena/costs.ts", arenaCosts, "COST_PROFILES", "cost_formula"],
  ["src/lib/arena/costs.ts", arenaCosts, "COST_PROFILE_CODES", "cost_formula"],
  ["src/lib/data/universe/tiers.mjs", dataUniverseTiers, "TIER_RULES", "tiers"],
  ["src/lib/agents/costGate.ts", agentsCostGate, "COST_GATE_NOTIONAL_MICRO", null],
  ["src/lib/picks/streamCost.ts", picksStreamCost, "STREAM_PARCEL_MICRO", null],
  // indices
  ["src/lib/data/index/indexBars.mjs", dataIndexBars, "INDEX_CODE", "benchmark_index"],
  ["src/lib/data/index/indexBars.mjs", dataIndexBars, "INDEX_YAHOO_SYMBOL", "benchmark_index"],
  ["src/lib/data/index/indexBars.mjs", dataIndexBars, "US_INDEX_YAHOO_SYMBOLS", "benchmark_index"],
  ["src/lib/data/index/indexBars.mjs", dataIndexBars, "INDEX_CODES", "benchmark_index"],
  ["src/lib/data/quotes/parse.ts", dataQuotesParse, "MARKET_INDEX_CODE", "benchmark_index"],
  ["src/lib/cortex/pit/types.ts", cortexPitTypes, "INDEX_CODES_PIT", "benchmark_index"],
];

/** Configuration-key defaults that carry an AU constant (read from the registry, not an export). */
const KEY_DEFAULTS: ReadonlyArray<readonly [string, string | null]> = [
  ["decision_cutoff", "decision_cutoff"],
  ["market_mode", "code"],
  ["calendar_draft_markets", "code"],
  ["cost_profile_default", "cost_formula"],
  ["ledger_notional_aud", null],
  ["picks_portfolio_seed_aud", null],
  ["profile_portfolio_amount", null],
];

function collect(): Entry[] {
  const out: Entry[] = [];
  for (const [module, ns, name, field] of SOURCES) {
    if (!(name in ns)) throw new Error(`${module} does not export ${name}`);
    out.push({ module, export: name, field, value: canon(ns[name]) });
  }
  const keys = configKeys.CONFIG_KEYS as unknown as Record<
    string,
    { default: unknown } | undefined
  >;
  for (const [key, field] of KEY_DEFAULTS) {
    const def = keys[key];
    if (def === undefined) continue; // a key an older tree does not have is not a constant
    out.push({
      module: "src/lib/config/keys.ts",
      export: `CONFIG_KEYS.${key}.default`,
      field,
      value: canon(def.default),
    });
  }
  return out;
}

describe("AU constants snapshot (D-1007)", () => {
  it("records the snapshot when asked (pre-refactor tree only)", () => {
    if (!RECORD) return;
    const snapshot = {
      note:
        "M19 step 0 (D-1007): every AU constant the refactor removes, by module, export and value (bigint as '<n>n'). " +
        "Recorded on the pre-refactor build tree (fdc9e00) and never rewritten in M19. `field` is the profile field it becomes (null = kept as is).",
      recordedOnCommit: "fdc9e00",
      entries: collect(),
    };
    writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + "\n");
  });

  it("source check: every constant a module still exports equals the snapshot", () => {
    if (RECORD) return;
    const snap = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as { entries: Entry[] };
    expect(snap.entries.length).toBeGreaterThan(40);
    const live = new Map(
      SOURCES.map(([m, ns, n]) => [`${m}#${n}`, n in ns ? canon(ns[n]) : undefined] as const),
    );
    const keys = configKeys.CONFIG_KEYS as unknown as Record<
      string,
      { default: unknown } | undefined
    >;
    const diffs: string[] = [];
    for (const e of snap.entries) {
      const key = e.export.startsWith("CONFIG_KEYS.")
        ? keys[e.export.split(".")[1]!]?.default
        : live.get(`${e.module}#${e.export}`);
      const now = e.export.startsWith("CONFIG_KEYS.") ? canon(key) : key;
      if (now === undefined) continue; // the export was removed by a refactor task: the profile check carries it
      // A market list or map derived from the registry (MODE_MARKETS, market_mode) may gain IN and US (D-993):
      // the AU entry must still be there with its recorded value.
      const same =
        e.field === "code" &&
        (Array.isArray(e.value) || (typeof e.value === "object" && e.value !== null))
          ? contains(now, e.value)
          : JSON.stringify(now) === JSON.stringify(e.value);
      if (!same) {
        diffs.push(`${e.module} ${e.export}: ${JSON.stringify(e.value)} -> ${JSON.stringify(now)}`);
      }
    }
    expect(diffs, "AU constants that moved").toEqual([]);
  });
});

/** True when `live` holds every member (array) or entry (object) of `recorded`. */
function contains(live: unknown, recorded: unknown): boolean {
  if (Array.isArray(recorded)) {
    return (
      Array.isArray(live) &&
      recorded.every((x) => live.some((y) => JSON.stringify(y) === JSON.stringify(x)))
    );
  }
  if (typeof recorded === "object" && recorded !== null) {
    const l = live as Record<string, unknown> | null;
    return (
      l !== null &&
      typeof l === "object" &&
      Object.entries(recorded).every(([k, v]) => JSON.stringify(l[k]) === JSON.stringify(v))
    );
  }
  return JSON.stringify(live) === JSON.stringify(recorded);
}

// ---- (2) the profile check (A1): the recorded constants equal loadProfile("AU") field by field ----------------

type Rat = { num: string; den: string };
const big = (s: string): bigint => BigInt(s.endsWith("n") ? s.slice(0, -1) : s);
/** A recorded rational equals an integer. */
const ratIs = (r: Rat, n: number): boolean => big(r.num) === BigInt(n) * big(r.den);
/** A recorded rational equals a decimal-percent text such as "0.12%". */
function ratIsPercent(r: Rat, text: string): boolean {
  const m = /^(\d+)(?:\.(\d+))?%$/.exec(text)!;
  const frac = m[2] ?? "";
  const num = BigInt(m[1]! + frac); // value = num / 10^scale / 100
  const den = 10n ** BigInt(frac.length) * 100n;
  return big(r.num) * den === num * big(r.den);
}

type Rule = { kind: string; [k: string]: unknown };
function ruleEq(snap: Rule, seed: Rule, path: string, out: string[]): void {
  if (snap.kind !== seed.kind) return void out.push(`${path}: kind ${snap.kind} vs ${seed.kind}`);
  if (snap.kind === "flat") {
    if (JSON.stringify(canon(seed.feeMicro)) !== JSON.stringify(snap.feeMicro))
      out.push(`${path}: flat fee`);
  } else if (snap.kind === "pct") {
    if (!ratIsPercent(snap.rate as Rat, seed.rate as string)) out.push(`${path}: rate`);
    for (const k of ["minMicro", "maxMicro", "freeFirstBuyBelowMicro"]) {
      if (JSON.stringify(canon(seed[k])) !== JSON.stringify(snap[k])) out.push(`${path}.${k}`);
    }
  } else if (snap.kind === "tiered") {
    if (JSON.stringify(canon(seed.tiers)) !== JSON.stringify(snap.tiers))
      out.push(`${path}: tiers`);
    ruleEq(snap.above as Rule, seed.above as Rule, `${path}.above`, out);
  } else if (snap.kind === "zeroFeeListElse") {
    ruleEq(snap.otherwise as Rule, seed.otherwise as Rule, `${path}.otherwise`, out);
  } else out.push(`${path}: unknown rule kind`);
}

describe("AU constants snapshot equals loadProfile('AU') (D-1007, AT-75 AU)", () => {
  const snapshot = () => JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as { entries: Entry[] };
  const valueOf = (name: string): unknown =>
    snapshot().entries.find((e) => e.export === name)!.value;

  it("market code, zones, cut-off, batch, pre-open, settlement, parcel, indices, tick table, tiers", async () => {
    const db = await freshDb("main");
    const p = await loadProfile(db, "AU");
    const slip = p.slippage!;
    const entries = snapshot().entries;
    // every constant with a profile field has a check below (an entry added to the snapshot needs one)
    const checked = new Set<string>();
    const is = (name: string, actual: unknown) => {
      checked.add(name);
      expect(canon(actual), name).toEqual(valueOf(name));
    };
    for (const e of entries.filter((x) => x.field === "code" && typeof x.value === "string")) {
      checked.add(e.export);
      expect(p.code, `${e.module} ${e.export}`).toBe(e.value);
    }
    for (const name of ["TZ", "QUOTE_TZ"]) is(name, p.tz);
    is("AU_TIME_ZONE", OWNER_TZ);
    is("LATE_2A_AFTER", p.slots!.late_2a_after);
    is("PREOPEN_AT", p.preopenAt);
    is("INDEX_US_KNOWN_LOCAL", p.knownTimeRules!.index_global.local);
    is("SETTLEMENT_LAG_SESSIONS", p.settlementDays);
    is("MIN_MARKETABLE_PARCEL_MICRO", p.parcelFloorMicro);
    is("PARCEL_FLOOR_MICRO", p.parcelFloorMicro);
    is("ADV_FLOOR_PER_PARCEL_MICRO", p.advFloorPerParcelMicro); // parcel floor x 100: A$50,000 (D-1003 b)
    is("HALF_SPREAD_PPM_BY_TIER", slip.half_spread_ppm_by_tier);
    is("TICK_TABLE", p.tickTable);
    is("TIER_RULES", p.tiers);
    is("INDEX_CODE", p.benchmarkIndex);
    is("INDEX_YAHOO_SYMBOL", p.benchmarkYahooSymbol);
    is("MARKET_INDEX_CODE", p.benchmarkIndex);
    is("INDEX_CODES", p.indexCodes);
    is("INDEX_CODES_PIT", p.indexCodes);
    is("US_INDEX_YAHOO_SYMBOLS", {
      [p.regimeIndex!]: (p.fields.regime_index!.value as { yahoo: string }).yahoo,
      [p.volatilityIndex!]: (p.fields.volatility_index!.value as { yahoo: string }).yahoo,
    });
    is("COST_PROFILE_CODES", seedOf("AU")!.costProfileCodes);
    is("CONFIG_KEYS.decision_cutoff.default", p.decisionCutoff);
    // the slippage buckets: recorded as rationals, the seed holds integer bps and numbers
    checked.add("SLIPPAGE_BUCKETS");
    const sb = valueOf("SLIPPAGE_BUCKETS") as { fromAdvMicro: string; bps: Rat }[];
    expect(sb).toHaveLength(slip.buckets.length);
    sb.forEach((b, i) => {
      expect(b.fromAdvMicro).toBe(canon(slip.buckets[i].fromAdvMicro));
      expect(ratIs(b.bps, slip.buckets[i].bps), `bucket ${i} bps`).toBe(true);
    });
    checked.add("DEFAULT_TICK_CROSS_FACTOR");
    expect(ratIs(valueOf("DEFAULT_TICK_CROSS_FACTOR") as Rat, slip.tick_cross_factor)).toBe(true);
    checked.add("DEFAULT_STALL_FLOOR_BPS");
    expect(ratIs(valueOf("DEFAULT_STALL_FLOOR_BPS") as Rat, slip.stall_floor_bps)).toBe(true);
    // what is not a profile field is kept as it is (currency-denominated keys and constants, market lists)
    for (const e of entries) {
      if (e.field === null || e.field === "code" || e.field === "cost_formula")
        checked.add(e.export);
    }
    expect(entries.filter((e) => !checked.has(e.export)).map((e) => e.export)).toEqual([]);
  });

  it("the cost profiles P0 to P6 in the seed equal the recorded COST_PROFILES: names, references, flags, every figure", () => {
    const snap = valueOf("COST_PROFILES") as Record<
      string,
      Record<string, unknown> & { rule: Rule }
    >;
    const seed = AU_COST_PROFILES as unknown as Record<
      string,
      Record<string, unknown> & { rule: Rule }
    >;
    expect(Object.keys(seed)).toEqual(Object.keys(snap));
    const diffs: string[] = [];
    for (const code of Object.keys(snap)) {
      for (const k of ["code", "name", "specRef", "version", "verify", "verified"]) {
        if (JSON.stringify(seed[code]![k]) !== JSON.stringify(snap[code]![k]))
          diffs.push(`${code}.${k}`);
      }
      ruleEq(snap[code]!.rule, seed[code]!.rule, code, diffs);
    }
    expect(diffs).toEqual([]);
    expect(p5IsDefault()).toBe(true);
  });
});

function p5IsDefault(): boolean {
  return seedOf("AU")!.fields.cost_formula.value === "P5" && "P5" in AU_COST_PROFILES;
}
