// @vitest-environment node
// D-957 the Evening Review's My portfolio lines: one per valued profile in section 3 (Profit / loss),
// in the e-mail and the app text alike; none when nothing was valued on the date.
import { afterEach, describe, expect, it } from "vitest";
import { renderReview } from "@/lib/email/templates";
import { buildFacts } from "@/lib/review/assemble";
import { cleanupTempDbs } from "../db/helpers";
import * as fx from "../fixtures/email/facts";
import { APP, D, MARKET, NOW, exec, mainWorld, tradingDay } from "./helpers";

afterEach(cleanupTempDbs);

const opts = { market: MARKET, d: D, env: "production" as const, appUrl: APP, now: NOW };
const LINES = [
  "Conservative: A$1,000.00, A$0.00 (0.0%) since the start; no fall from a peak yet; all in cash.",
  "Balanced: A$1,011.50, +A$11.50 (+1.1%) since the start; worst fall -0.4%; 1 holding; split Follow the trend 40%, cash 60%; today 1 buy.",
];

describe("review: My portfolio lines (D-957)", () => {
  it("renders the lines under section 3, after the strategies' table", () => {
    const out = renderReview(fx.reviewFacts({ myPortfolios: { lines: LINES } }));
    const s3 = out.text.slice(
      out.text.indexOf("3. Profit / loss"),
      out.text.indexOf("4. What we learned"),
    );
    expect(s3).toContain("My portfolio (practice money, one per risk profile)");
    for (const l of LINES) expect(s3).toContain(l);
    expect(out.html).toContain(LINES[1]!.replace("&", "&amp;").split(";")[0]!);
    const none = renderReview(fx.reviewFacts());
    expect(none.text).not.toContain("My portfolio");
  });

  it("still shows the lines when no strategy is listed", () => {
    const out = renderReview(fx.reviewFacts({ executions: [], myPortfolios: { lines: LINES } }));
    expect(out.text).toContain("No strategies.");
    expect(out.text).toContain(LINES[0]!);
  });

  it("buildFacts reads the stored night of the date, and nothing for another date", async () => {
    const db = await mainWorld();
    await tradingDay(db);
    await exec(
      db,
      `INSERT INTO pick_portfolio_day (market, profile, d, cash_micro, holdings_micro, value_micro, holdings, fall_ppm)
       VALUES (?, 'balanced', ?, 749000000, 262500000, 1011500000, 1, -4000)`,
      [MARKET, D],
    );
    await exec(
      db,
      `INSERT INTO pick_portfolio_split (market, profile, d, shares_json, cash_ppm, words)
       VALUES (?, 'balanced', ?, '[{"strategy":"F1","target_ppm":400000},{"strategy":"ZZ","target_ppm":1}]', 600000, 'x')`,
      [MARKET, D],
    );
    const built = await buildFacts(db, opts);
    expect(built.facts.myPortfolios?.lines).toEqual([
      "Balanced: A$1,011.50, +A$11.50 (+1.1%) since the start; worst fall -0.4%; 1 holding; split Follow the trend 40%, cash 60%.",
    ]);
    const other = await buildFacts(db, { ...opts, d: "2026-10-20" });
    expect(other.facts.myPortfolios).toBeUndefined();
  });
});
