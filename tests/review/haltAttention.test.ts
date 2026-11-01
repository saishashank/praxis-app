// @vitest-environment node
// The halt-watch line of the Evening Review (CR-MOV-A1; D-744): an open halt watch becomes one attention
// item with the reason in plain words and no figure of any past resume; a resumed one does not; the
// rendered review shows it. Synthetic ZZ data only (SEC-110).
import { afterEach, describe, expect, it } from "vitest";
import { renderReview } from "@/lib/email/templates";
import { buildFacts } from "@/lib/review/assemble";
import { cleanupTempDbs } from "../db/helpers";
import { APP, D, MARKET, NOW, exec, mainWorld, tradingDay } from "./helpers";

afterEach(cleanupTempDbs);

const opts = { market: MARKET, d: D, env: "production" as const, appUrl: APP, now: NOW };

async function watch(
  db: Awaited<ReturnType<typeof mainWorld>>,
  code: string,
  status: "open" | "resumed",
  reason: string,
  sign: number,
) {
  await exec(
    db,
    "INSERT INTO halt_watch (market, code, since_d, seq, status, reason_class, expected_sign, resume_d, known_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, 't')",
    [MARKET, code, D, status, reason, sign, status === "resumed" ? D : null],
  );
}

describe("halt watch in the Evening Review", () => {
  it("an open capital-raising halt is an attention item in plain words; a resumed one is not", async () => {
    const db = await mainWorld();
    await tradingDay(db);
    await watch(db, "ZZH", "open", "capital_raise", -1);
    await watch(db, "ZZR", "resumed", "takeover", 1);
    const built = await buildFacts(db, opts);
    const items = built.facts.scorecard.attention.filter((a) => a.name.startsWith("ZZ"));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ status: "attention", daysOpen: 1 });
    expect(items[0]!.name).toBe("ZZH is in a trading halt (a share issue)");
    expect(items[0]!.fix).toContain("mostly fallen");
    expect(items[0]!.fix).toContain("Nothing is bought or sold while it is halted");
    expect(items[0]!.fix).not.toMatch(/\d/); // no figure of any past resume (SEC-110)
    const out = renderReview(built.facts);
    expect(out.text).toContain("ZZH is in a trading halt");
  });

  it("an unknown reason says so and claims no direction", async () => {
    const db = await mainWorld();
    await tradingDay(db);
    await watch(db, "ZZH", "open", "unknown", 0);
    const built = await buildFacts(db, opts);
    const item = built.facts.scorecard.attention.find((a) => a.name.startsWith("ZZH"))!;
    expect(item.name).toContain("a reason not stated in the notice");
    expect(item.fix).toContain("The direction of the resume is not known.");
  });

  it("no open watch: the review is unchanged", async () => {
    const db = await mainWorld();
    await tradingDay(db);
    const built = await buildFacts(db, opts);
    expect(built.facts.scorecard.attention.some((a) => a.name.includes("trading halt"))).toBe(
      false,
    );
  });
});
