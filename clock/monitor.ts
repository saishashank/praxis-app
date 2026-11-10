// Monitoring inside praxis-clock (INFRA T6; REQ\infra\INFRA_REQUIREMENT.md §8.3, §9 idle reclamation, §12 R3/R9).
// No node-exporter: everything is read from the container itself (fs.statfs, /proc), at most one database
// write per hour in normal times. All mail goes to the Owner only (notify.ts) and carries fixed words and
// numbers: no path, URL, host or secret.
//
//  1. Dead-man ping: GET `DEADMAN_PING_URL` every 2 minutes, ONLY while the clock's own tick is healthy (last
//     tick < 3 min old). It runs on the owner AND on the standby clock: the alarm is about the server being
//     alive, not about who owns the data. The external service (healthchecks.io style) is set by the Owner to
//     email after 10 minutes of silence ("period 2 min, grace 10 min"). Worst case from kill to email:
//     last ping <= 2 min before the kill + 10 min grace = 12 min, inside the 15 min acceptance of T6. (A 5 min
//     ping with a 15 min grace would be 20 min worst case, so the cadence is tighter than the §8.3 text.)
//     Success pings only; a failed GET is swallowed and logged without the URL.
//  2. Host checks every 5 minutes: disk use of the data volume path(s) > 80 %, memory available < 10 %
//     (/proc/meminfo, skipped where it does not exist), restarts (> 3 clock starts in 1 hour, counted from
//     `worker_state` key `clock_starts:<runtime>`, one upsert at start-up). One email per condition per 6 h
//     while it persists, one recovery email when it clears; the state is kept in the same row so a restart
//     loop cannot turn into a mail loop.
//  3. Idle trend (Oracle reclamation, §9): CPU (/proc/stat deltas), memory used % and network (/proc/net/dev,
//     all interfaces except lo, as a % of `IDLE_NET_REF_MBPS`, default 10) are sampled every 5 minutes and
//     folded into HOURLY MEANS, kept for 8 days in `worker_state` key `host_trend:<runtime>` (one upsert per
//     hour, no new table). Every Sunday from 09:00 Sydney the 95th percentile of the 7-day hourly means is
//     computed (hourly means are slightly smoother than Oracle's own series, so the warning errs early) and
//     the Owner is emailed if CPU, memory AND network are all below 25 % (early warning before Oracle's 20 %).
//     THIS CODE NEVER GENERATES SYNTHETIC LOAD: the requirement forbids dodging the rule (it could get the
//     account closed); the answer to reclamation is to move (§15), not to prevent it.
//     Network caveat: inside a container /proc/net/dev is the container's own namespace; `HOST_NET_DEV_PATH`
//     can point at a bind-mounted host file. Unreadable files give null, never a made-up number.
import { readFileSync, promises as fsp } from "node:fs";
import { sydneyLocal } from "../worker/src/localtime";
import type { HealthState } from "./health";
import type { LeaseDb } from "./lease";
import type { AlertInfo } from "./notify";

export const DEADMAN_EVERY_MS = 120_000;
/** What the Owner sets at the external service (documented in docs/SELFHOST.md): 2 min period, 10 min grace. */
export const DEADMAN_EXTERNAL_GRACE_MIN = 10;
export const DEADMAN_MAX_TICK_AGE_MS = 180_000;
export const HOST_EVERY_MS = 300_000;
export const DEBOUNCE_MS = 6 * 3_600_000;
export const DISK_MAX_PCT = 80;
export const MEM_AVAILABLE_MIN_PCT = 10;
export const RESTARTS_MAX_PER_HOUR = 3;
export const HOUR_MS = 3_600_000;
export const TREND_KEEP_HOURS = 8 * 24;
export const WEEK_MS = 7 * 24 * HOUR_MS;
export const IDLE_WARN_PCT = 25;
/** The weekly figure needs at least 5 days of hourly means, else it is skipped (a fresh install). */
export const MIN_TREND_HOURS = 5 * 24;
export const WEEKLY_MINUTE = 9 * 60; // Sunday 09:00 Sydney

export const startsKey = (runtime: string): string => `clock_starts:${runtime}`;
export const trendKey = (runtime: string): string => `host_trend:${runtime}`;

type AlertState = { active: boolean; lastSentMs: number };
type StartsRow = { starts: number[]; alerts: Record<string, AlertState> };
/** [hourStartMs, cpu%, memUsed%, net%] hourly means; a metric that could not be read is null. */
export type HourRow = [number, number | null, number | null, number | null];
type TrendRow = { v: 1; hours: HourRow[]; lastWeekly: string | null };

export type HostView = {
  at: string;
  cpuPct: number | null;
  memUsedPct: number | null;
  memAvailablePct: number | null;
  netPct: number | null;
  diskMaxPct: number | null;
  restartsLastHour: number;
  trend: {
    hours: number;
    p95CpuPct: number | null;
    p95MemPct: number | null;
    p95NetPct: number | null;
    lastWeekly: string | null;
  };
};

export type StatfsLike = { bsize: number; blocks: number; bfree: number; bavail: number };

export type MonitorDeps = {
  env: Readonly<Record<string, string | undefined>>;
  runtime: string;
  health: HealthState;
  db: LeaseDb;
  nowMs: () => number;
  fetch: typeof fetch;
  log: (line: string) => void;
  notify: (a: AlertInfo) => Promise<unknown>;
  /** Tests: file reader (null = missing). */
  readText?: (path: string) => string | null;
  /** Tests: statfs (null = path missing). */
  statfs?: (path: string) => Promise<StatfsLike | null>;
};

export type Monitor = {
  /** Start-up: one read and one upsert (`clock_starts`), warnings, restart check. Never throws. */
  init(): Promise<void>;
  /** Called every 30 s by main.ts; does its own scheduling. Never throws. */
  step(ms?: number): Promise<void>;
  /** Starts in the last hour (from the persisted list). */
  restartsLastHour(ms?: number): number;
  pingEnabled: boolean;
};

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Nearest-rank 95th percentile; null for an empty list. Pure. */
export function p95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]!;
}

/** Busy and total jiffies of the first `cpu` line of /proc/stat, or null. Pure. */
export function parseProcStat(text: string | null): { busy: number; total: number } | null {
  const line = text?.split("\n").find((l) => /^cpu\s/.test(l));
  if (!line) return null;
  const f = line.trim().split(/\s+/).slice(1).map(Number);
  if (f.length < 5 || f.some((x) => !Number.isFinite(x))) return null;
  const total = f.slice(0, 8).reduce((a, b) => a + b, 0);
  const idle = (f[3] ?? 0) + (f[4] ?? 0); // idle + iowait
  return { busy: total - idle, total };
}

/** { total, available } in kB from /proc/meminfo, or null. Pure. */
export function parseMeminfo(text: string | null): { total: number; available: number } | null {
  if (!text) return null;
  const total = /^MemTotal:\s+(\d+)/m.exec(text)?.[1];
  const avail = /^MemAvailable:\s+(\d+)/m.exec(text)?.[1];
  if (!total || !avail || Number(total) <= 0) return null;
  return { total: Number(total), available: Number(avail) };
}

/** Sum of received + transmitted bytes of every interface except `lo`, or null. Pure. */
export function parseNetDev(text: string | null): number | null {
  if (!text) return null;
  let sum = 0;
  let seen = false;
  for (const l of text.split("\n")) {
    const m = /^\s*([^:\s]+):\s*(.*)$/.exec(l);
    if (!m || m[1] === "lo") continue;
    const f = m[2]!.trim().split(/\s+/).map(Number);
    if (f.length < 9 || !Number.isFinite(f[0]!) || !Number.isFinite(f[8]!)) continue;
    sum += f[0]! + f[8]!;
    seen = true;
  }
  return seen ? sum : null;
}

/** Disk use in percent like `df` (used / (used + available)). Pure. */
export function diskUsedPct(s: StatfsLike): number | null {
  const used = s.blocks - s.bfree;
  const denom = used + s.bavail;
  return denom > 0 ? (used / denom) * 100 : null;
}

const defaultRead = (p: string): string | null => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
};
const defaultStatfs = async (p: string): Promise<StatfsLike | null> => {
  try {
    const s = await fsp.statfs(p);
    return {
      bsize: Number(s.bsize),
      blocks: Number(s.blocks),
      bfree: Number(s.bfree),
      bavail: Number(s.bavail),
    };
  } catch {
    return null;
  }
};

export function createMonitor(d: MonitorDeps): Monitor {
  const env = d.env;
  const read = d.readText ?? defaultRead;
  const statfs = d.statfs ?? defaultStatfs;
  const pingUrl = (env.DEADMAN_PING_URL ?? "").trim();
  const pingEnabled = /^https?:\/\/\S+$/.test(pingUrl);
  const netRefMbps = Number(env.IDLE_NET_REF_MBPS) > 0 ? Number(env.IDLE_NET_REF_MBPS) : 10;
  const diskPaths = (env.MONITOR_DISK_PATHS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (diskPaths.length === 0) diskPaths.push((env.JOBS_ROOT ?? "").trim() || "/srv/praxis/jobs");
  const netPath = (env.HOST_NET_DEV_PATH ?? "").trim() || "/proc/net/dev";

  let row: StartsRow = { starts: [], alerts: {} };
  let trend: TrendRow = { v: 1, hours: [], lastWeekly: null };
  let lastPing: number | null = null;
  let lastHost: number | null = null;
  let running = false;
  let prevCpu: { busy: number; total: number } | null = null;
  let prevNet: { bytes: number; ms: number } | null = null;
  // the hour being filled: sums and counts per metric
  let cur: { hour: number; sum: [number, number, number]; n: [number, number, number] } | null =
    null;

  const upsert = async (key: string, value: unknown, ms: number): Promise<void> => {
    const at = new Date(ms).toISOString();
    await d.db([
      {
        sql:
          "INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
        args: [key, JSON.stringify(value), at],
      },
    ]);
  };
  const save = async (which: "starts" | "trend", ms: number): Promise<void> => {
    try {
      if (which === "starts") await upsert(startsKey(d.runtime), row, ms);
      else await upsert(trendKey(d.runtime), trend, ms);
    } catch {
      d.log("monitor: state not saved (database unreachable)");
    }
  };

  const restartsLastHour = (ms: number = d.nowMs()): number =>
    row.starts.filter((t) => ms - t < HOUR_MS).length;

  /** Debounced alert with one recovery mail. Returns true when the persisted state changed. */
  async function evaluate(
    key: string,
    bad: boolean,
    ms: number,
    mail: { subject: string; text: string },
    recovered: { subject: string; text: string },
  ): Promise<boolean> {
    const st = row.alerts[key] ?? { active: false, lastSentMs: 0 };
    let changed = false;
    if (bad) {
      if (!st.active || ms - st.lastSentMs >= DEBOUNCE_MS) {
        await d.notify({ key, ...mail }).catch(() => undefined);
        row.alerts[key] = { active: true, lastSentMs: ms };
        changed = true;
      }
    } else if (st.active) {
      await d.notify({ key: `${key}-ok`, ...recovered }).catch(() => undefined);
      row.alerts[key] = { active: false, lastSentMs: ms };
      changed = true;
    }
    return changed;
  }

  async function checkRestarts(ms: number): Promise<boolean> {
    const n = restartsLastHour(ms);
    return evaluate(
      "restarts",
      n > RESTARTS_MAX_PER_HOUR,
      ms,
      {
        subject: "The clock keeps restarting",
        text: `praxis-clock started ${n} times in the last hour (limit ${RESTARTS_MAX_PER_HOUR}). Look at: docker logs praxis-clock`,
      },
      {
        subject: "The clock restarts have stopped",
        text: `praxis-clock has started ${n} time(s) in the last hour (limit ${RESTARTS_MAX_PER_HOUR}).`,
      },
    );
  }

  async function init(): Promise<void> {
    const ms = d.nowMs();
    if (!pingEnabled) {
      d.log(
        pingUrl === ""
          ? "monitor: DEADMAN_PING_URL is empty, the external dead-man ping is DISABLED"
          : "monitor: DEADMAN_PING_URL is not an http(s) URL, the external dead-man ping is DISABLED",
      );
    }
    try {
      const res = await d.db([
        { sql: "SELECT value_json FROM worker_state WHERE key = ?", args: [startsKey(d.runtime)] },
        { sql: "SELECT value_json FROM worker_state WHERE key = ?", args: [trendKey(d.runtime)] },
      ]);
      const a = res[0]?.rows[0]?.[0];
      const b = res[1]?.rows[0]?.[0];
      if (a !== undefined && a !== null) {
        const p = JSON.parse(String(a)) as Partial<StartsRow>;
        row = {
          starts: Array.isArray(p.starts) ? p.starts.filter((x) => typeof x === "number") : [],
          alerts: p.alerts && typeof p.alerts === "object" ? p.alerts : {},
        };
      }
      if (b !== undefined && b !== null) {
        const t = JSON.parse(String(b)) as Partial<TrendRow>;
        trend = {
          v: 1,
          hours: Array.isArray(t.hours) ? t.hours.slice(-TREND_KEEP_HOURS) : [],
          lastWeekly: typeof t.lastWeekly === "string" ? t.lastWeekly : null,
        };
      }
    } catch {
      d.log("monitor: saved state not readable, starting empty");
    }
    row.starts = [...row.starts.filter((t) => ms - t < 24 * HOUR_MS), ms];
    await checkRestarts(ms);
    await save("starts", ms); // the single start-up upsert
  }

  async function maybePing(ms: number): Promise<void> {
    if (!pingEnabled) return;
    if (lastPing !== null && ms - lastPing < DEADMAN_EVERY_MS) return;
    const tick = d.health.lastTickMs;
    if (tick === null || ms - tick >= DEADMAN_MAX_TICK_AGE_MS) return; // unhealthy: stay silent, the alarm is the silence
    lastPing = ms;
    try {
      await d.fetch(pingUrl, { method: "GET", signal: AbortSignal.timeout(10_000) });
    } catch {
      d.log("monitor: dead-man ping failed");
    }
  }

  const addSample = (ms: number, cpu: number | null, mem: number | null, net: number | null) => {
    const hour = Math.floor(ms / HOUR_MS) * HOUR_MS;
    if (cur === null) cur = { hour, sum: [0, 0, 0], n: [0, 0, 0] };
    const vals = [cpu, mem, net];
    for (let i = 0; i < 3; i++) {
      const v = vals[i];
      if (v !== null && v !== undefined) {
        cur.sum[i]! += v;
        cur.n[i]! += 1;
      }
    }
  };
  const closeHour = (): HourRow | null => {
    if (cur === null) return null;
    const m = (i: number): number | null =>
      cur!.n[i]! > 0 ? round1(cur!.sum[i]! / cur!.n[i]!) : null;
    const r: HourRow = [cur.hour, m(0), m(1), m(2)];
    cur = null;
    return r;
  };

  const trendNumbers = (ms: number) => {
    const recent = trend.hours.filter((h) => ms - h[0] <= WEEK_MS);
    const col = (i: 1 | 2 | 3): number | null =>
      p95(recent.map((h) => h[i]).filter((v): v is number => v !== null));
    return { hours: recent.length, cpu: col(1), mem: col(2), net: col(3) };
  };

  async function weekly(ms: number): Promise<void> {
    const local = sydneyLocal(ms);
    if (local.dow !== 0 || local.minute < WEEKLY_MINUTE || trend.lastWeekly === local.date) return;
    trend.lastWeekly = local.date;
    const t = trendNumbers(ms);
    if (t.hours >= MIN_TREND_HOURS && t.cpu !== null && t.mem !== null && t.net !== null) {
      const idle = t.cpu < IDLE_WARN_PCT && t.mem < IDLE_WARN_PCT && t.net < IDLE_WARN_PCT;
      d.log(`monitor: weekly idle trend p95 cpu=${t.cpu} mem=${t.mem} net=${t.net} idle=${idle}`);
      if (idle) {
        await d
          .notify({
            key: "idle-trend",
            subject: "The server looks idle to Oracle (early warning)",
            text:
              `Over the last 7 days the 95th percentile was CPU ${t.cpu} %, memory ${t.mem} %, network ${t.net} % ` +
              `(of ${netRefMbps} Mbit/s). All three are below ${IDLE_WARN_PCT} %; Oracle may reclaim an Always Free VM ` +
              `when all three stay below 20 % for 7 days. Nothing is done to raise them: be ready to move (docs/SELFHOST.md, MOVE.md).`,
          })
          .catch(() => undefined);
      }
    } else {
      d.log(
        `monitor: weekly idle trend skipped (${t.hours} hourly samples, need ${MIN_TREND_HOURS})`,
      );
    }
    await save("trend", ms);
  }

  async function maybeHost(ms: number): Promise<void> {
    if (lastHost !== null && ms - lastHost < HOST_EVERY_MS) return;
    lastHost = ms;

    // --- readings
    const stat = parseProcStat(read("/proc/stat"));
    let cpu: number | null = null;
    if (stat && prevCpu && stat.total > prevCpu.total) {
      cpu = Math.min(
        100,
        Math.max(0, ((stat.busy - prevCpu.busy) / (stat.total - prevCpu.total)) * 100),
      );
    }
    prevCpu = stat;
    const mi = parseMeminfo(read("/proc/meminfo"));
    const memAvail = mi ? (mi.available / mi.total) * 100 : null;
    const memUsed = memAvail === null ? null : 100 - memAvail;
    const bytes = parseNetDev(read(netPath));
    let net: number | null = null;
    if (bytes !== null && prevNet && ms > prevNet.ms && bytes >= prevNet.bytes) {
      const mbps = ((bytes - prevNet.bytes) * 8) / 1e6 / ((ms - prevNet.ms) / 1000);
      net = (mbps / netRefMbps) * 100;
    }
    prevNet = bytes === null ? null : { bytes, ms };
    let diskMax: number | null = null;
    for (const p of diskPaths) {
      const s = await statfs(p);
      const pct = s ? diskUsedPct(s) : null;
      if (pct !== null && (diskMax === null || pct > diskMax)) diskMax = pct;
    }

    // --- alerts (debounced; state saved only when it changed)
    let changed = false;
    if (diskMax !== null) {
      changed =
        (await evaluate(
          "disk",
          diskMax > DISK_MAX_PCT,
          ms,
          {
            subject: "Server disk is nearly full",
            text: `The data volume is ${Math.round(diskMax)} % full (alert above ${DISK_MAX_PCT} %).`,
          },
          {
            subject: "Server disk space is back to normal",
            text: `The data volume is ${Math.round(diskMax)} % full (alert above ${DISK_MAX_PCT} %).`,
          },
        )) || changed;
    }
    if (memAvail !== null) {
      changed =
        (await evaluate(
          "mem",
          memAvail < MEM_AVAILABLE_MIN_PCT,
          ms,
          {
            subject: "Server memory is low",
            text: `Only ${Math.round(memAvail)} % of memory is available (alert below ${MEM_AVAILABLE_MIN_PCT} %).`,
          },
          {
            subject: "Server memory is back to normal",
            text: `${Math.round(memAvail)} % of memory is available (alert below ${MEM_AVAILABLE_MIN_PCT} %).`,
          },
        )) || changed;
    }
    changed = (await checkRestarts(ms)) || changed;
    if (changed) await save("starts", ms);

    // --- trend: hourly means, one upsert when an hour closes
    const hour = Math.floor(ms / HOUR_MS) * HOUR_MS;
    if (cur !== null && cur.hour !== hour) {
      const r = closeHour();
      if (r) {
        trend.hours = [...trend.hours, r].slice(-TREND_KEEP_HOURS);
        await save("trend", ms);
      }
    }
    addSample(ms, cpu, memUsed, net);
    await weekly(ms);

    const t = trendNumbers(ms);
    d.health.host = {
      at: new Date(ms).toISOString(),
      cpuPct: cpu === null ? null : round1(cpu),
      memUsedPct: memUsed === null ? null : round1(memUsed),
      memAvailablePct: memAvail === null ? null : round1(memAvail),
      netPct: net === null ? null : round1(net),
      diskMaxPct: diskMax === null ? null : round1(diskMax),
      restartsLastHour: restartsLastHour(ms),
      trend: {
        hours: t.hours,
        p95CpuPct: t.cpu,
        p95MemPct: t.mem,
        p95NetPct: t.net,
        lastWeekly: trend.lastWeekly,
      },
    };
  }

  async function step(ms: number = d.nowMs()): Promise<void> {
    if (running) return;
    running = true;
    try {
      await maybePing(ms);
      await maybeHost(ms);
    } catch {
      d.log("monitor: step failed");
    } finally {
      running = false;
    }
  }

  return { init, step, restartsLastHour, pingEnabled };
}
