// @vitest-environment node
// The CXA-004 trigger (M23 T2; D-1635, D-1690...D-1694): the angle list is pinned, the plan file and the code constants
// agree, the session counter is hand-counted, 251 sessions give no look and no outcome read, 252 give one look per angle,
// a later night gives no second look, and the pure engine finds a planted angle and not noise. Synthetic ZZ data only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ANNOUNCEMENT_ANGLES, announcementAngleDefs } from "@/lib/cortex/angles/announcementSet";
import {
  ANN_BLOCK_SESSIONS,
  ANN_DEV_DEN,
  ANN_DEV_NUM,
  ANN_LABEL_COVERAGE_DEN,
  ANN_LABEL_COVERAGE_NUM,
  ANN_LABEL_KEYS,
  ANN_LABELS_LINEAGE,
  ANN_METER_LINEAGE,
  ANN_MIN_CODES,
  ANN_PLAN_PATH,
  ANN_Q,
  ANN_REPLICATES,
  ANN_SESSION_FLOOR,
  annAngleLineage,
  annFamilyLook,
  developmentCount,
  labelsCovered,
  labelsVerdict,
  projectDate,
  type PanelReader,
} from "@/lib/research/lineages/annAngles";
import { runAnnCalibration } from "@/lib/research/steps/annCalibration";
import { sha256Hex } from "@/lib/research/registry";
import { allowMarket, cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const ROOT = join(__dirname, "../..");
const planText = readFileSync(join(ROOT, ANN_PLAN_PATH), "utf8").replace(/\r\n/g, "\n");
const plan = JSON.parse(planText) as Record<string, unknown>;
const io = { read: (p: string) => (p === ANN_PLAN_PATH ? planText : null) };

const PINNED = [
  "A-D3-01",
  "A-D3-02",
  "A-D3-03",
  "A-D3-04",
  "A-D3-05",
  "A-D3-06",
  "A-D3-07",
  "A-D3-08",
  "A-D3-09",
  "A-D3-10",
  "A-D4-04",
  "A-D5-10",
  "A-D6-02",
  "A-D6-06",
  "A-D6-07",
  "A-D6-08",
  "A-D8-04",
  "A-D8-06",
  "A-D9-02",
  "A-D9-03",
  "A-D10-05",
  "A-D10-06",
];

/** The weekdays from 2029-01-01, oldest first (no holidays): the sessions of the fixture. */
function weekdays(count: number): string[] {
  const out: string[] = [];
  const day = new Date("2029-01-01T00:00:00Z");
  while (out.length < count) {
    const w = day.getUTCDay();
    if (w !== 0 && w !== 6) out.push(day.toISOString().slice(0, 10));
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return out;
}

describe("the announcement angle set and the frozen plan", () => {
  it("is the 22 registry angles that name the archive and read announcements, pinned by id and count (K3)", () => {
    expect([...ANNOUNCEMENT_ANGLES]).toEqual(PINNED);
    expect(ANNOUNCEMENT_ANGLES).toHaveLength(22);
    // the index-change gate names the archive but reads no announcement: left out
    expect(ANNOUNCEMENT_ANGLES).not.toContain("A-D8-05");
    expect(announcementAngleDefs().every((a) => a.inputs.includes("announcement"))).toBe(true);
    expect(plan.angles).toEqual(PINNED);
  });

  it("the plan file and the code constants say the same thing", () => {
    expect(plan.floor_sessions).toBe(ANN_SESSION_FLOOR);
    expect(plan.development_share).toBe(ANN_DEV_NUM / ANN_DEV_DEN);
    expect(plan.min_codes).toBe(ANN_MIN_CODES);
    expect(plan.block_sessions).toBe(ANN_BLOCK_SESSIONS);
    expect(plan.horizon_sessions).toBe(ANN_BLOCK_SESSIONS);
    expect(plan.replicates).toBe(ANN_REPLICATES);
    expect(plan.q).toBe(ANN_Q);
    expect(plan.label_coverage_share).toBe(ANN_LABEL_COVERAGE_NUM / ANN_LABEL_COVERAGE_DEN);
    expect(plan.labels_lineage).toBe(ANN_LABELS_LINEAGE);
    expect(plan.meter_lineage).toBe(ANN_METER_LINEAGE);
    expect(plan.angle_lineage).toBe("ann_angle_<angle id>");
    expect(ANN_LABEL_KEYS).toEqual(["guidance", "event_confirm", "tone"]);
    expect(annAngleLineage("A-D3-01")).toBe("ann_angle_A-D3-01");
    expect(planText.length).toBeLessThanOrEqual(8000); // the research_prereg length check
  });

  it("the committed ledger freezes this exact file for every lineage", () => {
    const ledger = JSON.parse(readFileSync(join(ROOT, "docs/research/registry.json"), "utf8")) as {
      entries: {
        item: string;
        lineage: string;
        sha: string;
        preregPath: string;
        verdict?: string;
      }[];
    };
    const mine = ledger.entries.filter((e) => e.item === "CXA-004");
    expect(mine.map((e) => e.lineage).sort()).toEqual(
      [...PINNED.map(annAngleLineage), ANN_LABELS_LINEAGE].sort(),
    );
    for (const e of mine) {
      expect(e.sha).toBe(sha256Hex(planText));
      expect(e.preregPath).toBe(ANN_PLAN_PATH);
      expect(e.verdict).toBeUndefined(); // plan only: no look is recorded from outside
    }
  });
});

describe("counts and splits", () => {
  it("development is the integer part of 70 % of the sessions", () => {
    expect(developmentCount(252)).toBe(176);
    expect(developmentCount(251)).toBe(175);
    expect(developmentCount(10)).toBe(7);
  });

  it("labels need at least 70 % of the holdout announcements labelled, in integers", () => {
    expect(labelsCovered(70, 100)).toBe(true);
    expect(labelsCovered(69, 100)).toBe(false);
    expect(labelsCovered(0, 0)).toBe(false);
  });

  it("projects the date by weekdays and closed days", () => {
    // Friday 2030-01-04, two sessions to go at half a session a night: four sessions ahead
    expect(projectDate("2030-01-04", 2, 0.5, new Set())).toBe("2030-01-10");
    expect(projectDate("2030-01-04", 2, 0.5, new Set(["2030-01-08"]))).toBe("2030-01-11");
    expect(projectDate("2030-01-04", 2, 0, new Set())).toBeNull();
    expect(projectDate("2030-01-04", 0, 1, new Set())).toBeNull();
  });
});

/** A reader: `planted` keys correlate with the outcome (sign +1 or -1), the rest are noise from a seeded stream. */
function panelOf(
  planted: Record<string, 1 | -1>,
  spy?: () => void,
  flip?: { key: string; from: string },
): PanelReader {
  const noise = (key: string, d: string, i: number): number => {
    let h = 2166136261;
    for (const ch of `${key}|${d}|${i}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296 - 0.5;
  };
  return (key, d) => {
    spy?.();
    const scores: number[] = [];
    const outcomes: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      scores.push(i);
      const base = planted[key];
      const sign = base !== undefined && flip?.key === key && d >= flip.from ? -base : base;
      outcomes.push(
        sign === undefined ? noise(key, d, i) : sign * (i + 3 * noise(key, d, i + 100)),
      );
    }
    return { scores, outcomes };
  };
}

describe("the pure engine", () => {
  const sessions252 = weekdays(252);

  it("251 sessions: below sample, and the reader is never called", () => {
    const spy = vi.fn();
    const r = annFamilyLook(weekdays(251), PINNED, panelOf({}, spy));
    expect(r.status).toBe("below_sample");
    expect(spy).not.toHaveBeenCalled();
  });

  it("252 sessions: a planted angle (either sign) passes; one that reverses in the holdout does not; the family is the 22", () => {
    const flip = { key: "A-D3-02", from: sessions252[176]! };
    const r = annFamilyLook(
      sessions252,
      PINNED,
      panelOf({ "A-D3-01": 1, "A-D6-07": -1, "A-D3-02": 1 }, undefined, flip),
      { replicates: 400 },
    );
    expect(r.status).toBe("looked");
    if (r.status !== "looked") return;
    expect(r.devSessions).toBe(176);
    expect(r.holdSessions).toBe(76);
    expect(r.familySize).toBe(22);
    const by = new Map(r.results.map((x) => [x.key, x]));
    expect(by.get("A-D3-01")!.verdict).toBe("PASS");
    expect(by.get("A-D3-01")!.sign).toBe(1);
    expect(by.get("A-D6-07")!.verdict).toBe("PASS");
    expect(by.get("A-D6-07")!.sign).toBe(-1);
    // a sign fixed in development on a relation that reverses in the holdout is a loss there: NULL
    expect(by.get("A-D3-02")!.sign).toBe(1);
    expect(by.get("A-D3-02")!.holdMean!).toBeLessThan(0);
    expect(by.get("A-D3-02")!.verdict).toBe("NULL");
    // every PASS was rejected under the false-discovery level and has a holdout mean above zero
    for (const x of r.results.filter((y) => y.verdict === "PASS")) {
      expect(x.rejected).toBe(true);
      expect(x.holdMean!).toBeGreaterThan(0);
    }
  });

  it("a key with no readings is INCONCLUSIVE and outside the family; the same input gives the same bytes", () => {
    const read: PanelReader = (key, d) =>
      key === "A-D3-02" ? null : panelOf({ "A-D3-01": 1 })(key, d);
    const a = annFamilyLook(sessions252, ["A-D3-01", "A-D3-02", "A-D3-03"], read, {
      replicates: 300,
    });
    const b = annFamilyLook(sessions252, ["A-D3-01", "A-D3-02", "A-D3-03"], read, {
      replicates: 300,
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    if (a.status !== "looked") throw new Error("expected a look");
    expect(a.familySize).toBe(2);
    expect(a.results.find((x) => x.key === "A-D3-02")!.verdict).toBe("INCONCLUSIVE");
  });

  it("the labels verdict: PASS if one passes, NULL if one was tested, else INCONCLUSIVE", () => {
    const k = (verdict: "PASS" | "NULL" | "INCONCLUSIVE") =>
      ({ verdict }) as unknown as Parameters<typeof labelsVerdict>[0][number];
    expect(labelsVerdict([k("NULL"), k("PASS")])).toBe("PASS");
    expect(labelsVerdict([k("NULL"), k("INCONCLUSIVE")])).toBe("NULL");
    expect(labelsVerdict([k("INCONCLUSIVE")])).toBe("INCONCLUSIVE");
  });
});

/** Archive rows for the given sessions: 1 to 3 timed items each. */
async function plantArchive(db: Client, market: string, days: readonly string[]): Promise<void> {
  const rows = days.flatMap((d, i) =>
    Array.from({ length: (i % 3) + 1 }, (_, k) => ({
      sql: `INSERT INTO announcement_archive (market, code, source, ann_id, published_at, known_at, session_d, timing, type, price_sensitive, title)
            VALUES (?, 'ZA', 'test', ?, ?, ?, ?, ?, NULL, 0, 'x')`,
      args: [
        market,
        `${market}-${d}-${k}`,
        `${d}T01:00:00Z`,
        `${d}T02:00:00Z`,
        d,
        ["pre_open", "intraday", "post_close"][k]!,
      ],
    })),
  );
  for (let i = 0; i < rows.length; i += 500) await db.batch(rows.slice(i, i + 500), "write");
}

const count = async (db: Client, sql: string): Promise<number> =>
  Number((await db.execute(sql)).rows[0]!.n);

describe("the trigger on a database (ZZ)", () => {
  const days = weekdays(253);
  const at = (d: string) => ({ market: "ZZ", d, now: `${d}T12:00:00Z` });

  it("counts distinct sessions by hand: other markets, later dates and repeats are not counted", async () => {
    const db = await freshDb("main");
    await allowMarket(db, "ZZ");
    await allowMarket(db, "YY");
    // 30 sessions with items (1 to 3 items each), a gap of two empty weekdays, and 5 items of another market
    const mine = days.slice(0, 20).concat(days.slice(22, 32));
    await plantArchive(db, "ZZ", mine);
    await plantArchive(db, "YY", days.slice(0, 5));
    const out = await runAnnCalibration(db, at(days[31]!), { io });
    expect(out.n).toBe(30);
    expect(out.status).toBe("collecting");
    // a session after the night is not counted by the night before it
    await plantArchive(db, "ZZ", [days[40]!]);
    const again = await runAnnCalibration(db, at(days[35]!), { io });
    expect(again.n).toBe(30);
    const later = await runAnnCalibration(db, at(days[41]!), { io });
    expect(later.n).toBe(31);
  });

  it("251 sessions: a meter row 'collecting', the plan frozen for 23 lineages, no look, no panel read, nothing spent", async () => {
    const db = await freshDb("main");
    await allowMarket(db, "ZZ");
    await plantArchive(db, "ZZ", days.slice(0, 251));
    const panel = vi.fn(async () => panelOf({}));
    const out = await runAnnCalibration(db, at(days[250]!), { io, panel });
    expect(out).toMatchObject({ n: 251, status: "collecting", looked: 0 });
    expect(panel).not.toHaveBeenCalled();
    const m = (
      await db.execute(
        "SELECT n, target, status, projected_d FROM research_meter WHERE market = 'ZZ'",
      )
    ).rows;
    expect(m).toHaveLength(1);
    expect([Number(m[0]!.n), Number(m[0]!.target), String(m[0]!.status)]).toEqual([
      251,
      252,
      "collecting",
    ]);
    expect(await count(db, "SELECT COUNT(*) n FROM research_prereg WHERE item = 'CXA-004'")).toBe(
      23,
    );
    expect(await count(db, "SELECT COUNT(*) n FROM holdout_look")).toBe(0);
    expect(await count(db, "SELECT COUNT(*) n FROM research_result")).toBe(0);
    expect(await count(db, "SELECT COUNT(*) n FROM holdout_look_refusal")).toBe(0);
  });

  it("252 sessions: one look per angle; a second night takes no second look and writes no refusal", async () => {
    const db = await freshDb("main");
    await allowMarket(db, "ZZ");
    await plantArchive(db, "ZZ", days.slice(0, 252));
    await runAnnCalibration(db, at(days[250]!), { io });
    const reads = vi.fn();
    const panel = vi.fn(async () => panelOf({ "A-D3-01": 1 }, reads));
    const lookCoverage = vi.fn(async () => ({ labelled: 0, items: 100 }));
    const out = await runAnnCalibration(db, at(days[251]!), {
      io,
      panel,
      labelCoverage: lookCoverage,
    });
    expect(out).toMatchObject({ n: 252, status: "looked", looked: 22 });
    expect(panel).toHaveBeenCalledTimes(1);
    expect(await count(db, "SELECT COUNT(*) n FROM holdout_look")).toBe(22);
    expect(await count(db, "SELECT COUNT(*) n FROM research_result")).toBe(22);
    const verdicts = (
      await db.execute("SELECT lineage, verdict FROM holdout_look ORDER BY lineage")
    ).rows;
    expect(verdicts.find((r) => String(r.lineage) === "ann_angle_A-D3-01")!.verdict).toBe("PASS");
    // the labels are INCONCLUSIVE without a look when too few announcements carry a label
    expect(
      await count(
        db,
        `SELECT COUNT(*) n FROM holdout_look WHERE lineage = '${ANN_LABELS_LINEAGE}'`,
      ),
    ).toBe(0);
    // a result row holds aggregates only
    const stats = String(
      (await db.execute("SELECT stats_json FROM research_result LIMIT 1")).rows[0]!.stats_json,
    );
    expect(stats).not.toMatch(/ZA|title|http/);
    // the next night: nothing more
    const readsBefore = reads.mock.calls.length;
    const next = await runAnnCalibration(db, at(days[252]!), {
      io,
      panel,
      labelCoverage: lookCoverage,
    });
    expect(next).toMatchObject({ status: "looked", looked: 22 });
    expect(panel).toHaveBeenCalledTimes(1);
    expect(reads.mock.calls.length).toBe(readsBefore);
    expect(await count(db, "SELECT COUNT(*) n FROM holdout_look")).toBe(22);
    expect(await count(db, "SELECT COUNT(*) n FROM holdout_look_refusal")).toBe(0);
  });

  it("252 sessions with no panel source: the meter reads 'met', nothing is looked at", async () => {
    const db = await freshDb("main");
    await allowMarket(db, "ZZ");
    await plantArchive(db, "ZZ", days.slice(0, 252));
    const out = await runAnnCalibration(db, at(days[251]!), { io });
    expect(out).toMatchObject({ n: 252, status: "met", looked: 0 });
    expect(await count(db, "SELECT COUNT(*) n FROM holdout_look")).toBe(0);
  });

  it("an unreadable plan freezes nothing and takes no look; the meter reads 'blocked'", async () => {
    const db = await freshDb("main");
    await allowMarket(db, "ZZ");
    await plantArchive(db, "ZZ", days.slice(0, 252));
    const panel = vi.fn(async () => panelOf({}));
    const out = await runAnnCalibration(db, at(days[251]!), { io: { read: () => null }, panel });
    expect(out.status).toBe("blocked");
    expect(panel).not.toHaveBeenCalled();
    expect(await count(db, "SELECT COUNT(*) n FROM research_prereg")).toBe(0);
  });

  it("the labels are looked at once when enough holdout announcements carry a label", async () => {
    const db = await freshDb("main");
    await allowMarket(db, "ZZ");
    await plantArchive(db, "ZZ", days.slice(0, 252));
    const panel = vi.fn(async () => panelOf({ tone: 1 }));
    const out = await runAnnCalibration(db, at(days[251]!), {
      io,
      panel,
      labelCoverage: async () => ({ labelled: 70, items: 100 }),
    });
    expect(out.looked).toBe(22);
    expect(
      await count(
        db,
        `SELECT COUNT(*) n FROM holdout_look WHERE lineage = '${ANN_LABELS_LINEAGE}'`,
      ),
    ).toBe(1);
  });

  it("the projected date follows the trailing rate on the trading calendar", async () => {
    const db = await freshDb("main");
    await allowMarket(db, "ZZ");
    const first = days.slice(0, 12);
    await plantArchive(db, "ZZ", first);
    for (const d of first)
      await db.execute({
        sql: "INSERT INTO trading_calendar (market, d, kind, close_time, confirmed, source) VALUES ('ZZ', ?, 'session', NULL, 1, 'test')",
        args: [d],
      });
    let last = { projectedD: null as string | null, n: 0 };
    for (const d of first) {
      const r = await runAnnCalibration(db, at(d), { io });
      last = { projectedD: r.projectedD, n: r.n };
    }
    expect(last.n).toBe(12);
    // one archived session per session: 240 sessions remain, so the 240th weekday after the 12th session
    expect(last.projectedD).toBe(weekdays(12 + 240)[12 + 240 - 1]);
  });
});
