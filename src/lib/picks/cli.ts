// Command-line entry of the nightly picks phase (AGT-113, ARN-095; D-181). Started by the nightly
// orchestrator script scripts/arena/signals.mjs after its own run, through a separate bundle, so no
// arena, ranking or learning module imports this folder (tests/picks/isolation.test.ts): picks are
// published from the night's results and never read back by them.
//
//   picks [--date YYYY-MM-DD] [--phase all|picks|...]
//
// It runs only for a phase that includes the review (all, 3) or for `picks` alone, only in full
// mode, and only when batch 3 succeeded for the session (`arena-3:<market>:<d>`); otherwise it says
// why and writes nothing. Idempotent: a re-run of the same night writes nothing new.
// env: TURSO_MAIN_URL, TURSO_MAIN_TOKEN. Output: statuses and counts only.
// Exit codes: 0 success or expected skip, 1 failed.
import type { Client } from "@libsql/client";
import { scriptDb } from "@/lib/db/scriptClient.mjs";
import { reviewKey } from "@/lib/agents/batch3";
import { loadAgentParams } from "@/lib/agents/params";
import { loadCalendar } from "@/lib/arena/closeBooks";
import { marketDate } from "@/lib/data/calendar";
import { runDailyLearning } from "@/lib/learning/daily";
import { pickHooks } from "./dailyHooks";
import { runPicksNight } from "./nightly";
import { recordPicksNight } from "./noPicks";
import { runPickPortfolio } from "./portfolioStore";
import { resolveCliMarket } from "@/lib/arena/marketFlag";
import { loadProfile } from "@/lib/market/profile";

const PHASES_WITH_PICKS = ["all", "3", "picks"];

export type PicksCliDeps = {
  readonly openDb?: (url: string, token: string | undefined) => Client;
  readonly nowMs?: () => number;
  readonly out?: (line: string) => void;
};

const has = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

function flag(args: readonly string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && has(args[i + 1]) ? args[i + 1] : null;
}

export async function picksMain(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  deps: PicksCliDeps = {},
): Promise<number> {
  const out = deps.out ?? ((s: string) => console.log(s));
  const nowMs = deps.nowMs ?? Date.now;
  const phase = flag(argv, "--phase") ?? "all";
  if (!PHASES_WITH_PICKS.includes(phase) || argv.includes("--replay")) return 0;
  const url = env.TURSO_MAIN_URL;
  if (!has(url)) {
    out("arena-picks: failed (database not configured)");
    return 1;
  }
  let db: Client;
  try {
    const open = deps.openDb ?? ((u, t) => scriptDb({ url: u, token: t }));
    db = open(url, has(env.TURSO_MAIN_TOKEN) ? env.TURSO_MAIN_TOKEN : undefined);
  } catch {
    out("arena-picks: failed (cannot open database)");
    return 1;
  }
  try {
    const chosen = await resolveCliMarket(db, argv);
    if (!chosen.ok) {
      out(`arena-picks: ${chosen.line}`);
      return 2;
    }
    const market = chosen.market;
    const tz = (await loadProfile(db, market)).tz!;
    const d = flag(argv, "--date") ?? marketDate(new Date(nowMs()), tz);
    const mode = await db.execute({
      sql: "SELECT mode FROM market WHERE code = ?",
      args: [market],
    });
    // Not in full mode: batch 2b has already said so (data_only_guard); nothing to add.
    if (mode.rows.length === 0 || String(mode.rows[0].mode) !== "full") return 0;
    const reviewed = await db.execute({
      sql: `SELECT 1 FROM run_record WHERE concurrency_key = ? AND status IN ('success', 'degraded')`,
      args: [reviewKey(market, d)],
    });
    if (reviewed.rows.length === 0) {
      out(`arena-picks ${market} ${d}: skipped (no reviewed night)`);
      return 0;
    }
    const p = await runPicksNight(db, {
      market: market,
      d,
      params: await loadAgentParams(db),
      calendar: await loadCalendar(db, market),
      now: new Date(nowMs()).toISOString(),
    });
    const t = p.tracking;
    out(
      `arena-picks ${market} ${d}: published=${p.published} candidates=${p.candidates}` +
        ` bought=${t.bought} missed=${t.missed} closed=${t.closed} open=${t.open}` +
        ` checked=${p.checks.checked} withdrawn=${p.checks.withdrawn} shortlist=${p.shortlist}`,
    );
    if (p.noPicksLine !== null) {
      out(
        `arena-picks ${market} ${d}: no_picks blocked=${JSON.stringify(p.blocked)} ${p.noPicksLine}`,
      );
    }
    // OPS-110: the night's outcome and its plain-words reason, for Home and the Evening Review
    try {
      await recordPicksNight(db, {
        market: market,
        d,
        now: new Date(nowMs()).toISOString(),
        published: p.published,
        candidates: p.candidates,
        shortlist: p.shortlist,
        blocked: p.blocked,
        line: p.noPicksLine,
      });
    } catch {
      out(`arena-picks ${market} ${d}: outcome row not stored`);
    }
    // D-913: the Follow the picks portfolio, rebuilt after the picks; a failure never stops them
    try {
      const f = await runPickPortfolio(db, { market: market, d });
      out(
        `arena-portfolio ${market} ${d}: trades=${f.trades} open=${f.open} days=${f.days} skipped=${f.skipped}`,
      );
    } catch (error) {
      out(
        `arena-portfolio ${market} ${d}: failed (${error instanceof Error ? error.name : "unknown"})`,
      );
    }
    // D-921: the daily learning loop, after the picks and the portfolio; a failure never stops them
    try {
      const l = await runDailyLearning(db, {
        market: market,
        d,
        calendar: await loadCalendar(db, market),
        now: new Date(nowMs()).toISOString(),
        hooks: pickHooks,
      });
      out(
        `arena-learning ${market} ${d}: movers=${l.movers} lessons=${l.lessons} improvements=${l.improvements} hypotheses=${l.hypotheses}`,
      );
    } catch (error) {
      out(
        `arena-learning ${market} ${d}: failed (${error instanceof Error ? error.name : "unknown"})`,
      );
    }
    return 0;
  } catch (error) {
    out(
      `arena-picks: failed (unexpected error ${error instanceof Error ? error.name : "unknown"})`,
    );
    return 1;
  } finally {
    db.close();
  }
}
