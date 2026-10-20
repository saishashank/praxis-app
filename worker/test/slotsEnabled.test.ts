// M8 T8 (decision 32): the runtime slot list `worker_state.slots_enabled`, read in the clock's single
// existing read. Absent = today's behaviour; a slot outside a present list is skipped with a recorded
// reason; an unreadable list fails safe (nothing new is dispatched, one failed run record a day).
// Nothing touches a network: GitHub and the app are local fakes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listSkip,
  parseInputs,
  parseSlotsEnabled,
  resetClockCache,
  runClock,
  type ClockEnv,
} from "../src/clock";
import { routeSlotsDue, runRoutes, type RouteEnv } from "../src/routes";
import { sydneyLocal } from "../src/localtime";
import { AU_SLOTS } from "../src/schedule";
import { TOKEN, TURSO_TOKEN, TURSO_URL, makeDb, makeNet, rows } from "./fakeTurso";

const ENV: ClockEnv = {
  PRAXIS_ENV: "production",
  GITHUB_DISPATCH_TOKEN: TOKEN,
  TURSO_MAIN_URL: TURSO_URL,
  TURSO_MAIN_TOKEN: TURSO_TOKEN,
};
const utc = (date: string, time: string, offset: number): number => {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return Date.UTC(y, mo - 1, d, h - offset, mi);
};
const MON = "2026-10-05"; // AEDT Monday
const T_ARCHIVE = utc(MON, "22:15", 11); // kb-archive (go-live slot)
const T_BACKUP = utc(MON, "23:00", 11); // backup (always on today)
const T_INGEST = utc(MON, "17:30", 11);

let db: ReturnType<typeof makeDb>;
let net: ReturnType<typeof makeNet>;
let logs: string[];

const tick = (t: number) => runClock(ENV, t, { fetch: net.f, nowMs: () => t });
const setState = (key: string, v: string | null) =>
  db
    .prepare(
      "INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, ?, 'x') " +
        "ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json",
    )
    .run(key, v);
const on = () => setState("dispatch_enabled", '"1"');
const list = (v: unknown) => setState("slots_enabled", JSON.stringify(v));
const dispatched = () => net.github.map((c) => /workflows\/([^/]+)\/dispatches/.exec(c.url)?.[1]);

beforeEach(() => {
  db = makeDb();
  net = makeNet(db);
  resetClockCache();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.join(" "));
  });
});
afterEach(() => vi.restoreAllMocks());

describe("parseSlotsEnabled / listSkip (pure)", () => {
  it("absent: no row, SQL NULL, JSON null", () => {
    expect(parseSlotsEnabled(undefined)).toEqual({ kind: "absent" });
    expect(parseSlotsEnabled(null)).toEqual({ kind: "absent" });
    expect(parseSlotsEnabled("null")).toEqual({ kind: "absent" });
  });
  it("a JSON array of ids is a list (an empty one too)", () => {
    expect(parseSlotsEnabled('["kb-archive","replay"]')).toEqual({
      kind: "list",
      ids: new Set(["kb-archive", "replay"]),
    });
    expect(parseSlotsEnabled("[]")).toEqual({ kind: "list", ids: new Set() });
  });
  it("anything else is malformed", () => {
    for (const raw of [
      "",
      "not json",
      "{}",
      '{"kb-archive":true}',
      '"kb-archive"',
      "1",
      "true",
      "[1]",
      '["a",null]',
      '["a",["b"]]',
      '[""]',
      "[" + '"x",'.repeat(101) + '"x"]',
    ]) {
      expect(parseSlotsEnabled(raw), raw).toEqual({ kind: "malformed" });
    }
  });
  it("listSkip gates only go-live slots; always-on slots ignore the list, even a malformed one", () => {
    const kb = AU_SLOTS.find((s) => s.id === "kb-archive")!;
    const backup = AU_SLOTS.find((s) => s.id === "backup")!;
    const other = { kind: "list", ids: new Set(["replay"]) } as const;
    expect(listSkip(backup)).toBeNull();
    expect(listSkip(backup, other)).toBeNull();
    expect(listSkip(backup, { kind: "list", ids: new Set() })).toBeNull();
    expect(listSkip(backup, { kind: "malformed" })).toBeNull();
    expect(listSkip(kb)).toBe("not-released");
    expect(listSkip(kb, { kind: "list", ids: new Set(["kb-archive"]) })).toBeNull();
    expect(listSkip(kb, other)).toBe("not-listed");
    expect(listSkip(kb, { kind: "malformed" })).toBe("list-malformed");
  });
  it("parseInputs accepts a small object of strings only", () => {
    expect(parseInputs('{"candidates":"google:m"}')).toEqual({ candidates: "google:m" });
    for (const raw of [undefined, "[]", "null", "1", '{"a":1}', '{"A":"x"}', "nope"]) {
      expect(parseInputs(raw), String(raw)).toBeNull();
    }
    expect(parseInputs(JSON.stringify({ candidates: "x".repeat(501) }))).toBeNull();
  });
});

describe("the clock with the runtime list", () => {
  it("absent list = today's behaviour: the old slots run, the go-live slots do not", async () => {
    on();
    expect((await tick(T_INGEST)).dispatched).toEqual(["ingest-batch1"]);
    expect((await tick(T_BACKUP)).dispatched).toEqual(["maintenance", "backup"]);
    const s = await tick(T_ARCHIVE);
    expect(s.dispatched).toEqual([]);
    expect(s.skipped).toEqual([{ id: "kb-archive", reason: "not-released" }]);
    expect(dispatched()).toEqual(["ingest-batch1.yml", "maintenance.yml", "backup.yml"]);
    expect(logs.join("\n")).not.toContain("skipped"); // the normal state is not noise
  });

  it("a NULL value and a JSON null behave like an absent list", async () => {
    on();
    for (const v of ["null"]) {
      resetClockCache();
      setState("slots_enabled", v);
      const s = await tick(T_ARCHIVE);
      expect(s.dispatched).toEqual([]);
      expect((await tick(T_BACKUP)).dispatched).toContain("backup");
      db.prepare("DELETE FROM worker_state WHERE key LIKE 'slot:%'").run();
    }
  });

  it("a listed go-live slot runs; one that is not in the list is held back, with a recorded reason", async () => {
    on();
    list(["replay"]);
    const s = await tick(T_ARCHIVE);
    expect(s.dispatched).toEqual([]);
    expect(s.skipped).toEqual([{ id: "kb-archive", reason: "not-listed" }]);
    expect(logs).toContain("clock: skipped kb-archive not-listed");
    // skipped means no claim either: nothing was written for the slot
    expect(rows(db, "SELECT key FROM worker_state WHERE key LIKE 'slot:kb-archive:%'")).toEqual([]);
    list(["kb-archive"]);
    resetClockCache();
    expect((await tick(T_ARCHIVE + 60_000)).dispatched).toEqual(["kb-archive"]);
    expect(dispatched()).toEqual(["kb-archive.yml"]);
  });

  it("a list that does not name backup, maintenance or ingest-batch1 still runs them", async () => {
    on();
    for (const l of [["kb-archive"], [], ["no-such-slot"]]) {
      list(l);
      db.prepare("DELETE FROM worker_state WHERE key LIKE 'slot:%'").run();
      resetClockCache();
      const a = await tick(T_INGEST);
      expect(a.dispatched, JSON.stringify(l)).toEqual(["ingest-batch1"]);
      resetClockCache();
      const b = await tick(T_BACKUP);
      expect(
        b.dispatched.filter((x) => x !== "kb-archive"),
        JSON.stringify(l),
      ).toEqual(["maintenance", "backup"]);
      expect(
        b.skipped.map((x) => x.id).filter((x) => x === "backup" || x === "maintenance"),
      ).toEqual([]);
    }
  });

  it("an empty list holds every go-live slot but not the always-on ones", async () => {
    on();
    list([]);
    const s = await tick(T_BACKUP);
    expect(s.dispatched).toEqual(["maintenance", "backup"]);
    expect(s.skipped).toContainEqual({ id: "kb-archive", reason: "not-listed" });
  });

  it("the dispatch kill switch still wins over a list", async () => {
    setState("dispatch_enabled", '"0"');
    list(["backup", "kb-archive"]);
    const s = await tick(T_BACKUP);
    expect(s.dispatched).toEqual([]);
    expect(net.github).toHaveLength(0);
  });

  it("ONE database read per tick is unchanged: switch, list and slot states come in one request", async () => {
    on();
    list(["backup"]);
    // a tick that dispatches nothing (slot not listed): exactly one pipeline call
    const before = net.pipelines;
    await tick(T_ARCHIVE);
    expect(net.pipelines - before).toBe(1);
    // the read is a single SELECT on worker_state that names all three kinds of key
    const read = net.calls.filter((c) => c.url.endsWith("/v2/pipeline")).at(-1)!;
    const reqs = JSON.parse(read.body).requests as {
      stmt?: { sql: string; args?: { value: string }[] };
    }[];
    const selects = reqs.filter((r) => /^\s*select/i.test(r.stmt?.sql ?? ""));
    expect(selects).toHaveLength(1);
    const keys = selects[0]!.stmt!.args!.map((a) => a.value);
    expect(keys).toEqual(
      expect.arrayContaining(["dispatch_enabled", "slots_enabled", `slot:kb-archive:${MON}`]),
    );
    // and a dispatching tick still costs read + claim + record = 3
    resetClockCache();
    const b2 = net.pipelines;
    await tick(T_BACKUP);
    expect(net.pipelines - b2).toBe(3);
  });

  it("an idle minute (no slot window open) still makes no request at all", async () => {
    on();
    list(["backup"]);
    await tick(utc(MON, "03:00", 11)); // first call of the day: the rollup only
    const before = net.pipelines;
    await tick(utc(MON, "03:01", 11));
    expect(net.pipelines).toBe(before);
  });

  describe("a malformed list fails safe: go-live slots held, always-on slots unaffected", () => {
    for (const raw of ["not json", "{}", '"backup"', "[1]", ""]) {
      it(`${JSON.stringify(raw)}: backup and maintenance still run, kb-archive is held and why is recorded`, async () => {
        on();
        setState("slots_enabled", raw);
        const s = await tick(T_BACKUP);
        expect(s.dispatched).toEqual(["maintenance", "backup"]);
        expect(s.failed).toEqual([]);
        expect(s.skipped).toEqual([{ id: "kb-archive", reason: "list-malformed" }]);
        expect(dispatched()).toEqual(["maintenance.yml", "backup.yml"]);
        expect(logs).toContain("clock: skipped kb-archive list-malformed");
        expect(
          rows(db, "SELECT key FROM worker_state WHERE key LIKE 'slot:%' ORDER BY key").map(
            (r) => r.key,
          ),
        ).toEqual([`slot:backup:${MON}`, `slot:maintenance:${MON}`]);
        const rec = rows(
          db,
          "SELECT status, error_summary FROM run_record WHERE job = 'worker-clock' AND status = 'failed'",
        );
        expect(rec).toHaveLength(1);
        expect(String(rec[0]!.error_summary)).toContain("slots_enabled");
      });
    }

    it("the record is written once per local day, however many ticks see it", async () => {
      on();
      setState("slots_enabled", "oops");
      for (const t of [T_BACKUP, T_BACKUP + 60_000, T_BACKUP + 120_000]) await tick(t);
      expect(
        rows(db, "SELECT id FROM run_record WHERE concurrency_key = ?", `slots-malformed:${MON}`),
      ).toHaveLength(1);
      expect(dispatched()).toEqual(["maintenance.yml", "backup.yml"]); // once each, no go-live slot
    });

    it("retries of a failed always-on dispatch continue; a held go-live slot never starts", async () => {
      on();
      net.githubPlan.push(500);
      expect((await tick(T_BACKUP)).failed).toEqual(["maintenance"]);
      setState("slots_enabled", "oops");
      resetClockCache();
      expect((await tick(T_BACKUP + 60_000)).dispatched).toEqual(["maintenance"]);
      expect(dispatched()).not.toContain("kb-archive.yml");
    });

    it("fixing the list releases the held go-live slot", async () => {
      on();
      setState("slots_enabled", "oops");
      await tick(T_BACKUP);
      list(["kb-archive"]);
      resetClockCache();
      expect((await tick(T_BACKUP + 60_000)).dispatched).toEqual(["kb-archive"]);
    });

    it("with the kill switch off nothing is even recorded", async () => {
      setState("slots_enabled", "oops");
      await tick(T_BACKUP);
      expect(rows(db, "SELECT id FROM run_record WHERE status = 'failed'")).toEqual([]);
    });
  });
});

describe("the route runner with the runtime list", () => {
  const APP = "https://praxis-app.example.test";
  const RENV: RouteEnv = {
    PRAXIS_ENV: "production",
    TURSO_MAIN_URL: TURSO_URL,
    TURSO_MAIN_TOKEN: TURSO_TOKEN,
    APP_BASE_URL: APP,
    WORKER_HMAC_SECRET: "7".repeat(64),
  };
  let posts: string[];
  let f: typeof fetch;
  beforeEach(() => {
    posts = [];
    f = (async (i: string | URL | Request, init?: RequestInit) => {
      const url = String(i);
      if (url.startsWith(APP)) {
        posts.push(JSON.parse(String(init?.body)).slot);
        return new Response("{}", { status: 200 });
      }
      return net.f(i, init);
    }) as typeof fetch;
  });
  const T_MORNING = utc(MON, "08:00", 11);
  const run = (t: number) => runRoutes(RENV, t, { fetch: f, nowMs: () => t });

  it("the shipped route slots are available but held (absent list = off)", async () => {
    on();
    expect(routeSlotsDue(sydneyLocal(T_MORNING)).map((s) => s.id)).toContain("morning");
    await run(T_MORNING);
    expect(posts).toEqual([]);
  });
  it("listed: posts; another list: does not; malformed: does not", async () => {
    on();
    list(["morning"]);
    await run(T_MORNING);
    expect(posts).toEqual(["morning"]);
    posts.length = 0;
    db.prepare("DELETE FROM worker_state WHERE key LIKE 'slot:%'").run();
    list(["evening-review"]);
    await run(T_MORNING);
    expect(posts).toEqual([]);
    setState("slots_enabled", "oops");
    await run(T_MORNING);
    expect(posts).toEqual([]);
  });
  it("still ONE read per tick: the list rides in the existing single SELECT", async () => {
    on();
    list(["evening-review"]);
    const before = net.pipelines;
    await run(T_MORNING);
    expect(net.pipelines - before).toBe(1);
  });
});
