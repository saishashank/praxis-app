// @vitest-environment node
// M18 TST-136 (D-968): the WALL-CLOCK variant of the default-size cohort replay (the old R3-I4 60 s budget),
// moved out of tests/replay/cohortReplay.test.ts, whose version now counts work. Measuring seconds on a shared
// runner is noisy, so this file is excluded from the default suite (vitest.config.mts) and runs only in the
// non-blocking "Timing report" CI step: npx vitest run --config vitest.timing.config.mts. No retry. The measured
// time is printed on every run so a trend stays visible.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultAgentParams } from "@/lib/agents/params";
import { replayCohorts } from "@/lib/replay/cohortReplay";
import { buildDataset, freshReplayDb, terminalOverrides } from "../arena/replayHarness";
import { cleanupTempDbs } from "../db/helpers";
import {
  buildCohortWorld,
  seriesFromHarness,
  type WorldSeries,
} from "../fixtures/replay/cohortWorld";

const p = defaultAgentParams();
const SESSIONS = 780;
let dates: string[] = [];
let series: WorldSeries[] = [];

beforeAll(async () => {
  const db = await freshReplayDb();
  const ds = await buildDataset(db, { startD: "2030-01-07", sessions: SESSIONS, seed: 11 });
  dates = ds.dates;
  series = await seriesFromHarness(db, ds.dates, ds.spec);
});
afterAll(cleanupTempDbs);

describe("wall time: the cohort replay", () => {
  it(
    "the full default-size replay (every step and control slot) fits the 60 s budget",
    { timeout: 180000 },
    () => {
      const t0 = Date.now();
      const r = replayCohorts(buildCohortWorld(dates, series, p, {}), {
        params: p,
        cohortParams: () => terminalOverrides(),
      });
      const seconds = (Date.now() - t0) / 1000;
      console.info(`default-size replay: ${seconds.toFixed(1)} s (budget 60 s)`);
      expect(r.starts.length).toBe(Math.ceil((SESSIONS - 2) / p.replay.rollingStartStep));
      // v8 coverage instrumentation slows this loop; the coverage job sets PRAXIS_COVERAGE_RUN=1.
      const slack = process.env.PRAXIS_COVERAGE_RUN === "1" ? 3 : 1;
      expect(seconds).toBeLessThan(60 * slack);
    },
  );
});
