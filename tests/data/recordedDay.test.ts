// @vitest-environment node
// M8 T9 (decision 31, NFR-040, AT-28 staging isolation): the recorded-day mapper, reader and host
// guard. Everything is invented (SEC-110): fake codes, formula prices, placeholder text.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BLOCKED_HOST_SUFFIXES,
  BlockedHostError,
  RecordedDayError,
  alignDates,
  assertAllowedRequest,
  dayDiff,
  guardFetch,
  installHostGuard,
  isBlockedHost,
  readRecordedDay,
  redateDay,
  weekdaysBetween,
} from "@/lib/data/recorded/index.mjs";

// A small deterministic PRNG (mulberry32) so the property test is reproducible.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const DATE_FIELDS = ["date", "fetched_at", "published_at"];

function makeDay(seed: number) {
  const r = rng(seed);
  const pick = (n: number) => Math.floor(r() * n);
  const k = 1 + pick(4);
  const base = Date.UTC(2025, 2, 3) + pick(300) * 86_400_000;
  const dates = Array.from({ length: k }, (_, i) => iso(base + i * 86_400_000 * (1 + pick(3))));
  const sorted = [...new Set(dates)].sort();
  const bars: Record<string, unknown>[] = [];
  for (const d of sorted) {
    for (let c = 0; c < 1 + pick(4); c++) {
      bars.push({
        code: `ZZ${c}`,
        date: d,
        open: Math.round(r() * 1e4) / 100,
        close: Math.round(r() * 1e4) / 100,
        volume: pick(1e6),
        note: `text ${pick(1000)} ${d}`, // a text that contains a date must stay untouched
        fetched_at: `${d}T0${pick(9)}:${10 + pick(49)}:00.000Z`,
        published_at: pick(2) ? null : `${d}T21:30:00.000Z`,
      });
    }
  }
  const lastDate = sorted[sorted.length - 1]!;
  return {
    bars,
    index: sorted.map((d) => ({
      code: "AXJO",
      date: d,
      close: 1000 + pick(100),
      fetched_at: `${d}T08:00:00Z`,
    })),
    short: {
      stopped: null,
      dates: 1,
      rows: [{ code: "ZZ0", as_of: lastDate, short_positions: 5, total_in_issue: 100 }],
    },
    announcements: [
      { date: lastDate, published_at: `${lastDate}T01:02:03Z`, headline: `headline ${lastDate}` },
    ],
    corporateActions: [{ ex_date: lastDate, record_date: lastDate, kind: "dividend", amount: 0.1 }],
  };
}

function makeTargets(seed: number) {
  const r = rng(seed ^ 0x9e3779b9);
  const m = 1 + Math.floor(r() * 5);
  const start = Date.UTC(2026, 9, 1) + Math.floor(r() * 40) * 86_400_000;
  return Array.from({ length: m }, (_, i) => iso(start + i * 86_400_000));
}

const stripDates = (row: Record<string, unknown>) => {
  const o: Record<string, unknown> = { ...row };
  for (const f of DATE_FIELDS)
    if (f in o) o[f] = typeof o[f] === "string" ? String(o[f]).slice(10) : o[f];
  return o;
};

describe("redateDay (property, 300 seeded days)", () => {
  it("keeps every field but the dates, keeps session order, is deterministic and pure", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const day = makeDay(seed);
      const before = structuredClone(day);
      const targets = makeTargets(seed);
      const shortDates = [targets[targets.length - 1]!];
      const a = redateDay(day, { sessionDates: targets, shortDates });
      const b = redateDay(day, { sessionDates: targets, shortDates });
      expect(a).toEqual(b); // deterministic
      expect(day).toEqual(before); // input never mutated

      // Rows only ever disappear from the OLDEST recorded sessions, in order.
      const recorded = [...new Set(day.bars.map((x) => String(x.date)))].sort();
      const keep = Math.min(recorded.length, targets.length);
      const kept = day.bars.filter((x) =>
        recorded.slice(recorded.length - keep).includes(String(x.date)),
      );
      expect(a.bars).toHaveLength(kept.length);
      expect(a.report.sessionsKept).toBe(keep);

      kept.forEach((src, i) => {
        const out = a.bars[i] as Record<string, unknown>;
        // every non-date field is identical, texts included
        expect(stripDates(out)).toEqual(stripDates(src));
        expect(out.note).toBe(src.note);
        // time of day of the timestamps is kept
        expect(String(out.fetched_at).slice(10)).toBe(String(src.fetched_at).slice(10));
        // only run dates appear
        expect(targets).toContain(out.date);
      });
      // session order: equal recorded dates -> equal run date; earlier -> strictly earlier
      for (let i = 0; i < kept.length; i++) {
        for (let j = i + 1; j < kept.length; j++) {
          const di = String(kept[i]!.date);
          const dj = String(kept[j]!.date);
          const mi = String((a.bars[i] as Record<string, unknown>).date);
          const mj = String((a.bars[j] as Record<string, unknown>).date);
          if (di === dj) expect(mi).toBe(mj);
          else if (di < dj) expect(mi < mj).toBe(true);
          else expect(mi > mj).toBe(true);
        }
      }
      // the newest recorded session lands on the newest run date
      expect((a.bars[a.bars.length - 1] as Record<string, unknown>).date).toBe(
        targets[targets.length - 1],
      );
      // short, announcements and actions: dates moved, the rest untouched
      expect(a.short?.rows[0]).toMatchObject({
        code: "ZZ0",
        short_positions: 5,
        total_in_issue: 100,
      });
      expect(a.short?.rows[0]?.as_of).toBe(shortDates[0]);
      expect(a.announcements[0]?.headline).toBe(day.announcements[0]!.headline);
      expect(a.corporateActions[0]).toMatchObject({ kind: "dividend", amount: 0.1 });
    }
  });
});

describe("alignDates and weekdaysBetween", () => {
  it("aligns the newest to the newest and drops the oldest when there are too many sessions", () => {
    const { map, dropped } = alignDates(
      ["2025-01-06", "2025-01-07", "2025-01-08"],
      ["2026-10-20", "2026-10-21"],
    );
    expect([...map]).toEqual([
      ["2025-01-08", "2026-10-21"],
      ["2025-01-07", "2026-10-20"],
    ]);
    expect(dropped).toEqual(["2025-01-06"]);
  });
  it("rejects a bad date and an empty target", () => {
    expect(() => alignDates(["2025-13-01"], ["2026-10-21"])).toThrow();
    expect(() => alignDates(["2025-01-06"], [])).toThrow();
  });
  it("lists weekdays inclusive and refuses a long or reversed range", () => {
    expect(weekdaysBetween("2026-10-16", "2026-10-20")).toEqual([
      "2026-10-16",
      "2026-10-19",
      "2026-10-20",
    ]);
    expect(() => weekdaysBetween("2026-10-20", "2026-10-16")).toThrow();
    expect(() => weekdaysBetween("2020-01-01", "2026-10-16")).toThrow();
    expect(dayDiff("2026-10-16", "2026-10-20")).toBe(4);
  });
});

describe("readRecordedDay", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  function fixtures(files: Record<string, unknown>, date = "2025-05-02") {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "praxis-rec-"));
    dirs.push(dir);
    const folder = path.join(dir, "recorded", "au", date);
    fs.mkdirSync(folder, { recursive: true });
    for (const [n, v] of Object.entries(files))
      fs.writeFileSync(path.join(folder, n), JSON.stringify(v));
    return dir;
  }

  it("reads the required and optional files, newest day by default", () => {
    const dir = fixtures({
      "bars.json": [{ code: "ZZ0", date: "2025-05-02" }],
      "short.json": { rows: [] },
    });
    fs.mkdirSync(path.join(dir, "recorded", "au", "2025-04-01"), { recursive: true });
    const day = readRecordedDay(dir);
    expect(day.date).toBe("2025-05-02");
    expect(day.bars).toHaveLength(1);
    expect(day.short).toEqual({ rows: [] });
    expect(day.index).toEqual([]);
    expect(day.announcements).toEqual([]);
  });
  it("fails with a fixed code and never a path or content", () => {
    const check = (fn: () => unknown, code: string) => {
      try {
        fn();
        throw new Error("did not throw");
      } catch (e) {
        expect(e).toBeInstanceOf(RecordedDayError);
        expect((e as RecordedDayError).message).toBe(code);
      }
    };
    check(() => readRecordedDay(path.join(os.tmpdir(), "praxis-no-such-dir")), "no_recorded_root");
    check(() => readRecordedDay(fixtures({})), "missing_file");
    check(() => readRecordedDay(fixtures({ "bars.json": [] })), "empty_bars");
    check(() => readRecordedDay(fixtures({ "bars.json": { not: "array" } })), "bad_bars");
    check(
      () => readRecordedDay(fixtures({ "bars.json": [{ a: 1 }], "short.json": [] })),
      "bad_short",
    );
    check(
      () => readRecordedDay(fixtures({ "bars.json": [{ a: 1 }] }), { date: "../x" } as never),
      "bad_date",
    );
  });
});

describe("host guard (NFR-040: no ASX or Yahoo on staging)", () => {
  const staging = { PRAXIS_ENV: "staging" };
  const blocked = [
    "https://finance.yahoo.com/quote/ZZZ.AX",
    "https://query1.finance.yahoo.com/v8/finance/chart/ZZZ.AX",
    "https://query2.finance.yahoo.com/x",
    "https://fc.yahoo.com/",
    "https://www.asx.com.au/asx/v2/statistics/prevBusDayAnns.do",
    "https://asx.com.au/",
    "https://asx.api.markitdigital.com.asx.com.au/x",
    "https://s.yimg.com/x",
    "https://YAHOO.COM./x",
    "not a url",
  ];

  it("lists the host families", () => {
    expect(BLOCKED_HOST_SUFFIXES).toEqual(expect.arrayContaining(["asx.com.au", "yahoo.com"]));
    expect(isBlockedHost("notyahoo.com")).toBe(false);
    expect(isBlockedHost("asx.com.au.example.org")).toBe(false);
    expect(isBlockedHost("www.asic.gov.au")).toBe(false);
  });
  it.each(blocked)("blocks %s on staging before any request is made", async (url) => {
    let calls = 0;
    const g = guardFetch(
      (async () => {
        calls++;
        return new Response("x");
      }) as typeof fetch,
      staging,
    );
    await expect(g(url)).rejects.toBeInstanceOf(BlockedHostError);
    expect(calls).toBe(0);
    expect(() => assertAllowedRequest({ url }, staging)).toThrow(BlockedHostError);
  });
  it("lets other hosts through on staging, and everything through outside staging", async () => {
    const ok = guardFetch((async () => new Response("ok")) as typeof fetch, staging);
    expect(await (await ok("https://api.github.com/x")).text()).toBe("ok");
    const prod = guardFetch((async () => new Response("ok")) as typeof fetch, {
      PRAXIS_ENV: "production",
    });
    expect(await (await prod("https://finance.yahoo.com/x")).text()).toBe("ok");
  });
  it("installHostGuard guards the target and undo restores it", async () => {
    const calls: string[] = [];
    const target = {
      fetch: (async (u: unknown) => (calls.push(String(u)), new Response("ok"))) as typeof fetch,
    };
    const original = target.fetch;
    const undo = installHostGuard(staging, target);
    await expect(target.fetch("https://finance.yahoo.com/x")).rejects.toThrow("blocked");
    expect(calls).toEqual([]);
    await target.fetch("https://api.github.com/x");
    expect(calls).toEqual(["https://api.github.com/x"]);
    undo();
    expect(target.fetch).toBe(original);
  });
  it("the error never carries the URL", async () => {
    try {
      assertAllowedRequest("https://finance.yahoo.com/secret-path?token=abc", staging);
    } catch (e) {
      expect(String((e as Error).message)).not.toMatch(/yahoo|secret|token/);
    }
  });
});
