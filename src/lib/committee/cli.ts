// Command-line entry of the nightly Committee stage (M22 C1; AGT-145, AGT-132; D-1417, D-1418, D-1419). Started by the nightly
// orchestrator scripts/arena/signals.mjs after the steelman and the reflections (task L4 adds the entry), through its own
// bundle, and it hands back nothing but an exit code: no arena, ranking, pick, rule, breaker or e-mail module imports this
// folder (PRD-033). A Committee failure never fails the night: it exits 0 and says `degraded` (D-504 pattern).
//
//   committee [--date YYYY-MM-DD]
//
// Refuses a replay flag (`--replay`, `--recorded`, `--recorded-day`) and any date but the current session (forward only,
// D-1417). Runs only in full mode, only after the session's review ran, and only when `committee_enabled` is on and a
// pre-registration exists. Production has no live role until the bake-offs pass: `routesLive` below says so, and then
// every shortlisted signal gets a `skipped_models` row and no model is called. env: TURSO_MAIN_URL, TURSO_MAIN_TOKEN.
// Output: statuses and counts only.
import type { Client } from "@libsql/client";
import { scriptDb } from "@/lib/db/scriptClient.mjs";
import { decisionCutoffUtc } from "@/lib/agents/decisionView";
import { loadAgentParams, type AgentParams } from "@/lib/agents/params";
import { CONFIG_KEYS } from "@/lib/config/keys";
import { marketDate } from "@/lib/data/calendar";
import { nightlyLlm, type NightCtx } from "@/lib/llm/nightlyLlm";
import { HOME_MARKET, HOME_TZ } from "@/lib/market/homeMarket.mjs";
import type { CommitteeLlm } from "./debate";
import {
  committeeNight,
  type CommitteeKeys,
  type CommitteeNightResult,
  type LiveRoles,
} from "./night";

const MARKET: string = HOME_MARKET;
const MARKET_TZ: string = HOME_TZ;
/** D-1417: the hard stop of the stage, HH:MM market time; a signal not started by then is rated `skipped_time`. */
const COMMITTEE_STOP = "19:05"; // threshold-ok: D-1417 hard stop
/** Flags that mean "not a live session": refused whatever else is set (forward only, D-1417). */
const REPLAY_FLAGS = ["--replay", "--recorded", "--recorded-day"] as const;
// The key the batch-3 review run is recorded under (src/lib/agents/batch3.ts reviewKey). Written out here because this
// folder must not import the agents or arena modules (PRD-033).
const reviewedKey = (market: string, d: string): string => `arena-3:${market}:${d}`;

export type CommitteeCliDeps = {
  readonly openDb?: (url: string, token: string | undefined) => Client;
  readonly nowMs?: () => number;
  readonly out?: (line: string) => void;
  /** The model side. Default: the nightly seam's routers (rules-only until task L1 points the seam at the factory). */
  readonly llm?: (ctx: NightCtx) => CommitteeLlm;
  /** Which of R6 and R7 are live. Default: `routesLive` (none yet). */
  readonly routes?: (ctx: NightCtx) => Promise<LiveRoles> | LiveRoles;
};

const has = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

function flag(args: readonly string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && has(args[i + 1]) ? args[i + 1] : null;
}

/**
 * The one place the Committee asks whether its two roles are live. Until task L1 ships the factory this answers "neither":
 * the night then writes a `skipped_models` row per shortlisted signal and calls no model. Tasks L1 and L4 replace this body
 * with the factory's `routesStatus(ctx)` (R6 and R7 both passing their bake-off and listed in `llm_live_roles`, D-1417) and
 * make the nightly seam build the live routers; nothing else in this folder changes.
 */
export function routesLive(): LiveRoles {
  return { R6: false, R7: false };
}

/** The seam's rules-only routers shaped to the Committee: one router per role, any selection (nothing is called). */
export function nightCommitteeLlm(ctx: NightCtx): CommitteeLlm {
  const night = nightlyLlm(ctx);
  return {
    routerFor: (role) => night.routerFor(role),
    providers: night.providers,
    store: night.store,
  };
}

async function readKey(db: Client, k: keyof typeof CONFIG_KEYS): Promise<unknown> {
  let value: unknown = CONFIG_KEYS[k].default;
  try {
    // rows-ok: config_version keyed by (key, scope), newest row first, LIMIT 1
    const r = await db.execute({
      sql: "SELECT value_json FROM config_version WHERE key = ? AND scope = 'global' ORDER BY id DESC LIMIT 1",
      args: [k],
    });
    if (r.rows[0]) {
      const v: unknown = JSON.parse(String(r.rows[0].value_json));
      if ((await CONFIG_KEYS[k].validate(v, () => Promise.resolve(undefined))) === null) value = v;
    }
  } catch {
    // the default stands
  }
  return value;
}

/** The Committee keys from the config store (global scope), registry default when unset or invalid. */
export async function readKeys(db: Client, params: AgentParams): Promise<CommitteeKeys> {
  return {
    enabled: (await readKey(db, "committee_enabled")) === "on",
    shortlist: Number(await readKey(db, "committee_shortlist")),
    maxItems: Number(await readKey(db, "evidence_pack_max_items")),
    decisionCutoff: params.decisionCutoff,
    retentionMonths: Number(await readKey(db, "committee_call_record_retention_months")),
  };
}

function summary(d: string, r: CommitteeNightResult): string {
  return (
    `arena-committee ${MARKET} ${d}: ${r.status} requested=${r.requested} rated=${r.rated}` +
    ` skipped_budget=${r.skippedBudget} skipped_time=${r.skippedTime} skipped_models=${r.skippedModels}` +
    ` failed=${r.failed} already_done=${r.alreadyDone}`
  );
}

export async function committeeMain(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  deps: CommitteeCliDeps = {},
): Promise<number> {
  const out = deps.out ?? ((s: string) => console.log(s));
  const nowMs = deps.nowMs ?? Date.now;
  if (REPLAY_FLAGS.some((f) => argv.includes(f))) {
    out("arena-committee: refused (a replay or recorded-day run; the Committee is forward only)");
    return 0;
  }
  const url = env.TURSO_MAIN_URL;
  if (!has(url)) {
    out("arena-committee: degraded (database not configured)");
    return 0;
  }
  let db: Client;
  try {
    const open = deps.openDb ?? ((u, t) => scriptDb({ url: u, token: t }));
    db = open(url, has(env.TURSO_MAIN_TOKEN) ? env.TURSO_MAIN_TOKEN : undefined);
  } catch {
    out("arena-committee: degraded (cannot open database)");
    return 0;
  }
  try {
    const today = marketDate(new Date(nowMs()), MARKET_TZ);
    const d = flag(argv, "--date") ?? today;
    if (d !== today) {
      out(`arena-committee ${MARKET} ${d}: refused (not the current session; forward only)`);
      return 0;
    }
    // rows-ok: market keyed by code, one row
    const mode = await db.execute({
      sql: "SELECT mode FROM market WHERE code = ?",
      args: [MARKET],
    });
    if (mode.rows.length === 0 || String(mode.rows[0].mode) !== "full") return 0;
    // rows-ok: run_record unique concurrency_key, one row
    const reviewed = await db.execute({
      sql: `SELECT 1 FROM run_record WHERE concurrency_key = ? AND status IN ('success', 'degraded')`,
      args: [reviewedKey(MARKET, d)],
    });
    if (reviewed.rows.length === 0) {
      out(`arena-committee ${MARKET} ${d}: skipped (no reviewed night)`);
      return 0;
    }
    const params = await loadAgentParams(db);
    const ctx: NightCtx = { db, params, kbVersion: params.llm.injectionPhrasesVersion };
    const llm = (deps.llm ?? nightCommitteeLlm)(ctx);
    const live = await (deps.routes ?? routesLive)(ctx);
    const r = await committeeNight(db, {
      market: MARKET,
      d,
      today,
      llmParams: params.llm,
      keys: await readKeys(db, params),
      llm,
      live,
      now: new Date(nowMs()).toISOString(),
      nowMs,
      deadlineMs: Date.parse(decisionCutoffUtc(d, COMMITTEE_STOP, MARKET_TZ)),
    });
    out(summary(d, r));
    if (r.status === "failed") out(`arena-committee ${MARKET} ${d}: degraded (night not stored)`);
    return 0;
  } catch (error) {
    out(
      `arena-committee: degraded (unexpected error ${error instanceof Error ? error.name : "unknown"})`,
    );
    return 0;
  } finally {
    db.close();
  }
}
