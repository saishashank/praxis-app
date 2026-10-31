// Command-line entry of the nightly steelman stage (M11-lite WP4; AGT-133, PRD-029; D-480, D-484, D-485).
// Started by the nightly orchestrator scripts/arena/signals.mjs after the picks batch, through its own
// bundle, and it hands back nothing but an exit code: no arena, ranking or learning module imports this
// folder (PRD-033). A steelman failure never fails the night: it exits 0 and says `degraded`.
//
//   steelman [--date YYYY-MM-DD] [--phase all|3|picks|steelman]
//
// Runs only for a phase that includes the review, only in full mode, and only when batch 3 succeeded for
// the session (`arena-3:<market>:<d>`); otherwise it says why and writes nothing. Idempotent.
// Production has no model wired (D-480): the default routers are rules-only, so every subject reads
// "not written tonight (no model available)" until the Owner enables a live router after the R6
// bake-off (`deps.llm`). env: TURSO_MAIN_URL, TURSO_MAIN_TOKEN. Output: statuses and counts only.
import { createClient, type Client } from "@libsql/client";
import { loadAgentParams, type AgentParams } from "@/lib/agents/params";
import { CONFIG_KEYS } from "@/lib/config/keys";
import { marketDate, type CalendarKind, type CalendarRow } from "@/lib/data/calendar";
import { createRouter } from "@/lib/llm/router";
import { DbStore } from "@/lib/llm/store";
import { steelmanNight, type NightResult, type SteelmanKeys, type SteelmanLlm } from "./night";

const MARKET = "AU";
const MARKET_TZ = "Australia/Sydney";
const PHASES = ["all", "3", "picks", "steelman"];
// The key the batch-3 review run is recorded under (src/lib/agents/batch3.ts reviewKey). Written out
// here because this folder must not import the agents or arena modules (PRD-033).
const reviewedKey = (market: string, d: string): string => `arena-3:${market}:${d}`;

export type SteelmanCliDeps = {
  readonly openDb?: (url: string, token: string | undefined) => Client;
  readonly nowMs?: () => number;
  readonly out?: (line: string) => void;
  /** The model side. Default: rules-only routers over the call log (nothing is called, D-480). */
  readonly llm?: (ctx: { db: Client; params: AgentParams; kbVersion: string }) => SteelmanLlm;
};

const has = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

function flag(args: readonly string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && has(args[i + 1]) ? args[i + 1] : null;
}

/** Rules-only routers: D-177, no role has a live model before its bake-off passes. */
export function rulesOnlySteelmanLlm(ctx: {
  db: Client;
  params: AgentParams;
  kbVersion: string;
}): SteelmanLlm {
  const store = new DbStore(ctx.db);
  const router = createRouter({
    mode: "rules-only",
    params: ctx.params.llm,
    kbVersion: ctx.kbVersion,
    store,
    providers: [],
  });
  return { authorRouter: router, criticRouterFor: () => null, providers: [], store };
}

/** The three steelman keys from the config store (global scope), registry default when unset or invalid. */
async function readKeys(db: Client, params: AgentParams): Promise<SteelmanKeys> {
  const names = [
    "steelman_daily_cards",
    "evidence_pack_max_items",
    "steelman_suggestion_expiry_sessions",
  ] as const;
  const out: Record<string, number> = {};
  for (const k of names) {
    let value: unknown = CONFIG_KEYS[k].default;
    try {
      const r = await db.execute({
        sql: "SELECT value_json FROM config_version WHERE key = ? AND scope = 'global' ORDER BY id DESC LIMIT 1",
        args: [k],
      });
      if (r.rows[0]) {
        const v: unknown = JSON.parse(String(r.rows[0].value_json));
        if ((await CONFIG_KEYS[k].validate(v, () => Promise.resolve(undefined))) === null)
          value = v;
      }
    } catch {
      // the default stands
    }
    out[k] = Number(value);
  }
  return {
    dailyCards: out.steelman_daily_cards,
    maxItems: out.evidence_pack_max_items,
    expirySessions: out.steelman_suggestion_expiry_sessions,
    decisionCutoff: params.decisionCutoff,
  };
}

async function readCalendar(db: Client, market: string): Promise<CalendarRow[]> {
  const rs = await db.execute({
    sql: "SELECT d, kind, close_time, confirmed FROM trading_calendar WHERE market = ? ORDER BY d",
    args: [market],
  });
  return rs.rows.map((r) => ({
    d: String(r.d),
    kind: String(r.kind) as CalendarKind,
    close_time: r.close_time === null ? null : String(r.close_time),
    confirmed: Number(r.confirmed) === 1 ? 1 : 0,
  }));
}

function summary(d: string, r: NightResult): string {
  const w = r.notWritten;
  return (
    `arena-steelman ${MARKET} ${d}: ${r.status} requested=${r.requested} written=${r.written}` +
    ` limit=${w.limit} budget=${w.budget} no_model=${w.noModel} critic=${w.critic}` +
    ` claims=${r.claimsValid}/${r.claimsTotal} hidden=${r.criticHidden}` +
    ` settled=${r.settled} expired=${r.expired} suggestions=${r.suggestions}`
  );
}

export async function steelmanMain(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  deps: SteelmanCliDeps = {},
): Promise<number> {
  const out = deps.out ?? ((s: string) => console.log(s));
  const nowMs = deps.nowMs ?? Date.now;
  const phase = flag(argv, "--phase") ?? "all";
  if (!PHASES.includes(phase) || argv.includes("--replay")) return 0;
  const url = env.TURSO_MAIN_URL;
  if (!has(url)) {
    out("arena-steelman: degraded (database not configured)");
    return 0;
  }
  let db: Client;
  try {
    const open = deps.openDb ?? ((u, t) => createClient({ url: u, authToken: t }));
    db = open(url, has(env.TURSO_MAIN_TOKEN) ? env.TURSO_MAIN_TOKEN : undefined);
  } catch {
    out("arena-steelman: degraded (cannot open database)");
    return 0;
  }
  try {
    const d = flag(argv, "--date") ?? marketDate(new Date(nowMs()), MARKET_TZ);
    const mode = await db.execute({
      sql: "SELECT mode FROM market WHERE code = ?",
      args: [MARKET],
    });
    if (mode.rows.length === 0 || String(mode.rows[0].mode) !== "full") return 0;
    const reviewed = await db.execute({
      sql: `SELECT 1 FROM run_record WHERE concurrency_key = ? AND status IN ('success', 'degraded')`,
      args: [reviewedKey(MARKET, d)],
    });
    if (reviewed.rows.length === 0) {
      out(`arena-steelman ${MARKET} ${d}: skipped (no reviewed night)`);
      return 0;
    }
    const params = await loadAgentParams(db);
    const kbVersion = params.llm.injectionPhrasesVersion;
    const llm = (deps.llm ?? rulesOnlySteelmanLlm)({ db, params, kbVersion });
    const r = await steelmanNight(db, {
      market: MARKET,
      d,
      llmParams: params.llm,
      keys: await readKeys(db, params),
      llm,
      calendar: await readCalendar(db, MARKET),
      now: new Date(nowMs()).toISOString(),
    });
    out(summary(d, r));
    if (r.status === "failed")
      out(`arena-steelman ${MARKET} ${d}: degraded (night row not stored)`);
    else if (r.written === 0 && r.requested > 0) {
      const noModel =
        r.notWritten.noModel > 0 && r.notWritten.noModel + r.notWritten.limit === r.requested;
      out(
        `arena-steelman ${MARKET} ${d}: not written tonight (${noModel ? "no model available" : "see counts"})`,
      );
    }
    return 0;
  } catch (error) {
    out(
      `arena-steelman: degraded (unexpected error ${error instanceof Error ? error.name : "unknown"})`,
    );
    return 0;
  } finally {
    db.close();
  }
}
