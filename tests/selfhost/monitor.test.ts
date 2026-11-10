// @vitest-environment node
// INFRA T6 (REQ\infra\INFRA_REQUIREMENT.md §8.3, §9, §12 R3/R9): dead-man ping, host checks, idle trend.
// Fakes for statfs, /proc files, fetch, mail and the database; no timers, no network.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { healthBody, newHealthState } from "../../clock/health";
import {
  DEADMAN_EVERY_MS,
  DEADMAN_EXTERNAL_GRACE_MIN,
  DEBOUNCE_MS,
  HOUR_MS,
  createMonitor,
  diskUsedPct,
  p95,
  parseMeminfo,
  parseNetDev,
  parseProcStat,
  startsKey,
  trendKey,
  type HourRow,
  type MonitorDeps,
} from "../../clock/monitor";
import type { AlertInfo } from "../../clock/notify";

const T0 = Date.parse("2026-11-04T01:00:00Z");
const PING = "https://hc.example.test/ping/abc";

/** worker_state as a Map behind the LeaseDb interface (SELECT by key, upsert). */
function fakeDb() {
  const m = new Map<string, string>();
  const writes: string[] = [];
  const db: MonitorDeps["db"] = async (stmts) =>
    stmts.map((s) => {
      if (s.sql.startsWith("SELECT")) {
        const v = m.get(String(s.args![0]));
        return { rows: v === undefined ? [] : [[v]] } as never;
      }
      m.set(String(s.args![0]), String(s.args![1]));
      writes.push(String(s.args![0]));
      return { rows: [] } as never;
    });
  return { db, m, writes };
}

type Opts = {
  env?: Record<string, string>;
  files?: Record<string, string | null>;
  disk?: number; // percent used
  start?: number;
  db?: ReturnType<typeof fakeDb>;
};
function make(o: Opts = {}) {
  let now = o.start ?? T0;
  const dbf = o.db ?? fakeDb();
  const health = newHealthState({ nowMs: now, enabled: true, runtime: "selfhost" });
  const mails: AlertInfo[] = [];
  const pings: number[] = [];
  const logs: string[] = [];
  const state = { files: { ...(o.files ?? {}) }, disk: o.disk ?? 40, pingFails: false };
  const mon = createMonitor({
    env: { DEADMAN_PING_URL: PING, JOBS_ROOT: "/data", ...(o.env ?? {}) },
    runtime: "selfhost",
    health,
    db: dbf.db,
    nowMs: () => now,
    fetch: (async (url: string) => {
      if (state.pingFails) throw new Error(`boom ${url}`);
      expect(url).toBe(PING);
      pings.push(now);
      return new Response("OK");
    }) as unknown as typeof fetch,
    log: (l) => logs.push(l),
    notify: async (a) => {
      mails.push(a);
    },
    readText: (p) => state.files[p] ?? null,
    statfs: async () => ({
      bsize: 4096,
      blocks: 1000,
      bfree: 1000 - state.disk * 10,
      bavail: 1000 - state.disk * 10,
    }),
  });
  return {
    mon,
    health,
    mails,
    pings,
    logs,
    state,
    dbf,
    at: (ms: number) => {
      now = ms;
    },
    tickAt: (ms: number) => {
      health.lastTickMs = ms;
    },
    now: () => now,
  };
}

const MEM = (availPct: number) =>
  `MemTotal:       1000000 kB\nMemFree: 1 kB\nMemAvailable:   ${availPct * 10000} kB\n`;

describe("parsers and the p95 math", () => {
  it("p95 is the nearest rank; empty is null", () => {
    expect(p95([])).toBeNull();
    expect(p95([7])).toBe(7);
    expect(p95(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(95);
    expect(p95(Array.from({ length: 20 }, (_, i) => 20 - i))).toBe(19);
    expect(p95([1, 1, 1, 1, 1, 1, 1, 1, 1, 100])).toBe(100);
  });
  it("/proc/stat: busy excludes idle and iowait", () => {
    const a = parseProcStat("cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 1 2 3");
    expect(a).toEqual({ busy: 150, total: 1000 });
    expect(parseProcStat("nonsense")).toBeNull();
    expect(parseProcStat(null)).toBeNull();
  });
  it("/proc/meminfo and /proc/net/dev (lo excluded, rx + tx summed)", () => {
    expect(parseMeminfo(MEM(25))).toEqual({ total: 1000000, available: 250000 });
    expect(parseMeminfo("x")).toBeNull();
    const net = [
      "Inter-|   Receive                                                |  Transmit",
      " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
      "    lo: 999999 1 0 0 0 0 0 0 999999 1 0 0 0 0 0 0",
      "  eth0: 1000 1 0 0 0 0 0 0 500 1 0 0 0 0 0 0",
      "  eth1: 10 1 0 0 0 0 0 0 5 1 0 0 0 0 0 0",
    ].join("\n");
    expect(parseNetDev(net)).toBe(1515);
    expect(parseNetDev(null)).toBeNull();
  });
  it("disk use is used / (used + available), like df", () => {
    expect(diskUsedPct({ bsize: 1, blocks: 100, bfree: 20, bavail: 20 })).toBe(80);
    expect(diskUsedPct({ bsize: 1, blocks: 100, bfree: 20, bavail: 10 })).toBeCloseTo(88.89, 1);
  });
});

describe("dead-man ping", () => {
  it("pings every 2 minutes while the tick is healthy, never more often", async () => {
    const m = make();
    for (let s = 0; s <= 600; s += 30) {
      m.at(T0 + s * 1000);
      m.tickAt(T0 + s * 1000); // the tick keeps running (owner or standby alike)
      await m.mon.step();
    }
    expect(m.pings.map((p) => (p - T0) / 1000)).toEqual([0, 120, 240, 360, 480, 600]);
  });
  it("stays silent while the last tick is 3 minutes old or older, and resumes with the tick", async () => {
    const m = make();
    m.tickAt(T0);
    m.at(T0);
    await m.mon.step(); // ping 1
    m.at(T0 + 150_000);
    await m.mon.step(); // tick 150 s old: still healthy, ping
    expect(m.pings).toHaveLength(2);
    m.at(T0 + 150_000 + 180_000);
    await m.mon.step(); // tick 330 s old: stale
    m.at(T0 + 150_000 + 600_000);
    await m.mon.step();
    expect(m.pings).toHaveLength(2);
    m.tickAt(m.now());
    m.at(m.now() + 30_000);
    await m.mon.step();
    expect(m.pings).toHaveLength(3);
  });
  it("never pings before the first tick", async () => {
    const m = make();
    await m.mon.step();
    expect(m.pings).toHaveLength(0);
  });
  it("an empty URL disables it with ONE start-up warning; a failed ping never logs the URL", async () => {
    const off = make({ env: { DEADMAN_PING_URL: "" } });
    await off.mon.init();
    off.tickAt(T0);
    await off.mon.step();
    await off.mon.step(T0 + 600_000);
    expect(off.pings).toHaveLength(0);
    expect(off.mon.pingEnabled).toBe(false);
    expect(off.logs.filter((l) => /DISABLED/.test(l))).toHaveLength(1);

    const bad = make();
    bad.state.pingFails = true;
    bad.tickAt(T0);
    await bad.mon.step();
    expect(bad.logs.join("\n")).toMatch(/ping failed/);
    expect(bad.logs.join("\n")).not.toContain("hc.example.test");
  });
  it("clock killed: the last ping is at most 2 min before the kill, so the email comes within 12 min (< 15)", async () => {
    // The external service emails after DEADMAN_EXTERNAL_GRACE_MIN minutes of silence (docs/SELFHOST.md).
    expect(DEADMAN_EVERY_MS).toBe(120_000);
    expect(DEADMAN_EXTERNAL_GRACE_MIN).toBe(10);
    let worst = 0;
    for (const killOffsetS of [0, 7, 29, 30, 59, 60, 91, 119, 120, 121, 239]) {
      const m = make();
      const kill = T0 + 3_600_000 + killOffsetS * 1000;
      // the process runs a 30 s step loop from T0 until it is killed; a killed process makes no more ticks or pings
      for (let t = T0; t < kill; t += 30_000) {
        m.at(t);
        m.tickAt(t);
        await m.mon.step();
      }
      const last = Math.max(...m.pings);
      expect(kill - last, `kill +${killOffsetS}s`).toBeLessThanOrEqual(DEADMAN_EVERY_MS);
      const emailAfterMin = (last + DEADMAN_EXTERNAL_GRACE_MIN * 60_000 - kill) / 60_000;
      worst = Math.max(worst, emailAfterMin);
      expect(emailAfterMin, `kill +${killOffsetS}s`).toBeLessThanOrEqual(12);
    }
    expect(worst).toBeGreaterThan(9); // sanity: the model is not trivially zero
    // the old plan (5 min ping, 15 min grace) would have been 20 min worst case, so it was tightened
    expect(5 + 15).toBeGreaterThan(15);
  });
});

describe("host checks: disk, memory, debounce and recovery", () => {
  it("disk above 80 % mails once, repeats only after 6 h, and sends one recovery", async () => {
    const m = make({ disk: 85 });
    m.tickAt(T0);
    await m.mon.init();
    await m.mon.step(T0);
    expect(m.mails.map((a) => a.key)).toEqual(["disk"]);
    for (let s = 300; s < 6 * 3600; s += 300) {
      m.at(T0 + s * 1000);
      m.tickAt(T0 + s * 1000);
      await m.mon.step();
    }
    expect(m.mails).toHaveLength(1); // debounced for 6 h
    m.at(T0 + DEBOUNCE_MS);
    m.tickAt(m.now());
    await m.mon.step();
    expect(m.mails.map((a) => a.key)).toEqual(["disk", "disk"]);
    m.state.disk = 50;
    m.at(T0 + DEBOUNCE_MS + 300_000);
    m.tickAt(m.now());
    await m.mon.step();
    expect(m.mails.map((a) => a.key)).toEqual(["disk", "disk", "disk-ok"]);
    m.at(T0 + DEBOUNCE_MS + 600_000);
    await m.mon.step();
    expect(m.mails).toHaveLength(3); // the recovery is sent once
    expect(m.mails.every((a) => !/\/data|http|:\/\//.test(a.text))).toBe(true);
  });
  it("exactly 80 % is fine; just above is not", async () => {
    const ok = make({ disk: 80 });
    await ok.mon.step(T0);
    expect(ok.mails).toHaveLength(0);
    const hi = make();
    hi.state.disk = 80.1;
    await hi.mon.step(T0);
    expect(hi.mails.map((a) => a.key)).toEqual(["disk"]);
  });
  it("memory available below 10 % mails; 10 % does not; a missing /proc/meminfo is skipped", async () => {
    const low = make({ files: { "/proc/meminfo": MEM(9) } });
    await low.mon.step(T0);
    expect(low.mails.map((a) => a.key)).toEqual(["mem"]);
    const edge = make({ files: { "/proc/meminfo": MEM(10) } });
    await edge.mon.step(T0);
    expect(edge.mails).toHaveLength(0);
    const none = make();
    await none.mon.step(T0);
    expect(none.mails).toHaveLength(0);
    expect(none.health.host?.memAvailablePct).toBeNull();
    low.state.files["/proc/meminfo"] = MEM(40);
    low.at(T0 + 300_000);
    await low.mon.step();
    expect(low.mails.map((a) => a.key)).toEqual(["mem", "mem-ok"]);
  });
  it("the alert state is persisted: a restart inside the 6 h does not mail again", async () => {
    const dbf = fakeDb();
    const a = make({ disk: 90, db: dbf });
    await a.mon.init();
    await a.mon.step(T0);
    expect(a.mails).toHaveLength(1);
    const b = make({ disk: 90, db: dbf, start: T0 + 600_000 });
    await b.mon.init();
    await b.mon.step(T0 + 600_000);
    expect(b.mails).toHaveLength(0);
  });
  it("checks run every 5 minutes, not on every 30 s step", async () => {
    const m = make({ files: { "/proc/meminfo": MEM(50) } });
    await m.mon.step(T0);
    const first = m.health.host!.at;
    await m.mon.step(T0 + 30_000);
    expect(m.health.host!.at).toBe(first);
    await m.mon.step(T0 + 300_000);
    expect(m.health.host!.at).not.toBe(first);
  });
});

describe("restart counting", () => {
  it("one upsert per start; more than 3 starts in an hour mails once; fewer does not", async () => {
    const dbf = fakeDb();
    const mails: AlertInfo[] = [];
    for (let i = 0; i < 4; i++) {
      const m = make({ db: dbf, start: T0 + i * 600_000 });
      await m.mon.init();
      mails.push(...m.mails);
      if (i < 3) expect(m.mails, `start ${i + 1}`).toHaveLength(0);
    }
    expect(mails.map((a) => a.key)).toEqual(["restarts"]);
    expect(dbf.writes.filter((k) => k === startsKey("selfhost"))).toHaveLength(4);
    // the fifth start 10 minutes later: debounced, no second mail
    const m5 = make({ db: dbf, start: T0 + 4 * 600_000 });
    await m5.mon.init();
    expect(m5.mails).toHaveLength(0);
    expect(m5.mon.restartsLastHour(T0 + 4 * 600_000)).toBe(5);
  });
  it("starts older than an hour do not count; the recovery mail follows", async () => {
    const dbf = fakeDb();
    let last = make({ db: dbf });
    for (let i = 0; i < 4; i++) {
      last = make({ db: dbf, start: T0 + i * 60_000 });
      await last.mon.init();
    }
    expect(last.mails.map((a) => a.key)).toEqual(["restarts"]);
    const later = T0 + 3 * 60_000 + HOUR_MS + 1000;
    const m = make({ db: dbf, start: later });
    await m.mon.init(); // 1 start in the last hour now: recovery
    expect(m.mon.restartsLastHour(later)).toBe(1);
    expect(m.mails.map((a) => a.key)).toEqual(["restarts-ok"]);
  });
});

describe("idle trend (Oracle reclamation early warning)", () => {
  const SUNDAY_0900 = Date.parse("2026-11-14T22:00:00Z"); // Sunday 15 Nov 09:00 AEDT
  const hours = (n: number, endMs: number, v: (i: number) => [number, number, number]): HourRow[] =>
    Array.from({ length: n }, (_, i) => {
      const [c, mm, net] = v(i);
      return [endMs - (n - i) * HOUR_MS, c, mm, net] as HourRow;
    });
  function seeded(rows: HourRow[]) {
    const dbf = fakeDb();
    dbf.m.set(trendKey("selfhost"), JSON.stringify({ v: 1, hours: rows, lastWeekly: null }));
    return dbf;
  }
  const idleMails = (m: { mails: AlertInfo[] }) => m.mails.filter((a) => a.key === "idle-trend");

  it("emails when CPU, memory AND network p95 are all below 25 %, once per Sunday", async () => {
    const dbf = seeded(hours(168, SUNDAY_0900, () => [4, 22, 1]));
    const m = make({ db: dbf, start: SUNDAY_0900 });
    await m.mon.init();
    await m.mon.step(SUNDAY_0900);
    expect(idleMails(m)).toHaveLength(1);
    expect(idleMails(m)[0]!.text).toMatch(/CPU 4 %, memory 22 %, network 1 %/);
    await m.mon.step(SUNDAY_0900 + 3_600_000);
    expect(idleMails(m)).toHaveLength(1);
    expect(JSON.parse(dbf.m.get(trendKey("selfhost"))!).lastWeekly).toBe("2026-11-15");
  });
  it("one metric at or above 25 % (the 95th percentile, not the mean) means no mail", async () => {
    // memory 30 % in 10 % of the hours: p95 = 30 although the mean is low
    const m1 = make({
      db: seeded(hours(168, SUNDAY_0900, (i) => [4, i % 10 === 0 ? 30 : 10, 1])),
      start: SUNDAY_0900,
    });
    await m1.mon.init();
    await m1.mon.step(SUNDAY_0900);
    expect(idleMails(m1)).toHaveLength(0);
    const net = make({
      db: seeded(hours(168, SUNDAY_0900, () => [4, 10, 25])),
      start: SUNDAY_0900,
    });
    await net.mon.init();
    await net.mon.step(SUNDAY_0900);
    expect(idleMails(net)).toHaveLength(0); // exactly 25 is not below 25
  });
  it("not before Sunday 09:00 Sydney, not on other days, and not with under 5 days of data", async () => {
    const early = make({
      db: seeded(hours(168, SUNDAY_0900 - 3_600_000, () => [4, 10, 1])),
      start: SUNDAY_0900 - 3_600_000,
    });
    await early.mon.init();
    await early.mon.step(SUNDAY_0900 - 3_600_000); // 08:00 Sunday
    expect(idleMails(early)).toHaveLength(0);
    const mon = make({
      db: seeded(hours(168, SUNDAY_0900 + 86_400_000, () => [4, 10, 1])),
      start: SUNDAY_0900 + 86_400_000,
    });
    await mon.mon.init();
    await mon.mon.step(SUNDAY_0900 + 86_400_000); // Monday
    expect(idleMails(mon)).toHaveLength(0);
    const fresh = make({
      db: seeded(hours(60, SUNDAY_0900, () => [4, 10, 1])),
      start: SUNDAY_0900,
    });
    await fresh.mon.init();
    await fresh.mon.step(SUNDAY_0900);
    expect(idleMails(fresh)).toHaveLength(0);
    expect(fresh.logs.join("\n")).toMatch(/skipped/);
  });
  it("samples /proc every 5 min into hourly means; ONE upsert per closed hour; /health shows the numbers", async () => {
    const dbf = fakeDb();
    const m = make({ db: dbf });
    let busy = 0;
    let total = 0;
    let bytes = 0;
    const setFiles = () => {
      m.state.files["/proc/stat"] = `cpu ${busy} 0 0 ${total - busy} 0 0 0 0\n`;
      m.state.files["/proc/net/dev"] =
        `  eth0: ${bytes} 1 0 0 0 0 0 0 0 1 0 0 0 0 0 0\n    lo: 5 1 0 0 0 0 0 0 5 1 0 0 0 0 0 0\n`;
      m.state.files["/proc/meminfo"] = MEM(60);
    };
    setFiles();
    await m.mon.init();
    const startWrites = dbf.writes.length; // the start-up upsert
    for (let s = 0; s <= 3 * 3600; s += 300) {
      // 20 % busy; 0.25 MB/s = 2 Mbit/s = 20 % of the default 10 Mbit/s reference
      busy += 300 * 20;
      total += 300 * 100;
      bytes += 300 * 250_000;
      setFiles();
      m.at(T0 + s * 1000);
      m.tickAt(m.now());
      await m.mon.step();
    }
    const trendWrites = dbf.writes.slice(startWrites).filter((k) => k === trendKey("selfhost"));
    expect(trendWrites).toHaveLength(3); // hours 1, 2, 3 closed
    const saved = JSON.parse(dbf.m.get(trendKey("selfhost"))!) as { hours: HourRow[] };
    expect(saved.hours).toHaveLength(3);
    const [, cpu, mem, net] = saved.hours[1]!;
    expect(cpu).toBe(20);
    expect(mem).toBe(40);
    expect(net).toBe(20);
    const h = m.health.host!;
    expect(h.trend.hours).toBe(3);
    expect(h.cpuPct).toBe(20);
    expect(h.memUsedPct).toBe(40);
    expect(h.netPct).toBe(20);
    expect(h.trend.p95CpuPct).toBe(20);
    // nothing but numbers, ISO times and null in the health block: no path, URL or secret
    expect(JSON.stringify(h)).not.toMatch(/https?:|\/data|PING|token/i);
  });
  it("the 7-day figure ignores older hourly means", async () => {
    const dbf = seeded(hours(200, T0, () => [1, 1, 1]));
    const m = make({ db: dbf });
    await m.mon.init();
    await m.mon.step(T0);
    expect(m.health.host!.trend.hours).toBe(168);
  });
  it("never generates load: the monitor source has no spawn, busy loop or stress call", () => {
    const src = readFileSync(new URL("../../clock/monitor.ts", import.meta.url), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(src).not.toMatch(/child_process|spawn|execSync|while\s*\(true\)|pbkdf2|stress/);
  });
});

describe("health body", () => {
  it("includes the host block (null until the first check)", async () => {
    const m = make();
    const rv = { running: () => [], queued: () => [] };
    expect(healthBody(m.health, rv, T0).host).toBeNull();
    await m.mon.step(T0);
    expect(healthBody(m.health, rv, T0).host?.diskMaxPct).toBe(40);
  });
});
