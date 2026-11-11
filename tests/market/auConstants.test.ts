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
      if (JSON.stringify(now) !== JSON.stringify(e.value)) {
        diffs.push(`${e.module} ${e.export}: ${JSON.stringify(e.value)} -> ${JSON.stringify(now)}`);
      }
    }
    expect(diffs, "AU constants that moved").toEqual([]);
  });
});
