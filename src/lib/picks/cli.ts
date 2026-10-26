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
import { createClient, type Client } from "@libsql/client";
import { reviewKey } from "@/lib/agents/batch3";
import { loadAgentParams } from "@/lib/agents/params";
import { loadCalendar } from "@/lib/arena/closeBooks";
import { marketDate } from "@/lib/data/calendar";
import { runPicksNight } from "./nightly";

const MARKET = "AU";
const MARKET_TZ = "Australia/Sydney";
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
    const open = deps.openDb ?? ((u, t) => createClient({ url: u, authToken: t }));
    db = open(url, has(env.TURSO_MAIN_TOKEN) ? env.TURSO_MAIN_TOKEN : undefined);
  } catch {
    out("arena-picks: failed (cannot open database)");
    return 1;
  }
  try {
    const d = flag(argv, "--date") ?? marketDate(new Date(nowMs()), MARKET_TZ);
    const mode = await db.execute({
      sql: "SELECT mode FROM market WHERE code = ?",
      args: [MARKET],
    });
    // Not in full mode: batch 2b has already said so (data_only_guard); nothing to add.
    if (mode.rows.length === 0 || String(mode.rows[0].mode) !== "full") return 0;
    const reviewed = await db.execute({
      sql: `SELECT 1 FROM run_record WHERE concurrency_key = ? AND status IN ('success', 'degraded')`,
      args: [reviewKey(MARKET, d)],
    });
    if (reviewed.rows.length === 0) {
      out(`arena-picks ${MARKET} ${d}: skipped (no reviewed night)`);
      return 0;
    }
    const p = await runPicksNight(db, {
      market: MARKET,
      d,
      params: await loadAgentParams(db),
      calendar: await loadCalendar(db, MARKET),
      now: new Date(nowMs()).toISOString(),
    });
    const t = p.tracking;
    out(
      `arena-picks ${MARKET} ${d}: published=${p.published} candidates=${p.candidates}` +
        ` bought=${t.bought} missed=${t.missed} closed=${t.closed} open=${t.open}` +
        ` checked=${p.checks.checked} withdrawn=${p.checks.withdrawn}`,
    );
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
