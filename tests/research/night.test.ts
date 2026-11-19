// @vitest-environment node
// The research night seam (M23 A1; D-1613): fixed order, skipped on replay, an enabled market only, fail-soft.
import { afterEach, describe, expect, it } from "vitest";
import {
  RESEARCH_STEPS,
  runResearchNight,
  type ResearchNightOptions,
  type ResearchStep,
} from "@/lib/research/night";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const O: ResearchNightOptions = { market: "AU", d: "2030-01-02", now: "2030-01-02T10:00:00Z" };
const step = (name: string, log: string[], boom = false): ResearchStep => ({
  name,
  plain: `doing ${name}`,
  async run() {
    log.push(name);
    if (boom) throw new Error("boom with an internal detail");
  },
});

describe("runResearchNight", () => {
  it("the fixed order of the seven stubs (D-1613)", () => {
    expect(RESEARCH_STEPS.map((s) => s.name)).toEqual([
      "lookSync",
      "sectorIndex",
      "meters",
      "monitors",
      "annCalibration",
      "labelEval",
      "shockStops",
    ]);
  });

  it("with the stubs it runs all seven and writes nothing", async () => {
    const db = await freshDb("main");
    const before = Number((await db.execute("SELECT COUNT(*) n FROM app_log")).rows[0]!.n);
    const r = await runResearchNight(db, O);
    expect(r.status).toBe("ran");
    expect(r.ran).toHaveLength(7);
    expect(r.failed).toEqual([]);
    expect(Number((await db.execute("SELECT COUNT(*) n FROM app_log")).rows[0]!.n)).toBe(before);
  });

  it("is skipped on a replay: no step runs", async () => {
    const db = await freshDb("main");
    const log: string[] = [];
    const r = await runResearchNight(db, { ...O, replay: true }, [step("a", log)]);
    expect(r.status).toBe("skipped_replay");
    expect(log).toEqual([]);
  });

  it("runs only for an enabled market (IN and US are off in a fresh database)", async () => {
    const db = await freshDb("main");
    const log: string[] = [];
    for (const m of ["IN", "US", "ZZ"]) {
      const r = await runResearchNight(db, { ...O, market: m }, [step("a", log)]);
      expect(r.status, m).toBe("skipped_market");
    }
    expect(log).toEqual([]);
    expect((await runResearchNight(db, O, [step("a", log)])).status).toBe("ran");
    expect(log).toEqual(["a"]);
  });

  it("is fail-soft: a throwing step is logged in plain words and the next step still runs", async () => {
    const db = await freshDb("main");
    const log: string[] = [];
    const r = await runResearchNight(db, O, [step("a", log), step("b", log, true), step("c", log)]);
    expect(log).toEqual(["a", "b", "c"]);
    expect(r.ran).toEqual(["a", "c"]);
    expect(r.failed).toEqual(["b"]);
    const l = (await db.execute("SELECT level, source, message FROM app_log")).rows;
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ level: "warn", source: "research" });
    expect(String(l[0]!.message)).toBe(
      "A research step could not finish tonight (doing b) and was skipped.",
    );
    expect(String(l[0]!.message)).not.toMatch(/boom|internal|[A-Z]+-\d+|_/);
  });
});
