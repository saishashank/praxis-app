// Command-line entry of the CXA-007 monthly proposal job (M23 T3; D-1637, D-1642, D-1738). Started by the nightly orchestrator
// scripts/arena/signals.mjs after the Committee and its trial result, through its own bundle, and it hands back nothing but an
// exit code: no arena, ranking, pick, rule, breaker, sizing or e-mail module imports this folder (PRD-033). A failure never
// fails the night: it exits 0 and says `degraded` (D-504 pattern).
//
//   proposals [--date YYYY-MM-DD]
//
// Refuses a replay flag and any date but the current session (forward only). Does nothing unless the factory reports role R2
// live (production: `llm_live_roles` is empty until the Owner lists R2 after a bake-off PASS), then it prints "no live model".
// env: TURSO_MAIN_URL, TURSO_MAIN_TOKEN. Output: statuses and counts only, never any text of an answer.
import type { Client } from "@libsql/client";
import { scriptDb } from "@/lib/db/scriptClient.mjs";
import { loadAgentParams } from "@/lib/agents/params";
import { getConfig } from "@/lib/config/store";
import { marketDate } from "@/lib/data/calendar";
import { DEFAULT_IGNORED_UPPERCASE } from "@/lib/llm/grounding";
import { loadNightLlm, type NightCtx, type NightLlm } from "@/lib/llm/nightlyLlm";
import { HOME_MARKET, HOME_TZ } from "@/lib/market/homeMarket.mjs";
import { PROPOSAL_TASK_VERSION, runProposalJob, type JobOutcome, type ProposalAsk } from "./job";
import { parseProposalList, RESPONSE_SCHEMA } from "./schema";

const MARKET: string = HOME_MARKET;
const REPLAY_FLAGS = ["--replay", "--recorded", "--recorded-day"] as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const has = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

export type ProposalsCliDeps = {
  readonly openDb?: (url: string, token: string | undefined) => Client;
  readonly nowMs?: () => number;
  readonly out?: (line: string) => void;
  /** The night's routers; default: the factory's (rules-only unless R2 is listed, passed and keyed). */
  readonly llm?: (ctx: NightCtx) => Promise<NightLlm>;
};

/**
 * The model's part: the R2 router (budget bucket "R2", a nightly call) is asked for the wrapper. Null (nothing is asked)
 * unless R2 is live tonight. The router filters and datamarks the untrusted titles, validates the wrapper and grounds the answer.
 */
export function askOf(
  night: Pick<NightLlm, "routerFor" | "status">,
  d: string,
): ProposalAsk | null {
  if (!night.status.roles.some((r) => r.role === "R2" && r.live)) return null;
  const router = night.routerFor("R2");
  return async (req) => {
    const res = await router.route({
      role: "R2",
      budgetKey: "R2",
      market: MARKET,
      d,
      nightly: true,
      templateVersion: PROPOSAL_TASK_VERSION,
      task: req.task,
      facts: req.facts,
      untrusted: req.untrusted,
      parse: parseProposalList,
      schema: RESPONSE_SCHEMA,
      rules: { proposals: [] },
      maxOutputTokens: req.maxOutputTokens,
      ignoreUppercase: [...DEFAULT_IGNORED_UPPERCASE, ...req.ignoreUppercase],
    });
    return {
      value: res.value,
      live: res.llmUsed,
      modelId: res.llmUsed ? res.source : null,
      budgetExhausted: res.budgetExhausted,
    };
  };
}

function flag(args: readonly string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && has(args[i + 1]) ? args[i + 1]! : null;
}

const line = (d: string, o: JobOutcome): string =>
  `arena-proposals ${MARKET} ${d}: ${o.status === "no_live_model" ? "no live model" : o.status} ` +
  `stored=${o.stored} refused=${o.refused} cut=${o.cut}`;

export async function proposalsMain(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  deps: ProposalsCliDeps = {},
): Promise<number> {
  const out = deps.out ?? ((s: string) => console.log(s));
  const nowMs = deps.nowMs ?? Date.now;
  if (REPLAY_FLAGS.some((f) => argv.includes(f))) {
    out("arena-proposals: refused (a replay or recorded-day run; proposals are forward only)");
    return 0;
  }
  const url = env.TURSO_MAIN_URL;
  if (!has(url)) {
    out("arena-proposals: degraded (database not configured)");
    return 0;
  }
  let db: Client;
  try {
    const open = deps.openDb ?? ((u, t) => scriptDb({ url: u, token: t }));
    db = open(url, has(env.TURSO_MAIN_TOKEN) ? env.TURSO_MAIN_TOKEN : undefined);
  } catch {
    out("arena-proposals: degraded (cannot open database)");
    return 0;
  }
  try {
    const today = marketDate(new Date(nowMs()), HOME_TZ);
    const given = flag(argv, "--date");
    const d = given !== null && DAY.test(given) ? given : today;
    if (d !== today) {
      out(`arena-proposals ${MARKET} ${d}: refused (not the current session; forward only)`);
      return 0;
    }
    // rows-ok: market keyed by code, one row
    const m = await db.execute({
      sql: "SELECT enabled FROM market WHERE code = ?",
      args: [MARKET],
    });
    if (m.rows.length !== 1 || Number(m.rows[0]!.enabled) !== 1) return 0;
    const perMonth = Number(await getConfig(db, "llm_proposals_per_month"));
    const params = await loadAgentParams(db);
    const night = await (deps.llm ?? loadNightLlm)({
      db,
      params,
      kbVersion: params.llm.injectionPhrasesVersion,
    });
    const r = await runProposalJob(db, {
      market: MARKET,
      d,
      now: new Date(nowMs()).toISOString(),
      perMonth,
      ask: askOf(night, d),
    });
    out(line(d, r));
    return 0;
  } catch (error) {
    out(
      `arena-proposals: degraded (unexpected error ${error instanceof Error ? error.name : "unknown"})`,
    );
    return 0;
  } finally {
    db.close();
  }
}
