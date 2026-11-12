// Cohort start stage `ensureCohorts` (M8 T10; docs/M8_design.md decision 3 and 2.6; ARN-001, BLD-030;
// D-072...D-077 registry, sizing, ledger, sleeves; D-094 / D-139 arena_control). HIGH-RISK: it puts the
// A$600 seed cash of every cohort into the ledger.
//
// Before this stage no production code called `startCohorts` (only tests). Batch 2b runs it ONCE per
// night, before the night's signals, and only when the market mode is `full`:
//   - any other mode (`data_only`, `off`, a missing market) is a no-op that writes nothing and returns
//     the reason;
//   - the D-076 registry is seeded (idempotent; a differing stored row raises) so an empty database
//     works, then every slot (execution, and control index for C2 / C3) that has NO cohort row at all
//     gets its first cohort through the existing `startCohorts` path (cohort row, ARN-001 seed cash
//     transaction, 'start' event); a slot that ever had a cohort is never re-opened here (restarts
//     belong to the group-restart path, ARN-053);
//   - the start session is the NEXT trading day after `d`: batch 2b has just loaded the cohorts that
//     started by `d`, so the new cohorts take no part in tonight's signals and trade from the next
//     session, with the normal pipeline and no special path (BLD-030);
//   - a slot whose execution is paused or killed in arena_control (execution, family or market scope,
//     `effectiveControl`) gets no new cohort; it is reported as held back;
//   - a re-run on the same night finds every slot filled and opens nothing.
// No clock is read and there is no randomness beyond the seeded per-cohort PRNG of `planCohortStart`.
// Money is bigint micro-AUD.
import type { Client } from "@libsql/client";
import { controlStates, effectiveControl } from "@/lib/agents/controls";
import { nextTradingDay, type CalendarRow } from "@/lib/data/calendar";
import {
  ARENA_MARKET,
  buildExecutionRegistry,
  carriesSleeve,
  cohortSlots,
  planCohortStart,
  resolveCohortParams,
  type CohortParams,
  type CohortStart,
} from "./cohort";
import { loadCalendar, ARENA_MASTER_SEED } from "./closeBooks";
import { openS2Once } from "@/lib/heartbeat/incidents";
import { loadExecutions, seedExecutions, startCohorts } from "./cohortWriter";
import type { FxRow } from "./seed";

/**
 * The seed the switch to `full` stored (`market_switch.checklist_json.seed` = `{ seed_micro, fx_rate, fx_date,
 * fx_source, activation_day }`, written by switchMarket, D-1107), as the FX row the seed is recomputed from plus the stored
 * amount; null when there is none or the market is the home one (fixed seed).
 */
export async function activationSeed(
  db: Client,
  market: string,
): Promise<{ fx: FxRow; seedMicro: bigint } | null> {
  if (market === ARENA_MARKET) return null;
  const rs = await db.execute({
    // rows-ok: the newest activation row of one market through idx_market_switch_market, LIMIT 1
    sql: "SELECT checklist_json FROM market_switch WHERE market = ? AND to_mode = 'full' ORDER BY id DESC LIMIT 1",
    args: [market],
  });
  const raw = rs.rows[0]?.checklist_json;
  if (raw === undefined || raw === null) return null;
  let seed: Record<string, unknown> | undefined;
  try {
    seed = (JSON.parse(String(raw)) as { seed?: Record<string, unknown> }).seed;
  } catch {
    return null;
  }
  if (seed === undefined || seed === null) return null;
  const { seed_micro: micro, fx_rate: rate, fx_date: date, fx_source: source } = seed;
  if (
    typeof rate !== "string" ||
    typeof date !== "string" ||
    typeof source !== "string" ||
    (typeof micro !== "string" && typeof micro !== "number")
  ) {
    return null;
  }
  return { fx: { rate, date, source }, seedMicro: BigInt(micro) };
}

export type EnsureCohortsOptions = {
  readonly market: string;
  /** The night being decided; new cohorts start on the next trading day after it. */
  readonly d: string;
  /** Not read for engine rows; accepted so callers pass the same options as the batch runs. */
  readonly now?: () => string;
  readonly calendar?: CalendarRow[];
  readonly masterSeed?: bigint;
  /** Controls per family for C2 / C3 (batch 2b passes the configured live count). */
  readonly controlsPerFamily?: number;
  /** Overrides for the resolved cohort parameters (the default seed is the ARN-001 A$600). */
  readonly params?: CohortParams;
  /** The activation day's FX close for a market that seeds by conversion (IN, US; D-1107); the home market ignores it. */
  readonly fxRow?: FxRow | null;
  /** D-191: also open cohorts for the leverage-sleeve executions (tests of the sleeve only). */
  readonly withLeverage?: boolean;
};

export type EnsureCohortsStatus = "opened" | "nothing_to_do" | "noop";

export type EnsureCohortsResult = {
  readonly status: EnsureCohortsStatus;
  /** Why nothing was done (`mode_data_only`, `mode_off`, `market_missing`, `no_next_session`) or null. */
  readonly reason: string | null;
  readonly startD: string | null;
  /** Cohorts newly written by this call. */
  readonly opened: number;
  /** Ids planned for this call (the opened ones, in slot order). */
  readonly cohortIds: readonly string[];
  /** Slots held back by arena_control (paused or killed). */
  readonly held: number;
};

const none = (
  status: EnsureCohortsStatus,
  reason: string | null,
  startD: string | null = null,
  held = 0,
): EnsureCohortsResult => ({ status, reason, startD, opened: 0, cohortIds: [], held });

export async function ensureCohorts(
  db: Client,
  o: EnsureCohortsOptions,
): Promise<EnsureCohortsResult> {
  const market = await db.execute({
    sql: "SELECT mode FROM market WHERE code = ?",
    args: [o.market],
  });
  if (market.rows.length === 0) return none("noop", "market_missing");
  const mode = String(market.rows[0]!.mode);
  if (mode !== "full") return none("noop", `mode_${mode}`);

  const calendar = o.calendar ?? (await loadCalendar(db, o.market));
  const startD = nextTradingDay(o.d, calendar);
  if (startD <= o.d) return none("noop", "no_next_session");

  await seedExecutions(
    db,
    buildExecutionRegistry({ market: o.market }).filter((e) => e.market === o.market),
  );
  const executions = (await loadExecutions(db)).filter(
    // D-191: no leverage: executions with a sleeve start no cohort
    (e) =>
      e.market === o.market &&
      e.status === "active" &&
      (o.withLeverage === true || !carriesSleeve(e)),
  );
  const states = controlStates(
    (await db.execute("SELECT scope, scope_key, state FROM arena_control ORDER BY id")).rows.map(
      (r) => ({ scope: String(r.scope), scopeKey: String(r.scope_key), state: String(r.state) }),
    ),
  );
  const have = new Set(
    (await db.execute("SELECT execution_id, control_idx FROM cohort")).rows.map(
      (r) => `${String(r.execution_id)}|${r.control_idx === null ? "" : String(r.control_idx)}`,
    ),
  );
  const byId = new Map(executions.map((e) => [e.id, e]));
  const masterSeed = o.masterSeed ?? ARENA_MASTER_SEED;

  // ARN-119 / D-1107: resolved lazily, only when a start is planned. A market other than the home one seeds from what its
  // activation stored; with none the night is a noop and an S2 incident (never a throw every night); the recomputed seed
  // must equal the stored amount.
  let params: CohortParams | null = o.params ?? null;
  const starts: CohortStart[] = [];
  let held = 0;
  for (const slot of cohortSlots(executions, o.controlsPerFamily)) {
    const key = `${slot.executionId}|${slot.controlIdx === null ? "" : String(slot.controlIdx)}`;
    if (have.has(key)) continue;
    const execution = byId.get(slot.executionId)!;
    const state = effectiveControl(states, {
      market: o.market,
      family: execution.family,
      execution: execution.id,
    });
    if (state !== "enabled") {
      held += 1;
      continue;
    }
    if (params === null) {
      const stored = o.fxRow !== undefined ? null : await activationSeed(db, o.market);
      if (o.fxRow === undefined && o.market !== ARENA_MARKET && stored === null) {
        await openS2Once(
          db,
          "seed_missing",
          { market: o.market },
          new Date().toISOString(),
          undefined,
          `Market ${o.market} has no stored activation seed, so its books were not opened`,
        );
        return none("noop", "seed_missing");
      }
      params = resolveCohortParams({ market: o.market, fxRow: o.fxRow ?? stored?.fx ?? null });
      if (stored !== null && params.seedMicro !== stored.seedMicro) {
        throw new Error(`activation seed mismatch for ${o.market}`);
      }
    }
    starts.push(
      planCohortStart({ execution, controlIdx: slot.controlIdx, startD, params, masterSeed }),
    );
  }
  if (starts.length === 0) return none("nothing_to_do", null, startD, held);
  const { written } = await startCohorts(db, starts);
  return {
    status: written > 0 ? "opened" : "nothing_to_do",
    reason: null,
    startD,
    opened: written,
    cohortIds: starts.map((s) => s.id),
    held,
  };
}
