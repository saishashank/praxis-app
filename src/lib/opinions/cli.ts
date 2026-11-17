// Entry of the nightly opinion-meter step (M22 C4; AGT-148; D-1428, D-1520). Task L4 (or Z) starts it from the nightly job
// through its own bundle; this file edits no workflow. It reads the meters and writes the one promotion request a kind can
// ever earn (plus its warning line); it prints counts only and always exits 0 (a failure never fails the night).
//
//   opinions [--date YYYY-MM-DD]
//
// Refuses a replay flag. env: TURSO_MAIN_URL, TURSO_MAIN_TOKEN.
import type { Client } from "@libsql/client";
import { scriptDb } from "@/lib/db/scriptClient.mjs";
import { marketDate } from "@/lib/data/calendar";
import { HOME_MARKET, HOME_TZ } from "@/lib/market/homeMarket.mjs";
import { runPromotion } from "./promotion";

const MARKET: string = HOME_MARKET;
const REPLAY_FLAGS = ["--replay", "--recorded", "--recorded-day"] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type OpinionMetersDeps = {
  readonly openDb?: (url: string, token: string | undefined) => Client;
  readonly nowMs?: () => number;
  readonly out?: (line: string) => void;
};

const has = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

export async function opinionMetersMain(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  deps: OpinionMetersDeps = {},
): Promise<number> {
  const out = deps.out ?? ((s: string) => console.log(s));
  const nowMs = deps.nowMs ?? Date.now;
  if (REPLAY_FLAGS.some((f) => argv.includes(f))) {
    out("opinions: refused (a replay or recorded-day run)");
    return 0;
  }
  const url = env.TURSO_MAIN_URL;
  if (!has(url)) {
    out("opinions: degraded (database not configured)");
    return 0;
  }
  let db: Client;
  try {
    const open = deps.openDb ?? ((u, t) => scriptDb({ url: u, token: t }));
    db = open(url, has(env.TURSO_MAIN_TOKEN) ? env.TURSO_MAIN_TOKEN : undefined);
  } catch {
    out("opinions: degraded (cannot open database)");
    return 0;
  }
  try {
    const i = argv.indexOf("--date");
    const given = i >= 0 ? argv[i + 1] : undefined;
    const d = has(given) && DATE_RE.test(given) ? given : marketDate(new Date(nowMs()), HOME_TZ);
    const r = await runPromotion(db, { market: MARKET, d, now: new Date(nowMs()).toISOString() });
    const parts = r.meters.map((m) => `${m.kind}=${m.settled}/${m.needed}`).join(" ");
    out(`opinions ${MARKET} ${d}: ${parts} requested=${r.requested.length}`);
    return 0;
  } catch (error) {
    out(`opinions: degraded (unexpected error ${error instanceof Error ? error.name : "unknown"})`);
    return 0;
  } finally {
    db.close();
  }
}
