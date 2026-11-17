// @vitest-environment node
// D-994: Home's one line of the Owner's target, the four-week rate of top-5 gainers named before they
// moved against chance, read from the newest stored daily learning night that has it.
import { afterEach, describe, expect, it } from "vitest";
import { loadTop5Line } from "@/lib/ui/loaders/home";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

describe("loadTop5Line", () => {
  it("reads the newest stored rolling rate; nothing stored, a malformed or partial one reads as none", async () => {
    const db = await freshDb("main");
    expect(await loadTop5Line(db, "AU")).toBeNull();
    const put = (d: string, body: unknown) =>
      db.execute({
        sql: "INSERT INTO daily_learning (market, d, body_json, created_at) VALUES ('AU', ?, ?, 't')",
        args: [d, JSON.stringify(body)],
      });
    await put("2026-11-09", {
      top5: { rolling: { nights: 19, gainers: 95, had: 2, chanceHits: 1.5 } },
    });
    await put("2026-11-10", {
      top5: { rolling: { nights: 20, gainers: 100, had: 3, chanceHits: 1.6 } },
    });
    await put("2026-11-11", { summary: [] }); // a night stored before the measure existed
    expect(await loadTop5Line(db, "AU")).toBe(
      "Top 5 gainers named before they moved, the last 20 trading days: 3 of 100 (3%), against about 1.6 by chance (2%).",
    );
    await put("2026-11-12", { top5: { rolling: { nights: 20 } } });
    expect(await loadTop5Line(db, "AU")).toBeNull();
    db.close();
  });
});
