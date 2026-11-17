// Command-line entry of the nightly pick-reflection stage (M22 C3; AGT-146, AGT-134; D-1424, D-1490..D-1494). Started by the
// nightly orchestrator scripts/arena/signals.mjs after the steelman (task L4 adds the entry), through its own bundle, and it
// hands back nothing but an exit code: no arena, ranking, pick, rule, breaker or e-mail module imports this file (PRD-033).
// A failure never fails the night: it exits 0 and says `degraded` (D-504 pattern).
//
//   reflect [--date YYYY-MM-DD]
//
// Refuses a replay flag (`--replay`, `--recorded`, `--recorded-day`) and any date but the current session (forward only, as the
// Committee). Runs only in full mode, only after the session's review ran, and writes nothing when `pick_reflection_enabled` is
// off. Production has no live role until the bake-off passes: `routesLive` below says so, and then every pick that settled in
// the session gets a `not_written` row ("not available tonight") and no model is called. env: TURSO_MAIN_URL, TURSO_MAIN_TOKEN.
// Output: statuses and counts only.
import type { Client } from "@libsql/client";
import { scriptDb } from "@/lib/db/scriptClient.mjs";
import { loadAgentParams } from "@/lib/agents/params";
import { CONFIG_KEYS } from "@/lib/config/keys";
import { marketDate } from "@/lib/data/calendar";
import { nightlyLlm, type NightCtx } from "@/lib/llm/nightlyLlm";
import { HOME_MARKET, HOME_TZ } from "@/lib/market/homeMarket.mjs";
import { reflectNight, type ReflectLlm, type ReflectResult } from "./reflect";

const MARKET: string = HOME_MARKET;
const MARKET_TZ: string = HOME_TZ;
/** Flags that mean "not a live session": refused whatever else is set (forward only). */
const REPLAY_FLAGS = ["--replay", "--recorded", "--recorded-day"] as const;
// The key the batch-3 review run is recorded under (src/lib/agents/batch3.ts reviewKey). Written out here because this file
// must not import the agents or arena modules (PRD-033).
const reviewedKey = (market: string, d: string): string => `arena-3:${market}:${d}`;

export type ReflectCliDeps = {
  readonly openDb?: (url: string, token: string | undefined) => Client;
  readonly nowMs?: () => number;
  readonly out?: (line: string) => void;
  /** The model side. Default: the nightly seam's router for the case-writing role (rules-only until L1/L4 wire the factory). */
  readonly llm?: (ctx: NightCtx) => ReflectLlm;
  /** Is the case-writing role live? Default: `routesLive` (no). */
  readonly routes?: (ctx: NightCtx) => Promise<{ R6: boolean }> | { R6: boolean };
};

const has = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

function flag(args: readonly string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && has(args[i + 1]) ? args[i + 1] : null;
}

/**
 * The one place the reflection stage asks whether its role is live. Until tasks L1 and L4 ship the factory wiring this answers
 * "no": the night then writes a `not_written` row per settled pick and calls no model. Task L4 replaces this body with the
 * factory's `routesStatus(ctx)` for the case-writing role (the same single pass that enables the steelman, D-1424) and points
 * the nightly seam at the factory; nothing else in this file changes.
 */
export function routesLive(): { R6: boolean } {
  return { R6: false };
}

/** The seam's router for the case-writing role. */
export function nightReflectLlm(ctx: NightCtx): ReflectLlm {
  const night = nightlyLlm(ctx);
  return { router: night.routerFor("R6"), providers: night.providers, store: night.store };
}

/** `pick_reflection_enabled` from the config store (global scope), the registry default when unset or invalid. */
export async function readEnabled(db: Client): Promise<boolean> {
  let value: unknown = CONFIG_KEYS.pick_reflection_enabled.default;
  try {
    // rows-ok: config_version keyed by (key, scope), newest row first, LIMIT 1
    const r = await db.execute({
      sql: "SELECT value_json FROM config_version WHERE key = ? AND scope = 'global' ORDER BY id DESC LIMIT 1",
      args: ["pick_reflection_enabled"],
    });
    if (r.rows[0]) {
      const v: unknown = JSON.parse(String(r.rows[0].value_json));
      if (
        (await CONFIG_KEYS.pick_reflection_enabled.validate(v, () =>
          Promise.resolve(undefined),
        )) === null
      )
        value = v;
    }
  } catch {
    // the default stands
  }
  return value === "on";
}

function summary(d: string, r: ReflectResult): string {
  return `arena-reflect ${MARKET} ${d}: ${r.status} settled=${r.settled} written=${r.written} not_written=${r.notWritten}`;
}

/** The entry the nightly orchestrator runs (task L4 wires it): always an exit code of 0. */
export async function reflectMain(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  deps: ReflectCliDeps = {},
): Promise<number> {
  const out = deps.out ?? ((s: string) => console.log(s));
  const nowMs = deps.nowMs ?? Date.now;
  if (REPLAY_FLAGS.some((f) => argv.includes(f))) {
    out("arena-reflect: refused (a replay or recorded-day run; reflections are forward only)");
    return 0;
  }
  const url = env.TURSO_MAIN_URL;
  if (!has(url)) {
    out("arena-reflect: degraded (database not configured)");
    return 0;
  }
  let db: Client;
  try {
    const open = deps.openDb ?? ((u, t) => scriptDb({ url: u, token: t }));
    db = open(url, has(env.TURSO_MAIN_TOKEN) ? env.TURSO_MAIN_TOKEN : undefined);
  } catch {
    out("arena-reflect: degraded (cannot open database)");
    return 0;
  }
  try {
    const today = marketDate(new Date(nowMs()), MARKET_TZ);
    const d = flag(argv, "--date") ?? today;
    if (d !== today) {
      out(`arena-reflect ${MARKET} ${d}: refused (not the current session; forward only)`);
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
      out(`arena-reflect ${MARKET} ${d}: skipped (no reviewed night)`);
      return 0;
    }
    const enabled = await readEnabled(db);
    if (!enabled) {
      out(`arena-reflect ${MARKET} ${d}: off`);
      return 0;
    }
    const params = await loadAgentParams(db);
    const ctx: NightCtx = { db, params, kbVersion: params.llm.injectionPhrasesVersion };
    const llm = (deps.llm ?? nightReflectLlm)(ctx);
    const live = await (deps.routes ?? routesLive)(ctx);
    const r = await reflectNight(db, {
      market: MARKET,
      d,
      llmParams: params.llm,
      enabled,
      llm,
      live,
      now: new Date(nowMs()).toISOString(),
    });
    out(summary(d, r));
    if (r.status === "failed")
      out(`arena-reflect ${MARKET} ${d}: degraded (settled picks not read)`);
    return 0;
  } catch (error) {
    out(
      `arena-reflect: degraded (unexpected error ${error instanceof Error ? error.name : "unknown"})`,
    );
    return 0;
  } finally {
    db.close();
  }
}
