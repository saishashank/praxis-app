// @vitest-environment node
// M20 IN1 (AT-M4, D-1119): the SAME window over the RECORDED fixtures of `praxis-app-fixtures/recorded/in/` (five
// consecutive sessions of the fixture universe, recorded from the history extract). It runs only where the private
// fixtures checkout exists (the build machine and the `recorded-day-dev` job); with PRAXIS_AT_M_EVIDENCE_DIR set it
// writes `recorded-days-IN.json`, the M4 evidence `scripts/market/at-m-report.mjs` reads. No network.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDbs } from "../../db/helpers";
import { runWindow, type SessionFiles } from "./evidence";

afterEach(cleanupTempDbs);

const ROOT =
  process.env.PRAXIS_FIXTURES_DIR ?? path.resolve(__dirname, "../../../../praxis-app-fixtures");
const DIR = path.join(ROOT, "recorded", "in");
const HAVE = existsSync(DIR) && readdirSync(DIR).length >= 5;

function load(): { sessions: SessionFiles[]; holidays: string[] } {
  const dates = readdirSync(DIR)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  const names: Record<string, string> = {
    bhavcopy: "bhavcopy.csv",
    bands: "bands.csv",
    asm: "asm.json",
    gsm: "gsm.json",
    classification: "classification.csv",
  };
  const sessions = dates.map((d) => ({
    d,
    files: Object.fromEntries(
      Object.entries(names)
        .filter(([, f]) => existsSync(path.join(DIR, d, f)))
        .map(([k, f]) => [k, readFileSync(path.join(DIR, d, f), "utf8")]),
    ),
  }));
  // a weekday between two recorded sessions with no folder is a holiday in the window (the NSE closed that day)
  const holidays: string[] = [];
  for (let i = 1; i < dates.length; i += 1) {
    for (
      let t = Date.parse(`${dates[i - 1]}T00:00:00Z`) + 86_400_000;
      t < Date.parse(`${dates[i]}T00:00:00Z`);
      t += 86_400_000
    ) {
      const day = new Date(t);
      if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6)
        holidays.push(day.toISOString().slice(0, 10));
    }
  }
  return { sessions, holidays };
}

describe.skipIf(!HAVE)("AT-M4 (IN) on the recorded fixtures", () => {
  it("five recorded days run green, review clean, and the replay completes", async () => {
    const { sessions, holidays } = load();
    expect(sessions.length).toBeGreaterThanOrEqual(5);
    const { evidence } = await runWindow(sessions, holidays);
    expect(evidence.reviewNotes).toEqual([]);
    expect(evidence.days.every((x) => x.status === "ok")).toBe(true);
    expect(evidence.replay.status).toBe("completed");
    const out = process.env.PRAXIS_AT_M_EVIDENCE_DIR;
    if (out) {
      mkdirSync(out, { recursive: true });
      writeFileSync(path.join(out, "recorded-days-IN.json"), JSON.stringify(evidence, null, 2));
    }
  });
});
