// @vitest-environment node
// INFRA T3 acceptance (REQ\infra\INFRA_REQUIREMENT.md §14): the clock fires all 26 slots and every UTC cron
// at the right times in a simulated week. A fake clock drives `tick()` every 30 s from Monday 00:00 to the
// next Monday 00:00 Sydney time (2026-11-02..08, AEDT all week, no clock change, a first Saturday for the
// bake-off) against a real SQLite database with `clock_owner = selfhost`; the Worker's own runners do the
// deciding. Expected times are an independent transcription of the §2.2 slot table and of vercel.json /
// the workflows' `schedule:` lines, not read from the code under test. With `clock_owner = cloud` (or the key
// absent) nothing fires at all.
import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createClock } from "../../clock/loop";
import { loadManifest } from "../../clock/manifest";
import { AU_SLOTS } from "../../worker/src/schedule";
import { makeDb, pipelineResponse, rows, setState } from "./fakeDb";
import path from "node:path";

const FAKE_CRON_SECRET = ["cron", "secret", "test", "0123456789"].join("-"); // built at run time: a fake, not a secret

const APP = "http://web:3000";
const DBURL = "http://main.sqld:8080";
const RAW = {
  PRAXIS_ENV: "production",
  PRAXIS_RUNTIME: "selfhost",
  CLOCK_ENABLED: "1",
  TURSO_MAIN_URL: DBURL,
  TURSO_MAIN_TOKEN: "tok-test-main",
  APP_BASE_URL: APP,
  WORKER_HMAC_SECRET: "7".repeat(64),
  CRON_SECRET: FAKE_CRON_SECRET,
  GITHUB_DISPATCH_TOKEN: "gh-token-test-0123456789",
};
const MIN = 60_000;
const SYD = 11 * 60 * MIN; // AEDT all week
const START = Date.UTC(2026, 10, 1, 13, 0); // Mon 2026-11-02 00:00 AEDT
const manifest = loadManifest(path.resolve(import.meta.dirname, "../../deploy/selfhost/jobs.json"));

const hm = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const mins = (a: string, b: string, every: number): number[] => {
  const [ah, am] = a.split(":").map(Number);
  const [bh, bm] = b.split(":").map(Number);
  const out: number[] = [];
  for (let m = ah! * 60 + am!; m <= bh! * 60 + bm!; m += every) out.push(m);
  return out;
};
const one = (t: string): number[] => mins(t, t, 1);

type Exp = {
  id: string;
  at: number[]; // local minutes of the day
  trading: boolean;
  firstSaturday?: boolean;
  /** off: no runner reads the slot; none: the code under test never fires it (see the notes). */
  how: "route" | "job" | "github" | "off" | "none";
};
// REQ §2.2, row by row (26 rows).
const TABLE: Exp[] = [
  { id: "asx-poll", at: mins("07:00", "19:30", 4), trading: true, how: "off" },
  { id: "alert-flush", at: mins("07:01", "20:59", 2), trading: true, how: "route" },
  { id: "universe", at: one("07:30"), trading: true, how: "off" },
  { id: "morning", at: one("08:00"), trading: false, how: "route" },
  // The recurring actions slot is skipped by candidateSlots (`everyMin` slots are not dispatched); the
  // Worker has never fired it, and the clock reuses the Worker unchanged. Reported to the Owner.
  { id: "asx-fetch", at: mins("08:00", "19:00", 30), trading: true, how: "none" },
  { id: "pre-open", at: one("09:54"), trading: true, how: "route" },
  // `after: pre-open`: fires only while pre-open is not "dispatched"; the fake app answers 200, so never.
  { id: "pre-open-retry", at: one("09:58"), trading: true, how: "none" },
  { id: "quote-poll", at: mins("10:00", "16:00", 5), trading: true, how: "route" },
  { id: "llm-bakeoff", at: one("10:00"), trading: false, firstSaturday: true, how: "job" },
  { id: "intraday-scan", at: mins("10:32", "15:32", 30), trading: true, how: "route" },
  { id: "ingest-batch1", at: one("17:30"), trading: false, how: "job" },
  { id: "arena-close", at: one("17:50"), trading: true, how: "job" },
  { id: "arena-signals", at: one("18:10"), trading: true, how: "job" },
  { id: "decision-cutoff", at: one("18:10"), trading: true, how: "job" },
  { id: "late-sweep", at: one("19:35"), trading: true, how: "off" },
  { id: "marker-check", at: one("19:50"), trading: true, how: "off" },
  { id: "evening-review", at: mins("20:00", "20:45", 5), trading: false, how: "route" },
  { id: "watchdog-2040", at: one("20:40"), trading: false, how: "job" },
  { id: "evening-review-late", at: mins("21:00", "22:00", 15), trading: false, how: "route" },
  { id: "watchdog-2150", at: one("21:50"), trading: false, how: "job" },
  { id: "kb-archive", at: one("22:15"), trading: false, how: "job" },
  { id: "maintenance", at: one("22:30"), trading: false, how: "job" },
  { id: "backup", at: one("23:00"), trading: false, how: "job" },
  { id: "backfill-history", at: one("23:30"), trading: false, how: "job" },
  { id: "backfill-prices", at: one("23:45"), trading: false, how: "job" },
  { id: "replay", at: one("00:15"), trading: false, how: "github" },
];
const ROUTE_OF: Record<string, string> = {
  "alert-flush": "alert-flush",
  morning: "morning",
  "pre-open": "preopen",
  "quote-poll": "pick-alerts",
  "intraday-scan": "intraday-scan",
  "evening-review": "evening-review",
  "evening-review-late": "evening-review",
};
const DAYS = [
  "2026-11-02",
  "2026-11-03",
  "2026-11-04",
  "2026-11-05",
  "2026-11-06",
  "2026-11-07",
  "2026-11-08",
];
const isTrading = (d: string): boolean => ![0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay());
const isFirstSat = (d: string): boolean => d === "2026-11-07";

/** "id@YYYY-MM-DD HH:MM" for every slot occurrence the table promises (Sydney local time). */
function expectedSlotEvents(): string[] {
  const out: string[] = [];
  for (const e of TABLE) {
    if (e.how === "off" || e.how === "none") continue;
    for (const d of DAYS) {
      if (e.trading && !isTrading(d)) continue;
      if (e.firstSaturday && !isFirstSat(d)) continue;
      for (const m of e.at) out.push(`${e.id}@${d} ${hm(m)}`);
    }
  }
  return out.sort();
}

// UTC crons: vercel.json (8) and the GitHub backstops that run in AEDT (the other regime's lines stand down).
const VERCEL: [string, string][] = [
  ["00:20", "/api/cron/heartbeat-morning"],
  ["00:50", "/api/cron/heartbeat-morning?try=2"],
  ["10:10", "/api/cron/heartbeat-evening?dst=aedt"],
  ["10:40", "/api/cron/heartbeat-evening?dst=aedt&try=2"],
  ["11:10", "/api/cron/heartbeat-evening"],
  ["11:40", "/api/cron/heartbeat-evening?try=2"],
  ["11:40", "/api/cron/watchdog"],
  ["12:40", "/api/cron/watchdog?try=2"],
];
const BACKSTOP_RUN: [string, string, string][] = [
  ["07:15", "ingest-batch1", ""],
  ["09:40", "watchdog", "2040"],
  ["10:50", "watchdog", "2150"],
];
const BACKSTOP_GATED = ["08:15", "10:40", "11:50"];
const UTC_DAYS = [
  "2026-11-02",
  "2026-11-03",
  "2026-11-04",
  "2026-11-05",
  "2026-11-06",
  "2026-11-07",
  "2026-11-08",
];
function expectedUtcEvents(): string[] {
  const out: string[] = [];
  for (const d of UTC_DAYS) {
    for (const [t, p] of VERCEL) out.push(`GET ${p}@${d}T${t}Z`);
    for (const [t, job, slot] of BACKSTOP_RUN)
      out.push(`job ${job}${slot ? `#${slot}` : ""}@${d}T${t}Z`);
  }
  return out.sort();
}

let db: DatabaseSync;
let events: string[];
let now: number;
let appPosts: { path: string; slot: string | undefined; at: number }[];
let githubCalls: { workflow: string; at: number }[];
let crons: { path: string; at: number; auth: string | null; agent: string | null }[];
let queued: { job: string; slotId: string | null; inputs: Record<string, string>; at: number }[];

const localOf = (ms: number): string => {
  const d = new Date(ms + SYD).toISOString();
  return `${d.slice(0, 10)} ${d.slice(11, 16)}`;
};
const utcOf = (ms: number): string =>
  `${new Date(ms).toISOString().slice(0, 10)}T${new Date(ms).toISOString().slice(11, 16)}Z`;

function seed(owner: string | null) {
  setState(db, "dispatch_enabled", '"1"');
  setState(db, "slots_enabled", JSON.stringify(AU_SLOTS.map((s) => s.id)));
  setState(db, "alert_flush_due", JSON.stringify("2020-01-01T00:00:00.000Z"));
  setState(db, "bakeoff_inputs", JSON.stringify({ candidates: "google:gemini-test" }));
  if (owner !== null) setState(db, "clock_owner", JSON.stringify(owner));
  db.prepare("UPDATE market SET mode = 'full' WHERE code = 'AU'").run();
  // The night's arena run record is closed, so the 30-minute recheck does not dispatch arena-close again.
  for (const d of DAYS) {
    db.prepare(
      "INSERT INTO run_record (job, market, concurrency_key, scheduled_for, started_at, status, details_json) " +
        "VALUES ('arena-close', 'AU', ?, ?, ?, 'success', '{}')",
    ).run(`arena-2a:AU:${d}`, d, `${d}T06:50:00.000Z`);
  }
}

async function driveWeek(owner: string | null, days = 7): Promise<void> {
  seed(owner);
  const realFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === `${DBURL}/v2/pipeline`) return pipelineResponse(db, String(init?.body));
    if (url.startsWith(`${APP}/api/cron/`)) {
      const h = (init?.headers ?? {}) as Record<string, string>;
      crons.push({
        path: url.slice(APP.length),
        at: now,
        auth: h.Authorization ?? null,
        agent: h["User-Agent"] ?? null,
      });
      return Response.json({ ok: true });
    }
    if (url.startsWith(`${APP}/api/internal/`)) {
      const body = JSON.parse(String(init?.body)) as { slot?: string };
      appPosts.push({ path: url.slice(APP.length), slot: body.slot, at: now });
      return Response.json({ ok: true });
    }
    if (url.startsWith("https://api.github.com/repos/")) {
      githubCalls.push({ workflow: /workflows\/([^/]+)\/dispatches/.exec(url)![1]!, at: now });
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected url ${url.replace(/\/\/[^/]+/, "//host")}`);
  }) as typeof fetch;
  const clock = createClock({
    rawEnv: RAW,
    manifest,
    realFetch,
    nowMs: () => now,
    log: () => {},
    root: "unused",
  });
  // No process is started in this test: a queued job is only recorded.
  clock.runner.enqueue = (req) => {
    queued.push({ job: req.job, slotId: req.slotId ?? null, inputs: req.inputs ?? {}, at: now });
    return "queued";
  };
  for (now = START; now < START + days * 1440 * MIN; now += 30_000) await clock.tick(now);
  expect(clock.health.owner).toBe(owner === "selfhost" ? "selfhost" : "cloud");
}

/** Slot-level events as seen at the edges: app posts, enqueued jobs (dispatch path) and GitHub calls. */
function observedSlotEvents(): string[] {
  const out: string[] = [];
  for (const p of appPosts) {
    const id = Object.keys(ROUTE_OF).find((k) => k === p.slot);
    expect(id, `route post for ${p.path}`).toBeDefined();
    expect(p.path).toBe(`/api/internal/${ROUTE_OF[id!]}`);
    out.push(`${id}@${localOf(p.at)}`);
  }
  for (const q of queued) {
    if (q.slotId !== null) continue; // a UTC backstop or a local-only job, counted separately
    const hh = localOf(q.at).slice(11);
    let id = q.job;
    if (q.job === "asx-fetch") id = "decision-cutoff";
    if (q.job === "watchdog") id = q.inputs.slot === "2040" ? "watchdog-2040" : "watchdog-2150";
    out.push(`${id}@${localOf(q.at).slice(0, 10)} ${hh}`);
  }
  for (const g of githubCalls) out.push(`${g.workflow.replace(".yml", "")}@${localOf(g.at)}`);
  return out.sort();
}

function observedUtcEvents(): string[] {
  const out: string[] = [];
  for (const c of crons) {
    expect(c.auth, c.path).toBe(`Bearer ${RAW.CRON_SECRET}`);
    expect(c.agent, c.path).toMatch(/^vercel-cron\//);
    out.push(`GET ${c.path}@${utcOf(c.at)}`);
  }
  for (const q of queued) {
    if (q.slotId === null || q.slotId.startsWith("local:")) continue;
    out.push(`job ${q.job}${q.inputs.slot ? `#${q.inputs.slot}` : ""}@${utcOf(q.at)}`);
  }
  return out.sort();
}

// Local-only jobs (jobs.json localSchedule): only on the self-hosted runtime, only while it is owner.
function expectedLocalEvents(): string[] {
  const out: string[] = [];
  for (const d of DAYS) {
    for (let h = 7; h <= 23; h++) out.push(`bucket-hourly@${d} ${hm(h * 60 + 5)}`);
    out.push(`turso-refresh@${d} 23:25`);
    out.push(`replay-sync@${d} 06:00`, `replay-sync@${d} 23:10`);
  }
  out.push("restore-drill@2026-11-08 10:00"); // the Sunday
  return out.sort();
}
const observedLocalEvents = (): string[] =>
  queued
    .filter((q) => q.slotId?.startsWith("local:"))
    .map((q) => {
      expect(q.slotId).toBe(`local:${q.job}`);
      return `${q.job}@${localOf(q.at)}`;
    })
    .sort();

const diff = (a: string[], b: string[]) => ({
  missing: a.filter((x) => !b.includes(x)),
  extra: b.filter((x) => !a.includes(x)),
});

function reset(): void {
  db = makeDb();
  events = [];
  appPosts = [];
  githubCalls = [];
  crons = [];
  queued = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    events.push(a.join(" "));
  });
}

describe("the table under test", () => {
  beforeEach(reset);
  afterEach(() => vi.restoreAllMocks());
  it("has exactly the 26 slots of the requirement, in the same ids", () => {
    expect(AU_SLOTS).toHaveLength(26);
    expect(AU_SLOTS.map((s) => s.id).sort()).toEqual(TABLE.map((e) => e.id).sort());
  });
  it("this test's week has no clock change and no weekday holiday in the calendar", () => {
    expect(isTrading("2026-11-02")).toBe(true);
    const kinds = rows(
      db,
      "SELECT d, kind FROM trading_calendar WHERE market = 'AU' AND d BETWEEN ? AND ?",
      "2026-11-02",
      "2026-11-08",
    );
    for (const r of kinds) expect(r.kind, String(r.d)).toBe("session");
    expect(new Date("2026-11-07T12:00:00Z").getUTCDay()).toBe(6);
  });
});

describe("a simulated Sydney week, clock_owner = selfhost (T3 acceptance)", () => {
  // One drive of the week (about 15 s) serves every check below; the per-test reset is switched off here.
  beforeAll(async () => {
    reset();
    await driveWeek("selfhost");
  }, 120_000);
  afterAll(() => vi.restoreAllMocks());
  it("every slot fires at its time exactly once, and every UTC cron fires exactly once", () => {
    const want = expectedSlotEvents();
    const got = observedSlotEvents();
    expect(diff(want, got)).toEqual({ missing: [], extra: [] });
    expect(got).toHaveLength(want.length); // "exactly once": no duplicate of any event
    expect(new Set(got).size).toBe(got.length);

    const wantUtc = expectedUtcEvents();
    const gotUtc = observedUtcEvents();
    expect(diff(wantUtc, gotUtc)).toEqual({ missing: [], extra: [] });
    expect(new Set(gotUtc).size).toBe(gotUtc.length);

    const wantLocal = expectedLocalEvents();
    expect(diff(wantLocal, observedLocalEvents())).toEqual({ missing: [], extra: [] });
    expect(wantLocal).toHaveLength(7 * 20 + 1);
    expect(observedLocalEvents()).toHaveLength(wantLocal.length);

    // Sanity on the size of the week, so an empty comparison cannot pass: 8 + 3 crons a day, 7 days.
    expect(gotUtc).toHaveLength(7 * 11);
    expect(want.length).toBeGreaterThan(2500);
    // Per slot the count is days x times per day.
    const count = (id: string) => got.filter((g) => g.startsWith(`${id}@`)).length;
    expect(count("alert-flush")).toBe(5 * 420);
    expect(count("quote-poll")).toBe(5 * 73);
    expect(count("intraday-scan")).toBe(5 * 11);
    expect(count("evening-review")).toBe(7 * 10);
    expect(count("evening-review-late")).toBe(7 * 5);
    expect(count("llm-bakeoff")).toBe(1);
    for (const id of ["arena-close", "arena-signals", "decision-cutoff", "pre-open"]) {
      expect(count(id), id).toBe(5);
    }
    for (const id of [
      "ingest-batch1",
      "watchdog-2040",
      "watchdog-2150",
      "kb-archive",
      "maintenance",
      "backup",
      "backfill-history",
      "backfill-prices",
      "replay",
      "morning",
    ]) {
      expect(count(id), id).toBe(7);
    }
    for (const id of [
      "asx-poll",
      "universe",
      "late-sweep",
      "marker-check",
      "asx-fetch",
      "pre-open-retry",
    ]) {
      expect(count(id), id).toBe(0);
    }
  });

  it("jobs carry the right inputs; replay goes to GitHub, never to a local job", () => {
    const bake = queued.filter((q) => q.job === "llm-bakeoff");
    expect(bake).toHaveLength(1);
    expect(bake[0]!.inputs).toEqual({ candidates: "google:gemini-test" });
    expect(queued.some((q) => q.job === "replay")).toBe(false);
    expect(githubCalls.every((g) => g.workflow === "replay.yml")).toBe(true);
    expect(githubCalls).toHaveLength(7);
    // The watchdog backstops hand over the same `slot` input the workflow's gate step computes.
    const wd = queued
      .filter((q) => q.job === "watchdog" && q.slotId !== null)
      .map((q) => q.inputs.slot);
    expect(wd.sort()).toEqual([...Array(7).fill("2040"), ...Array(7).fill("2150")].sort());
    // The tick record of this runtime is in the database (praxis owner prints it).
    const t = rows(db, "SELECT value_json FROM worker_state WHERE key = 'clock_tick:selfhost'");
    expect(t).toHaveLength(1);
  });

  it("the other DST regime's backstop lines stand down (never fire)", () => {
    for (const t of BACKSTOP_GATED) {
      expect(queued.some((q) => q.slotId !== null && utcOf(q.at).endsWith(`T${t}Z`))).toBe(false);
    }
  });
});

describe("clock_owner = cloud (or absent): the self-hosted clock stands by for the whole week", () => {
  beforeEach(reset);
  afterEach(() => vi.restoreAllMocks());
  for (const owner of ["cloud", null] as const) {
    it(`owner ${owner ?? "key absent"}: nothing is posted, queued, dispatched or called`, async () => {
      await driveWeek(owner, owner === null ? 2 : 7);
      expect(appPosts).toEqual([]);
      expect(queued).toEqual([]);
      expect(githubCalls).toEqual([]);
      expect(crons).toEqual([]);
      expect(rows(db, "SELECT key FROM worker_state WHERE key LIKE 'slot:%'")).toEqual([]);
      expect(events.some((e) => e.includes("standby"))).toBe(true);
    }, 120_000);
  }
});
