// Control Room extras (UXN-283, UXN-285; docs/M7_design.md 3 row 26; T10 draft). Wraps `loadHealth`
// (the nine components, the 30-day strip, the role split) and adds what the page needs beside it:
// free-tier gauges (Owner only), the event ticker (state changes between stored daily snapshots),
// the A1-A8 panel (last run per agent job) and the check time. Everything comes from stored health
// facts (PLT-061): no extra job, no extra quota. Bounded reads per refresh: the health facts, one
// snapshot query (<= 31 rows), the meters and one run-record read (design 2.9, decision 24).
import { latestPerJob } from "@/lib/runs/runRecord";
import { getMeters, usageEnvironment, type Meter } from "@/lib/usage/meters";
import { HEALTH_COMPONENTS } from "@/lib/sentinel/schema";
import { loadHealth, type HealthModel } from "./health";
import type { LoaderEnv } from "./shell";

export const TIMELINE_EVENTS = 20; // threshold-ok: UXN-285 e, last 20 health events
const SNAPSHOT_ROWS = 31; // threshold-ok: 30 days of changes need 31 snapshots
export const GAUGE_MARKS = [70, 90, 95] as const; // threshold-ok: PLT-051 marks

export type GaugeView = {
  id: string;
  label: string;
  /** 0..100, or null when the meter has no data. */
  percent: number | null;
  level: Meter["level"];
  periodLabel: string;
};
export type TimelineEvent = { d: string; component: string; from: string; to: string };
export type AgentRow = {
  id: string;
  name: string;
  when: string;
  /** The run-record job whose last run stands for this agent, null = not tracked as its own job. */
  job: string | null;
  status: "ok" | "failed" | "running" | "degraded" | "skipped" | "no run yet" | "not tracked";
  lastAt: string | null;
  outputs: number | null;
};
export type ControlRoomModel = {
  health: HealthModel;
  checkedAt: string;
  /** Owner only (usage numbers, decision 23); null for everyone else. */
  gauges: GaugeView[] | null;
  timeline: TimelineEvent[];
  agents: AgentRow[];
};

const AGENTS: ReadonlyArray<Pick<AgentRow, "id" | "name" | "when" | "job">> = [
  { id: "A1", name: "Sentinel", when: "Every minute", job: "worker-heartbeat" },
  { id: "A2", name: "Company and sector research", when: "Batch 2 (18:10)", job: "arena-signals" },
  { id: "A3", name: "Macro and regime", when: "Batch 2", job: "arena-signals" },
  { id: "A4", name: "Candle and pattern", when: "Batch 2", job: "arena-signals" },
  { id: "A5", name: "Strategy lab", when: "Batch 2, after the books close", job: "arena-signals" },
  { id: "A6", name: "Daily review and learning", when: "Batch 3 (18:40)", job: "arena-review" },
  { id: "A7", name: "Critic", when: "19:10", job: "arena-review" },
  { id: "A8", name: "Scribe", when: "19:10 to 19:45", job: null },
];

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const KNOWN = new Set<string>(HEALTH_COMPONENTS);

/** component id -> state of one stored snapshot; unreadable snapshots give an empty map. */
function snapshotStates(json: unknown): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const v: unknown = JSON.parse(String(json));
    if (!isObj(v) || !Array.isArray(v.components)) return out;
    for (const c of v.components) {
      if (isObj(c) && typeof c.id === "string" && KNOWN.has(c.id) && typeof c.state === "string") {
        out.set(c.id, c.state);
      }
    }
  } catch {
    /* unreadable snapshot: no events from it */
  }
  return out;
}

/** Pure: state changes between consecutive daily snapshots, newest first, at most 20. */
export function timelineFrom(
  rows: ReadonlyArray<{ d: string; components_json: unknown }>,
): TimelineEvent[] {
  const asc = [...rows].sort((a, b) => a.d.localeCompare(b.d));
  const events: TimelineEvent[] = [];
  let prev: Map<string, string> | null = null;
  for (const r of asc) {
    const cur = snapshotStates(r.components_json);
    if (prev !== null) {
      for (const id of HEALTH_COMPONENTS) {
        const a = prev.get(id);
        const b = cur.get(id);
        if (a !== undefined && b !== undefined && a !== b) {
          events.push({ d: r.d, component: id, from: a, to: b });
        }
      }
    }
    prev = cur;
  }
  return events.reverse().slice(0, TIMELINE_EVENTS);
}

async function loadTimeline(env: LoaderEnv): Promise<TimelineEvent[]> {
  try {
    const r = await env.main.execute({
      sql: `SELECT d, components_json FROM health_snapshot WHERE purpose = 'reminder'
            ORDER BY d DESC LIMIT ?`,
      args: [SNAPSHOT_ROWS],
    });
    return timelineFrom(
      r.rows.map((x) => ({ d: String(x.d), components_json: x.components_json })),
    );
  } catch {
    return [];
  }
}

async function loadAgents(env: LoaderEnv): Promise<AgentRow[]> {
  let byJob = new Map<string, Awaited<ReturnType<typeof latestPerJob>>[number]>();
  try {
    byJob = new Map((await latestPerJob(env.main)).map((x) => [x.job, x]));
  } catch {
    byJob = new Map();
  }
  return AGENTS.map((a) => {
    if (a.job === null) {
      return { ...a, status: "not tracked", lastAt: null, outputs: null };
    }
    const run = byJob.get(a.job)?.last;
    if (!run) return { ...a, status: "no run yet", lastAt: null, outputs: null };
    return {
      ...a,
      status: run.status === "success" ? "ok" : run.status,
      lastAt: run.endedAt ?? run.startedAt,
      outputs: run.itemsProcessed,
    };
  });
}

async function loadGauges(
  env: LoaderEnv,
  vars: Record<string, string | undefined>,
): Promise<GaugeView[] | null> {
  if (env.user.role !== "owner") return null;
  try {
    const meters = await getMeters(env.main, env.now, usageEnvironment(vars));
    return meters.map((m) => ({
      id: m.id,
      label: m.label,
      percent: m.ratio === null ? null : Math.round(m.ratio * 1000) / 10, // money-float-ok: display percent
      level: m.level,
      periodLabel: m.periodLabel,
    }));
  } catch {
    return [];
  }
}

export async function loadControlRoom(
  env: LoaderEnv,
  vars: Record<string, string | undefined> = process.env,
): Promise<ControlRoomModel> {
  const health = await loadHealth(env, vars);
  const [gauges, timeline, agents] = await Promise.all([
    loadGauges(env, vars),
    loadTimeline(env),
    loadAgents(env),
  ]);
  return { health, checkedAt: env.now.toISOString(), gauges, timeline, agents };
}
