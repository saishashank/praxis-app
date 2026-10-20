// M6 T16 (TST-103, TST-123; D-116): the Worker clock dispatches the `kb-archive` slot (22:15, the only M6
// slot) once per local day on the days around both Sydney clock changes and across day types, with the
// dispatch switch on and off and market mode full / data_only / off. The slot is disabled in the shipped
// table, so these tests enable a copy. Nothing touches a network: GitHub is the local fake.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetClockCache, runClock, type ClockEnv } from "../src/clock";
import { sydneyLocal } from "../src/localtime";
import { AU_SLOTS, type Slot } from "../src/schedule";
import { TOKEN, TURSO_TOKEN, TURSO_URL, makeDb, makeNet, rows } from "./fakeTurso";

const MIN = 60_000;
const ENV: ClockEnv = {
  PRAXIS_ENV: "production",
  GITHUB_DISPATCH_TOKEN: TOKEN,
  TURSO_MAIN_URL: TURSO_URL,
  TURSO_MAIN_TOKEN: TURSO_TOKEN,
};
const ON: Slot[] = AU_SLOTS.map((s) => (s.id === "kb-archive" ? { ...s, enabled: true } : s));

const utc = (date: string, time: string, offset: number): number => {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return Date.UTC(y, mo - 1, d, h - offset, mi);
};

let db: ReturnType<typeof makeDb>;
let net: ReturnType<typeof makeNet>;

const tick = (t: number, slots: readonly Slot[] = ON) =>
  runClock(ENV, t, { fetch: net.f, nowMs: () => t }, slots);
const enable = (v = '"1"') =>
  db
    .prepare(
      "INSERT INTO worker_state (key, value_json, updated_at) VALUES ('dispatch_enabled', ?, 'x') " +
        "ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json",
    )
    .run(v);
const mode = (m: string) => db.prepare("UPDATE market SET mode = ? WHERE code = 'AU'").run(m);
const archiveCalls = () => net.github.filter((c) => c.url.includes("/kb-archive.yml/dispatches"));

beforeEach(() => {
  db = makeDb();
  net = makeNet(db);
  resetClockCache();
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** Tick every UTC minute whose Sydney date is `date`; returns the instants of the archive dispatches. */
async function sweep(date: string): Promise<string[]> {
  const [y, m, d] = date.split("-").map(Number);
  const from = Date.UTC(y, m - 1, d) - 14 * 60 * MIN;
  const fired: string[] = [];
  for (let t = from; t < from + 52 * 60 * MIN; t += MIN) {
    if (sydneyLocal(t).date !== date) continue;
    const before = archiveCalls().length;
    await tick(t);
    if (archiveCalls().length > before) fired.push(new Date(t).toISOString());
  }
  return fired;
}

const DAYS: { date: string; offset: 10 | 11; what: string }[] = [
  { date: "2026-10-02", offset: 10, what: "Fri" },
  { date: "2026-10-03", offset: 10, what: "Sat" },
  { date: "2026-10-04", offset: 11, what: "Sun, spring forward" },
  { date: "2026-10-05", offset: 11, what: "Mon" },
  { date: "2027-04-02", offset: 11, what: "Fri" },
  { date: "2027-04-03", offset: 11, what: "Sat" },
  { date: "2027-04-04", offset: 10, what: "Sun, fall back" },
  { date: "2027-04-05", offset: 10, what: "Mon" },
  { date: "2026-12-24", offset: 11, what: "half day" },
  { date: "2026-12-25", offset: 11, what: "public holiday" },
];

describe("TST-103/TST-123: the kb-archive slot through the Worker clock", () => {
  for (const day of DAYS) {
    it(`${day.date} (${day.what}): exactly one dispatch of kb-archive.yml at 22:15 local, ref release`, async () => {
      enable();
      const fired = await sweep(day.date);
      expect(fired).toEqual([new Date(utc(day.date, "22:15", day.offset)).toISOString()]);
      expect(JSON.parse(archiveCalls()[0]!.body)).toEqual({ ref: "release" });
      expect(
        rows(db, "SELECT key FROM worker_state WHERE key = ?", `slot:kb-archive:${day.date}`),
      ).toHaveLength(1);
    });
  }

  it("market mode does not matter: full, data_only and off all dispatch the nightly archive", async () => {
    enable();
    for (const m of ["full", "data_only", "off"]) {
      resetClockCache();
      mode(m);
      db.prepare("DELETE FROM worker_state WHERE key LIKE 'slot:kb-archive:%'").run();
      const before = archiveCalls().length;
      const s = await tick(utc("2026-10-05", "22:15", 11));
      expect(s.dispatched, m).toContain("kb-archive");
      expect(archiveCalls().length, m).toBe(before + 1);
    }
  });

  it("the dispatch switch off (the default, or any value but 1): nothing is claimed or sent", async () => {
    for (const v of [undefined, '"0"', '""', "null"]) {
      if (v !== undefined) enable(v);
      resetClockCache();
      const s = await tick(utc("2026-10-05", "22:15", 11));
      expect(s.dispatched).toEqual([]);
    }
    expect(archiveCalls()).toHaveLength(0);
    expect(rows(db, "SELECT key FROM worker_state WHERE key LIKE 'slot:%'")).toEqual([]);
  });

  it("the shipped table (slot disabled) sends nothing even with the switch on", async () => {
    enable();
    const s = await tick(utc("2026-10-05", "22:15", 11), AU_SLOTS);
    expect(s.dispatched).not.toContain("kb-archive");
    expect(archiveCalls()).toHaveLength(0);
  });

  it("catch-up: a tick at 23:15 still dispatches once, 23:16 does not; a second tick never repeats it", async () => {
    enable();
    expect((await tick(utc("2026-10-05", "23:16", 11))).dispatched).not.toContain("kb-archive");
    expect((await tick(utc("2026-10-05", "23:15", 11))).dispatched).toContain("kb-archive");
    resetClockCache();
    expect((await tick(utc("2026-10-05", "23:15", 11))).dispatched).not.toContain("kb-archive");
    expect(archiveCalls()).toHaveLength(1);
  });

  it("a failed dispatch is retried the next minute up to the cap, as for every actions slot", async () => {
    enable();
    net.githubPlan.push(500);
    const a = await tick(utc("2026-10-05", "22:15", 11));
    expect(a.failed).toContain("kb-archive");
    resetClockCache();
    expect((await tick(utc("2026-10-05", "22:16", 11))).dispatched).toContain("kb-archive");
  });
});
