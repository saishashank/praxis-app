// @vitest-environment node
// OPS-105 (D-962; AT-83 "the quarterly Owner item appears"): the quarterly real-key restore drill is an
// Owner item from the first day of each quarter until a real-key drill AND a later verify-removed run are
// recorded inside that quarter. Pure facts for the component, plus the facts read from run_record.
import { afterEach, describe, expect, it } from "vitest";
import {
  computeComponents,
  quarterStart,
  restoreDrillDue,
  type HealthFacts,
  type RestoreRun,
} from "@/lib/health/components";
import { gatherHealthFacts } from "@/lib/health/snapshot";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const green = (today: string, restore?: HealthFacts["restore"]): HealthFacts => ({
  today,
  nowMs: Date.parse(`${today}T01:00:00Z`),
  marketActive: true,
  sentinelLastOkAt: `${today}T00:00:00Z`,
  jobs: {},
  quality: { gateFails: 0, blockingFlags: 0 },
  llmLevel: "ok",
  emailMode: "full",
  lastReview: null,
  dbReadable: true,
  storageLevel: "ok",
  watchdog: "ok",
  failedSecrets: [],
  credentials: [],
  quotaLevel: "ok",
  restore,
});
const backups = (f: HealthFacts) => computeComponents(f).find((c) => c.id === "backups")!;
const drill = (at: string, keyMode = "real", mode = "drill"): RestoreRun => ({ at, keyMode, mode });
const verified = (at: string): RestoreRun => ({ at, keyMode: "real", mode: "verify-removed" });

describe("quarterStart", () => {
  it("is the first day of January, April, July or October", () => {
    expect(quarterStart("2026-01-01")).toBe("2026-01-01");
    expect(quarterStart("2026-02-15")).toBe("2026-01-01");
    expect(quarterStart("2026-03-31")).toBe("2026-01-01");
    expect(quarterStart("2026-04-01")).toBe("2026-04-01");
    expect(quarterStart("2026-11-12")).toBe("2026-10-01");
    expect(quarterStart("2026-12-31")).toBe("2026-10-01");
  });
});

describe("the quarterly restore drill item", () => {
  it("appears on the first day of the quarter with the plain wording and the guide", () => {
    const c = backups(green("2026-01-01", { thisQuarter: [], lastRealDrillAt: null }));
    expect(c.state).toBe("attention");
    const item = c.items.find((i) => i.key === "restore.drill_due")!;
    expect(item.label).toBe(
      "Quarterly restore drill due (last real-key drill never): run Restore drill (real key) from the Actions tab, then verify-removed",
    );
    expect(item.fix).toMatch(/owner_checks\.md/);
    expect(item.state).toBe("attention");
  });

  it("names the last real-key drill date once there is one", () => {
    const c = backups(
      green("2026-04-01", { thisQuarter: [], lastRealDrillAt: "2026-01-09T01:02:03.000Z" }),
    );
    expect(c.items[0]!.label).toMatch(/last real-key drill 2026-01-09/);
  });

  it("clears when a real-key drill and a later verify-removed exist in the quarter", () => {
    const done: RestoreRun[] = [
      verified("2026-01-10T02:00:00.000Z"),
      drill("2026-01-10T01:00:00.000Z"),
    ];
    const c = backups(
      green("2026-01-12", { thisQuarter: done, lastRealDrillAt: "2026-01-10T01:00:00.000Z" }),
    );
    expect(c.items).toEqual([]);
    expect(c.state).toBe("healthy");
    expect(c.reason).toBe("Last backup succeeded; last real-key restore drill 2026-01-10");
  });

  it("stays open for a drill without a verify-removed, a throwaway drill, or a verify before the drill", () => {
    for (const runs of [
      [drill("2026-01-10T01:00:00.000Z")],
      [drill("2026-01-10T01:00:00.000Z", "throwaway"), verified("2026-01-10T02:00:00.000Z")],
      [verified("2026-01-09T02:00:00.000Z"), drill("2026-01-10T01:00:00.000Z")],
    ]) {
      expect(
        restoreDrillDue(green("2026-01-12", { thisQuarter: runs, lastRealDrillAt: null })),
      ).toBe(true);
    }
  });

  it("a restore-mode real run counts like a drill", () => {
    const runs = [
      verified("2026-01-11T00:00:00.000Z"),
      drill("2026-01-10T01:00:00.000Z", "real", "restore"),
    ];
    expect(restoreDrillDue(green("2026-01-12", { thisQuarter: runs, lastRealDrillAt: null }))).toBe(
      false,
    );
  });

  it("2026-02-15 with this quarter's drill done shows no item; the next quarter's first day shows it again", () => {
    const done: RestoreRun[] = [
      verified("2026-01-10T02:00:00.000Z"),
      drill("2026-01-10T01:00:00.000Z"),
    ];
    expect(restoreDrillDue(green("2026-02-15", { thisQuarter: done, lastRealDrillAt: null }))).toBe(
      false,
    );
    // on 1 April the facts hold only April's runs (the loader reads from the quarter start)
    expect(
      restoreDrillDue(
        green("2026-04-01", { thisQuarter: [], lastRealDrillAt: "2026-01-10T01:00:00.000Z" }),
      ),
    ).toBe(true);
  });

  it("no item when the runs could not be read (absent facts)", () => {
    expect(restoreDrillDue(green("2026-01-01"))).toBe(false);
    expect(backups(green("2026-01-01")).state).toBe("healthy");
  });
});

describe("the facts read from run_record", () => {
  async function record(
    db: Awaited<ReturnType<typeof freshDb>>,
    at: string,
    mode: string,
    keyMode = "real",
  ) {
    await db.execute({
      sql: `INSERT INTO run_record (job, concurrency_key, started_at, status, details_json)
            VALUES ('restore-drill', ?, ?, 'success', ?)`,
      args: [
        `restore-drill:${at.slice(0, 10)}:${mode}:${keyMode}`,
        at,
        JSON.stringify({ keyMode, mode }),
      ],
    });
  }

  it("2026-01-01 shows the item; a drill then verify-removed clears it", async () => {
    const db = await freshDb("main");
    const env = {} as Record<string, string | undefined>;
    const now = (d: string) => new Date(`${d}T01:00:00.000Z`);
    let f = await gatherHealthFacts(db, now("2026-01-01"), "2026-01-01", env);
    expect(f.restore).toEqual({ thisQuarter: [], lastRealDrillAt: null });
    expect(backups(f).items.map((i) => i.key)).toEqual(["restore.drill_due"]);

    await record(db, "2026-01-05T01:00:00.000Z", "drill");
    f = await gatherHealthFacts(db, now("2026-01-06"), "2026-01-06", env);
    expect(f.restore?.lastRealDrillAt).toBe("2026-01-05T01:00:00.000Z");
    expect(backups(f).items.map((i) => i.key)).toEqual(["restore.drill_due"]); // no verify-removed yet

    await record(db, "2026-01-05T03:00:00.000Z", "verify-removed");
    f = await gatherHealthFacts(db, now("2026-02-15"), "2026-02-15", env);
    expect(backups(f).items).toEqual([]);

    f = await gatherHealthFacts(db, now("2026-04-01"), "2026-04-01", env); // the next quarter
    expect(f.restore?.thisQuarter).toEqual([]);
    expect(backups(f).items.map((i) => i.key)).toEqual(["restore.drill_due"]);
  });
});
