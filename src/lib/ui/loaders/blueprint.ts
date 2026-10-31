// Blueprint live status loader (M16 WP4; ARC-002, D-372). Maps architecture-model element ids to a
// plain status read from tables that already exist: run_record (workflows, slots), source_status and
// source_register (data feeds), family_status and angle_passport (Cortex groups). READ-ONLY: every
// statement is a SELECT, nothing is triggered, nothing is fetched. It is called only behind
// requirePinnedOwner (blueprintGuard), which writes the audit event; the loader writes nothing.
// Details are plain words with counts and times only: no money, no data rows, no error text.
import "server-only";
import type { Client } from "@libsql/client";
import { JOBS, isStale } from "@/lib/health/jobs";
import { latestPerJob, type RunRow } from "@/lib/runs/runRecord";
import { WATCHDOG_JOB } from "@/lib/watchdog/state";
import { melbourneStamp } from "./cortex";

export type BlueprintState = "ok" | "warn" | "fail" | "off" | "unknown";
export type ElementStatus = { state: BlueprintState; lastRunAt?: string; detail: string };
export type ModelElement = { id: string; type: string; attrs?: Record<string, unknown> | null };
export type BlueprintModelLike = { elements: readonly ModelElement[] };
export type BlueprintStatus = {
  statuses: Record<string, ElementStatus>;
  /** Page-level line: paper trading only (the standard "Simulated" line). */
  simulatedLine: string;
  /** "Status as of <Melbourne time>" (ARC-002). */
  freshnessLine: string;
  asOf: string;
};
export type BlueprintDeps = { mainDb: Client; now: Date; market?: string };

export const SIMULATED_LINE = "Simulated: paper trading only. No real orders are placed.";
const UNKNOWN: ElementStatus = { state: "unknown", detail: "No live status is kept for this." };

/** Workflow or slot key to the run_record job name, where the two differ. */
const JOB_ALIAS: Record<string, string> = {
  backup: "nightly-backup",
  maintenance: "maintenance-nightly",
  watchdog: WATCHDOG_JOB,
  "watchdog-2040": WATCHDOG_JOB,
  "watchdog-2150": WATCHDOG_JOB,
  "evening-review": "arena-words",
  "evening-review-late": "arena-words",
  universe: "universe-import",
};

const keyOf = (id: string): string => id.slice(id.indexOf(":") + 1);
const when = (iso: string | null): string => melbourneStamp(iso) ?? "an unknown time";

type Latest = { last: RunRow; lastSuccess: RunRow | null };

function runStatus(job: string, l: Latest, now: Date): ElementStatus {
  const at = l.last.endedAt ?? l.last.startedAt;
  const base = { lastRunAt: at };
  const def = JOBS.find((j) => j.job === job);
  switch (l.last.status) {
    case "failed":
      return { ...base, state: "fail", detail: `Last run failed, ${when(at)}.` };
    case "degraded":
      return { ...base, state: "warn", detail: `Last run finished with problems, ${when(at)}.` };
    case "running":
      return { ...base, state: "ok", detail: `Running since ${when(l.last.startedAt)}.` };
    case "skipped":
      return { ...base, state: "ok", detail: `Last run was skipped, ${when(at)}.` };
    default: {
      const stale = isStale(def?.expectedIntervalSec ?? null, l.lastSuccess?.endedAt ?? null, now);
      return stale
        ? { ...base, state: "warn", detail: `Last success ${when(at)}; later than expected.` }
        : { ...base, state: "ok", detail: `Last success ${when(at)}.` };
    }
  }
}

async function runStatuses(
  db: Client,
  els: readonly ModelElement[],
  now: Date,
  out: Record<string, ElementStatus>,
): Promise<void> {
  let byJob: Map<string, Latest>;
  try {
    byJob = new Map((await latestPerJob(db)).map((r) => [r.job, r]));
  } catch {
    return;
  }
  for (const e of els) {
    if (e.type !== "workflow" && e.type !== "slot") continue;
    const key = keyOf(e.id);
    if (e.type === "slot" && e.attrs?.enabled === false) {
      out[e.id] = { state: "off", detail: "This slot is switched off." };
      continue;
    }
    const job = JOB_ALIAS[key] ?? key;
    const l = byJob.get(job);
    out[e.id] = l ? runStatus(job, l, now) : { state: "unknown", detail: "No run recorded yet." };
  }
}

async function sourceStatuses(
  db: Client,
  els: readonly ModelElement[],
  out: Record<string, ElementStatus>,
): Promise<void> {
  let rows: Map<string, { mode: string; reg: string | null; since: string | null }>;
  try {
    const r = await db.execute(
      `SELECT g.source AS source, g.status AS reg, s.mode AS mode, s.since AS since
       FROM source_register g LEFT JOIN source_status s ON s.source = g.source`,
    );
    rows = new Map(
      r.rows.map((x) => [
        String(x.source),
        {
          mode: x.mode === null ? "on" : String(x.mode),
          reg: x.reg === null ? null : String(x.reg),
          since: x.since === null ? null : String(x.since),
        },
      ]),
    );
  } catch {
    return;
  }
  for (const e of els) {
    if (e.type !== "source") continue;
    const s = rows.get(keyOf(e.id));
    if (!s) continue;
    if (s.reg === "pending") {
      out[e.id] = { state: "off", detail: "Waiting for the Owner to accept the source terms." };
    } else if (s.reg === "disabled" || s.mode === "off") {
      out[e.id] = { state: "off", detail: `Feed is off since ${when(s.since)}.` };
    } else if (s.mode === "tripped") {
      out[e.id] = { state: "fail", detail: `Feed stopped by its safety trip, ${when(s.since)}.` };
    } else if (s.mode === "degraded") {
      out[e.id] = { state: "warn", detail: `Feed is degraded since ${when(s.since)}.` };
    } else {
      out[e.id] = { state: "ok", detail: "Feed is on." };
    }
  }
}

async function counts(db: Client, sql: string, args: string[]): Promise<Record<string, number>> {
  const r = await db.execute({ sql, args });
  return Object.fromEntries(r.rows.map((x) => [String(x.k), Number(x.n)]));
}

async function cortexGroups(
  db: Client,
  market: string,
  now: Date,
  out: Record<string, ElementStatus>,
): Promise<void> {
  try {
    const fam = await counts(
      db,
      `SELECT s.status AS k, COUNT(*) AS n FROM family_status s
       WHERE s.market = ? AND s.since_d = (SELECT MAX(x.since_d) FROM family_status x
         WHERE x.market = s.market AND x.family = s.family AND x.since_d <= ?)
       GROUP BY s.status`,
      [market, now.toISOString().slice(0, 10)],
    );
    const known = Object.values(fam).reduce((a, b) => a + b, 0);
    const suspended = fam.suspended ?? 0;
    out["group:cortex-states"] =
      known === 0
        ? { state: "ok", detail: "No family has a status row yet; all run in shadow." }
        : {
            state: suspended > 0 ? "warn" : "ok",
            detail: `${fam.allowed ?? 0} allowed, ${suspended} suspended, ${fam.shadow ?? 0} in shadow of ${known} with a status row.`,
          };
  } catch {
    /* stays unknown */
  }
  try {
    const p = await counts(
      db,
      `SELECT p.status AS k, COUNT(*) AS n FROM angle_passport p
       WHERE p.market = ? AND p.version = (SELECT MAX(q.version) FROM angle_passport q
         WHERE q.market = p.market AND q.angle_id = p.angle_id)
       GROUP BY p.status`,
      [market],
    );
    const total = Object.values(p).reduce((a, b) => a + b, 0);
    if (total === 0) {
      out["group:cortex-angles"] = { state: "unknown", detail: "No passports loaded yet." };
    } else {
      const active = p.active ?? 0;
      out["group:cortex-angles"] = {
        state: active > 0 ? "ok" : "warn",
        detail: `${total} passports: ${active} active, ${p.watch ?? 0} on watch, ${p.candidate ?? 0} candidate, ${p.measured ?? 0} measured, ${p.retired ?? 0} retired.`,
      };
    }
  } catch {
    /* stays unknown */
  }
}

export async function loadBlueprintStatus(
  deps: BlueprintDeps,
  model: BlueprintModelLike,
): Promise<BlueprintStatus> {
  const { mainDb, now } = deps;
  const out: Record<string, ElementStatus> = {};
  await runStatuses(mainDb, model.elements, now, out);
  await sourceStatuses(mainDb, model.elements, out);
  await cortexGroups(mainDb, deps.market ?? "AU", now, out);
  // Tables: a row-count freshness check is not cheap on every table, so they stay unknown.
  const statuses: Record<string, ElementStatus> = {};
  for (const e of model.elements) statuses[e.id] = out[e.id] ?? UNKNOWN;
  const asOf = now.toISOString();
  return {
    statuses,
    simulatedLine: SIMULATED_LINE,
    freshnessLine: `Status as of ${melbourneStamp(asOf) ?? asOf}`,
    asOf,
  };
}
