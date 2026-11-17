// Command-line entry of the experts job (M22 E2; KB-082, KB-083, D-1429). Started by .github/workflows/maintenance.yml
// (the `experts` job, through scripts/experts/run.mjs) on the maintenance dispatch; no Worker slot is added.
//
//   experts [--date YYYY-MM-DD] [--phase all|licence|poll|discovery|extract]
//
// `all` runs, in this order and each in its own guard: the monthly licence check (first run of the calendar month), the daily
// poll, the weekly discovery (Sundays, Melbourne) and the extraction of what was polled. Each phase writes its own
// `expert_poll_run` row where it has one, so a second run on the same day does nothing twice. A phase that throws says so in
// one line and the exit code is 1 after the remaining phases have run; a missing database is a calm "degraded" line and
// exit 0 (nothing to do). Output: counts and statuses only, never a name, a handle or a URL.
// env: TURSO_MAIN_URL, TURSO_MAIN_TOKEN, and, for a live model, the keys of the experts job (D-1412).
import { lookup } from "node:dns/promises";
import type { Client } from "@libsql/client";
import { scriptDb } from "@/lib/db/scriptClient.mjs";
import { loadAgentParams } from "@/lib/agents/params";
import { getConfig } from "@/lib/config/store";
import { marketDate } from "@/lib/data/calendar";
import { runMonthlyLicence } from "@/lib/experts/licence/check";
import { HOME_TZ } from "@/lib/market/homeMarket.mjs";
import { loadNightLlm, type NightLlm } from "@/lib/llm/nightlyLlm";
import { runDiscovery } from "./discovery";
import { runExtraction } from "./extract";
import { runPoll } from "./job";
import type { RawFetch } from "./guard";
import { pollFactsOf, trackedExperts } from "./store";
import { pollOrder } from "./priority";

const PHASES = ["all", "licence", "poll", "discovery", "extract"];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SUNDAY = 0; // threshold-ok: Date.getUTCDay of Sunday
const has = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

export type ExpertsCliDeps = {
  readonly openDb?: (url: string, token: string | undefined) => Client;
  readonly nowMs?: () => number;
  readonly out?: (line: string) => void;
  /** The platform fetch (tests pass fixtures; nothing here reaches the network on its own). */
  readonly fetch?: RawFetch;
  readonly resolve?: (host: string) => Promise<readonly string[]>;
  readonly sleep?: (ms: number) => Promise<void>;
  /** The night's routers; default: the factory's (rules-only unless a role is live). */
  readonly llm?: (ctx: {
    db: Client;
    params: Awaited<ReturnType<typeof loadAgentParams>>;
    kbVersion: string;
  }) => Promise<NightLlm>;
};

const flag = (args: readonly string[], name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 && has(args[i + 1]) ? args[i + 1]! : null;
};

const dnsResolve = async (host: string): Promise<readonly string[]> =>
  (await lookup(host, { all: true })).map((a) => a.address);

export async function expertsMain(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  deps: ExpertsCliDeps = {},
): Promise<number> {
  const out = deps.out ?? ((s: string) => console.log(s));
  const nowMs = deps.nowMs ?? Date.now;
  const phase = flag(argv, "--phase") ?? "all";
  if (!PHASES.includes(phase)) {
    out("experts: refused (unknown phase)");
    return 2;
  }
  const url = env.TURSO_MAIN_URL;
  if (!has(url)) {
    out("experts: degraded (database not configured)");
    return 0;
  }
  let db: Client;
  try {
    const open = deps.openDb ?? ((u, t) => scriptDb({ url: u, token: t }));
    db = open(url, has(env.TURSO_MAIN_TOKEN) ? env.TURSO_MAIN_TOKEN : undefined);
  } catch {
    out("experts: degraded (cannot open database)");
    return 0;
  }
  const now = () => new Date(nowMs());
  const fetchImpl: RawFetch = deps.fetch ?? ((u, init) => fetch(u, init));
  const given = flag(argv, "--date");
  const day = given !== null && DAY.test(given) ? given : marketDate(now(), HOME_TZ);
  let failed = false;
  const step = async (name: string, run: () => Promise<string>): Promise<void> => {
    try {
      out(`experts ${name} ${day}: ${await run()}`);
    } catch (error) {
      failed = true;
      out(`experts ${name} ${day}: failed (${error instanceof Error ? error.name : "unknown"})`);
    }
  };
  try {
    if (phase === "all" || phase === "licence") {
      await step("licence", async () => {
        const r = await runMonthlyLicence(db, { fetch: fetchImpl, now, sleep: deps.sleep, day });
        return r === null
          ? "already done this month"
          : `checked=${r.checked} enabled=${r.enabled} accepted=${r.acceptedRisk} no=${r.no} unreachable=${r.unreachable} capped=${r.capped}`;
      });
    }
    if (phase === "all" || phase === "poll") {
      await step("poll", async () => {
        const r = await runPoll(db, {
          fetch: fetchImpl,
          resolve: deps.resolve ?? dnsResolve,
          sleep: deps.sleep,
          now,
          day,
        });
        return r.skipped !== null
          ? `skipped (${r.skipped})`
          : `experts=${r.experts} sources=${r.sources} requested=${r.requested} new=${r.newItems} seen=${r.seenItems} not_modified=${r.notModified} disallowed=${r.disallowed} failed=${r.failed} capped=${r.capped} refused=${r.refused} not_allowed=${r.notAllowed}`;
      });
    }
    const sunday = new Date(`${day}T12:00:00.000Z`).getUTCDay() === SUNDAY;
    if (phase === "discovery" || (phase === "all" && sunday)) {
      await step("discovery", async () => {
        const r = await runDiscovery(db, { now, day });
        return r.skipped === "already_ran"
          ? "skipped (already_ran)"
          : `considered=${r.considered} added=${r.added} known=${r.known}${r.skipped === "full" ? " (candidate list full)" : ""}`;
      });
    }
    if (phase === "all" || phase === "extract") {
      await step("extract", async () => {
        const params = await loadAgentParams(db);
        const kbVersion = params.llm.injectionPhrasesVersion;
        const night = await (deps.llm
          ? deps.llm({ db, params, kbVersion })
          : loadNightLlm({ db, params, kbVersion }));
        const experts = await trackedExperts(db);
        const order = pollOrder(
          await pollFactsOf(db, experts),
          day,
          Number(await getConfig(db, "expert_min_scored")),
        );
        const byId = new Map(experts.map((e) => [e.id, e]));
        const ordered = [
          ...order.map((id) => byId.get(id)!),
          ...experts.filter((e) => !order.includes(e.id)),
        ];
        const cap = Number(await getConfig(db, "expert_extract_daily"));
        const r = await runExtraction(db, ordered, cap, { night, params, day, now });
        return !r.ran
          ? "no model switched on, items wait"
          : `looked=${r.looked} relevant=${r.relevant} claims=${r.claims}${r.stopped === null ? "" : ` stopped=${r.stopped}`}`;
      });
    }
    return failed ? 1 : 0;
  } finally {
    db.close();
  }
}
