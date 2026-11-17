// Command-line entry of the Committee trial steps (M22 C2; VAL-111, D-1420, D-1421). Two phases of the nightly run, each
// started by the orchestrator (task L4 adds the calls) through its own bundle, and neither hands back anything but an exit
// code and a status line:
//
//   trial prereg   before the Committee night: writes the pre-registration of a new trial when the switch is on
//   trial result   after the Committee night: the night's interim row, or the one final verdict and the switch off
//
// Forward only: a replay flag (`--replay`, `--recorded`, `--recorded-day`) and any date but the current session are refused.
// A failure never fails the night: exit 0 with `degraded`. env: TURSO_MAIN_URL, TURSO_MAIN_TOKEN. Output: statuses only.
import type { Client } from "@libsql/client";
import { scriptDb } from "@/lib/db/scriptClient.mjs";
import { marketDate } from "@/lib/data/calendar";
import { HOME_MARKET, HOME_TZ } from "@/lib/market/homeMarket.mjs";
import { ensurePrereg } from "./prereg";
import { trialNight } from "./trial";

const MARKET: string = HOME_MARKET;
const REPLAY_FLAGS = ["--replay", "--recorded", "--recorded-day"] as const;

export type TrialCliDeps = {
  readonly openDb?: (url: string, token: string | undefined) => Client;
  readonly nowMs?: () => number;
  readonly out?: (line: string) => void;
};

const has = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

export async function trialMain(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  deps: TrialCliDeps = {},
): Promise<number> {
  const out = deps.out ?? ((s: string) => console.log(s));
  const nowMs = deps.nowMs ?? Date.now;
  const phase = argv[0];
  if (phase !== "prereg" && phase !== "result") {
    out("arena-committee-trial: refused (say prereg or result)");
    return 0;
  }
  if (REPLAY_FLAGS.some((f) => argv.includes(f))) {
    out(
      "arena-committee-trial: refused (a replay or a recorded-day run; the trial is forward only)",
    );
    return 0;
  }
  const url = env.TURSO_MAIN_URL;
  if (!has(url)) {
    out("arena-committee-trial: degraded (database not configured)");
    return 0;
  }
  let db: Client;
  try {
    const open = deps.openDb ?? ((u, t) => scriptDb({ url: u, token: t }));
    db = open(url, has(env.TURSO_MAIN_TOKEN) ? env.TURSO_MAIN_TOKEN : undefined);
  } catch {
    out("arena-committee-trial: degraded (cannot open database)");
    return 0;
  }
  try {
    const now = new Date(nowMs());
    const today = marketDate(now, HOME_TZ);
    const i = argv.indexOf("--date");
    const d = i >= 0 && has(argv[i + 1]) ? argv[i + 1]! : today;
    if (d !== today) {
      out(`arena-committee-trial ${MARKET} ${d}: refused (not the current session; forward only)`);
      return 0;
    }
    const o = { market: MARKET, d, today, now: now.toISOString() };
    const r = phase === "prereg" ? await ensurePrereg(db, o) : await trialNight(db, o);
    // D-1532: switched off or no trial to run, the step says nothing, as every other opinion stage of the night
    if (r.status === "off" || r.status === "no_trial") return 0;
    const extra =
      "verdict" in r ? ` verdict=${r.verdict}` : "reason" in r ? ` reason=${r.reason}` : "";
    out(`arena-committee-trial ${MARKET} ${d}: ${phase} ${r.status}${extra}`);
    return 0;
  } catch (error) {
    out(
      `arena-committee-trial: degraded (unexpected error ${error instanceof Error ? error.name : "unknown"})`,
    );
    return 0;
  } finally {
    db.close();
  }
}
