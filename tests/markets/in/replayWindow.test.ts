// @vitest-environment node
// M20 IN1 (AT-M4, D-1119, D-1154): the rolling-start replay for India over a hand-made window: it completes without
// error on IN rules (market IN, a Rs seed from the FX close, T+1, the IN tick grid and the band lock), every label is
// computed or "not reachable" with its reason, and the data days reviewed green.
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDbs } from "../../db/helpers";
import { asmFile, bandsFile, barsOf, bhavFile, gsmFile } from "./dayFixture";
import { runWindow } from "./evidence";

afterEach(cleanupTempDbs);

const DATES = ["2026-11-05", "2026-11-06", "2026-11-09", "2026-11-11", "2026-11-12"];
const sessions = DATES.map((d, i) => ({
  d,
  files: {
    bhavcopy: bhavFile(d, barsOf(i)),
    bands: bandsFile(),
    ...(i === 4 ? { asm: asmFile(), gsm: gsmFile() } : {}),
  },
}));

describe("AT-M4 (IN): five data_only days and the rolling-start replay", () => {
  it("five days run green and review clean; the replay completes with every label accounted for", async () => {
    const { evidence } = await runWindow(sessions, ["2026-11-10"]);
    expect(evidence.days).toHaveLength(5);
    expect(
      evidence.days.every((x) => x.status === "ok" && /^(complete|partial:)/.test(x.outcome)),
    ).toBe(true);
    expect(evidence.review).toBe(true);
    expect(evidence.replay.status).toBe("completed");
    expect(evidence.replay.market).toBe("IN");
    expect(evidence.replay.sessions).toBe(5);
    expect(evidence.replay.cohorts).toBeGreaterThan(0);
    expect(evidence.replay.seedMicro).toBe(String(33_000n * 1_000_000n)); // A$600 x 55.123 -> Rs 33,000
    expect(evidence.replay.labels.length).toBeGreaterThan(0);
    for (const l of evidence.replay.labels) {
      expect(l.status === "computed" || (l.status === "not_reachable" && !!l.reason)).toBe(true);
    }
  });
});
