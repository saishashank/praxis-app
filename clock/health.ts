// Health of the clock (INFRA T3; REQ\infra\INFRA_REQUIREMENT.md §5.4). `GET :9100/health` returns the last tick
// time, the clock owner as last read, the running jobs and the last error. Only fixed words, ids, times and
// counts: no secret, URL, host or upstream text. Caddy may expose it at /clock-health behind HMAC.
import { createServer, type Server } from "node:http";
import type { RunningInfo } from "./runner/local";

export const STALE_AFTER_MS = 180_000;
export const STARTUP_GRACE_MS = 120_000;

export type HealthState = {
  startedAtMs: number;
  /** `CLOCK_ENABLED=0` keeps the clock from reading anything (maintenance); it still serves health. */
  enabled: boolean;
  runtime: "cloud" | "selfhost";
  lastTickMs: number | null;
  /** The owner as last read from `worker_state.clock_owner`; null = not read yet or unreadable. */
  owner: "cloud" | "selfhost" | null;
  lastError: { atMs: number; what: string } | null;
  build: string;
  selfCheck: { atMs: number; passed: number; total: number; failed: string[] } | null;
};

export function newHealthState(init: {
  nowMs: number;
  enabled: boolean;
  runtime: "cloud" | "selfhost";
  build?: string;
}): HealthState {
  return {
    startedAtMs: init.nowMs,
    enabled: init.enabled,
    runtime: init.runtime,
    lastTickMs: null,
    owner: null,
    lastError: null,
    build: (init.build ?? "").slice(0, 12),
    selfCheck: null,
  };
}

/** Records a problem as a fixed short word (never a message from an exception). */
export function noteError(s: HealthState, nowMs: number, what: string): void {
  s.lastError = { atMs: nowMs, what: what.slice(0, 60) };
}

export type RunnerView = { running(): RunningInfo[]; queued(): { job: string }[] };

export type HealthBody = {
  ok: boolean;
  runtime: string;
  enabled: boolean;
  owner: string | null;
  lastTick: string | null;
  lastTickAgeS: number | null;
  running: RunningInfo[];
  queued: number;
  lastError: { at: string; what: string } | null;
  selfCheck: { at: string; passed: number; total: number; failed: string[] } | null;
  build: string;
  uptimeS: number;
};

export function healthBody(s: HealthState, r: RunnerView, nowMs: number): HealthBody {
  const age = s.lastTickMs === null ? null : Math.max(0, Math.round((nowMs - s.lastTickMs) / 1000));
  // A clock that should be ticking but has not for 3 minutes (after a start-up grace) is not healthy.
  const stale =
    s.enabled &&
    nowMs - s.startedAtMs > STARTUP_GRACE_MS &&
    (s.lastTickMs === null || nowMs - s.lastTickMs > STALE_AFTER_MS);
  return {
    ok: !stale,
    runtime: s.runtime,
    enabled: s.enabled,
    owner: s.owner,
    lastTick: s.lastTickMs === null ? null : new Date(s.lastTickMs).toISOString(),
    lastTickAgeS: age,
    running: r.running(),
    queued: r.queued().length,
    lastError: s.lastError
      ? { at: new Date(s.lastError.atMs).toISOString(), what: s.lastError.what }
      : null,
    selfCheck: s.selfCheck
      ? {
          at: new Date(s.selfCheck.atMs).toISOString(),
          passed: s.selfCheck.passed,
          total: s.selfCheck.total,
          failed: s.selfCheck.failed,
        }
      : null,
    build: s.build,
    uptimeS: Math.round((nowMs - s.startedAtMs) / 1000),
  };
}

/** Serves GET /health (200, or 503 when the tick is stale); everything else is 404. */
export function startHealthServer(
  port: number,
  state: HealthState,
  runner: RunnerView,
  nowMs: () => number = Date.now,
  host = "0.0.0.0",
): Promise<Server> {
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method !== "GET" || path !== "/health") {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
      return;
    }
    const body = healthBody(state, runner, nowMs());
    res
      .writeHead(body.ok ? 200 : 503, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      })
      .end(JSON.stringify(body));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}
