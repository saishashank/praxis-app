// @vitest-environment node
// A2 short-interest delta (M4 T6; DAT-125a, F6 class (d); design 2.5): the 10-session fall of at
// least short_drop_pp x 10,000 ppm, missing values are "unknown" (not false, not 0), only points
// usable at the cut-off are read. Synthetic data only.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60000 });
import { buildAgentParams, defaultAgentParams } from "@/lib/agents/params";
import { CONFIG_KEYS } from "@/lib/config/keys";
import { shortInterestDelta, shortInterestFor } from "@/lib/agents/shortInterest";
import {
  createDecisionView,
  decisionCutoffUtc,
  type ShortInterestPoint,
} from "@/lib/agents/decisionView";
import type { CalendarRow } from "@/lib/data/calendar";
import { addDays, isWeekend } from "@/lib/data/calendar";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const p = defaultAgentParams();
const calendar: CalendarRow[] = [];

/** Weekday as_of dates ending at `last`, oldest first. */
function weekdays(last: string, n: number): string[] {
  const out: string[] = [];
  let d = last;
  while (out.length < n) {
    if (!isWeekend(d)) out.unshift(d);
    d = addDays(d, -1);
  }
  return out;
}

const point = (as_of: string, short_ppm: number): ShortInterestPoint => ({
  as_of,
  short_ppm,
  published_at: `${as_of}T06:00:00.000Z`,
});

function series(last: string, prior: number, latest: number): ShortInterestPoint[] {
  const days = weekdays(last, p.windows.shortInterest + 1); // 11 points: latest and 10 sessions earlier
  return days.map((d, i) => point(d, i === 0 ? prior : i === days.length - 1 ? latest : prior));
}

describe("A2 short-interest delta (pure)", () => {
  it("10-session window and 2 pp come from AgentParams", () => {
    expect(p.windows.shortInterest).toBe(10);
    expect(p.f6.shortDropPp).toEqual({ num: 2n, den: 1n });
  });

  it("a fall of exactly 2 pp (20,000 ppm) counts (<=)", () => {
    const r = shortInterestDelta(series("2026-10-15", 50000, 30000), calendar, p);
    expect(r.delta_ppm).toBe(-20000);
    expect(r.drop).toBe(true);
    expect(r.latest_as_of).toBe("2026-10-15");
    expect(r.prior_as_of).toBe("2026-10-01");
  });

  it("a fall of 19,999 ppm does not count; a rise does not count", () => {
    expect(shortInterestDelta(series("2026-10-15", 50000, 30001), calendar, p).drop).toBe(false);
    expect(shortInterestDelta(series("2026-10-15", 50000, 60000), calendar, p).drop).toBe(false);
  });

  it("missing prior value is unknown, not false and not 0", () => {
    const pts = series("2026-10-15", 50000, 30000).slice(1); // drop the earliest (the prior)
    const r = shortInterestDelta(pts, calendar, p);
    expect(r.drop).toBe("unknown");
    expect(r.delta_ppm).toBeNull();
    expect(r.prior_ppm).toBeNull();
  });

  it("no points at all is unknown", () => {
    const r = shortInterestDelta([], calendar, p);
    expect(r.drop).toBe("unknown");
    expect(r.delta_ppm).toBeNull();
    expect(r.latest_as_of).toBeNull();
  });

  it("the threshold follows the config key", () => {
    const strict = buildAgentParams((k) => (k === "f6_short_drop_pp" ? 4 : CONFIG_KEYS[k].default));
    const r = shortInterestDelta(series("2026-10-15", 50000, 30000), calendar, strict);
    expect(r.drop).toBe(false); // 2 pp fall < 4 pp
  });

  it("is independent of input order", () => {
    const pts = series("2026-10-15", 50000, 30000);
    expect(shortInterestDelta([...pts].reverse(), calendar, p)).toEqual(
      shortInterestDelta(pts, calendar, p),
    );
  });
});

const D = "2026-10-15";
const CUTOFF = decisionCutoffUtc(D, p.decisionCutoff);

async function load(points: { as_of: string; ppm: number; published?: string }[]) {
  const c = await freshDb("main");
  await c.batch(
    points.map((x) => ({
      sql: `INSERT INTO short_interest (market, code, as_of, short_ppm, published_at, ingested_at, assumed_time, source)
            VALUES ('AU', 'AAA', ?, ?, ?, ?, 0, 'test')`,
      args: [x.as_of, x.ppm, x.published ?? `${x.as_of}T06:00:00.000Z`, `${x.as_of}T06:05:00.000Z`],
    })),
  );
  return createDecisionView(c, { market: "AU", d: D, cutoff: CUTOFF });
}

describe("A2 short-interest delta (DB reader)", () => {
  it("reads the usable points only: later as_of and post-cut-off publications are ignored", async () => {
    const base = series("2026-10-15", 50000, 30000).map((x) => ({
      as_of: x.as_of,
      ppm: x.short_ppm,
    }));
    const view = await load([
      ...base,
      { as_of: "2026-10-16", ppm: 1 }, // as_of after D
    ]);
    const r = await shortInterestFor(view, "AAA", p, calendar);
    expect(r.latest_as_of).toBe("2026-10-15");
    expect(r.delta_ppm).toBe(-20000);
    expect(r.drop).toBe(true);
  });

  it("a point published after the cut-off hides the latest as_of (older point becomes latest)", async () => {
    const days = weekdays("2026-10-15", 12);
    const view = await load(
      days.map((d, i) => ({
        as_of: d,
        ppm: 50000,
        published: i === days.length - 1 ? "2026-10-15T07:30:00.000Z" : undefined,
      })),
    );
    const r = await shortInterestFor(view, "AAA", p, calendar);
    expect(r.latest_as_of).toBe("2026-10-14");
    expect(r.drop).toBe(false);
  });

  it("a view cannot be asked for the future", async () => {
    const view = await load([]);
    expect(() => view.checkDate("2026-10-16")).toThrow(/look-ahead/);
  });
});
