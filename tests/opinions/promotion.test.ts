// @vitest-environment node
// Promotion request (M22 C4; AGT-148, CTX-060; D-1428, D-1519, D-1520): a kind that meets all three conditions gets exactly
// one `opinion_promotion_request` row and one warning line; a kind that does not gets nothing; a repeat writes nothing;
// no approve action exists. The health lines and the entry. Synthetic ZZ data only.
import type { Client } from "@libsql/client";
import { afterAll, describe, expect, it } from "vitest";
import { loadOpinionsHealth, opinionsHealthOf } from "@/lib/health/opinions";
import { opinionMetersMain } from "@/lib/opinions/cli";
import { meterOf, type Case } from "@/lib/opinions/meter";
import {
  evidenceOf,
  PROMOTION_LINE,
  requestPromotion,
  runPromotion,
} from "@/lib/opinions/promotion";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { build } from "../committee/trialWorld";

afterAll(cleanupTempDbs);

const NOW = "2030-02-01T00:00:00.000Z";

/** Committee specs: `perModel` approved and `perModel` rejected signals for each of two judge versions. */
function specs(perModel: number, gap: number) {
  const out = [];
  let night = 0;
  for (const judge of ["j1", "j2"]) {
    for (let i = 0; i < perModel; i++) {
      out.push({ night, rating: "approve" as const, net: gap + (i % 3) * 100, judge });
      out.push({ night, rating: "reject" as const, net: (i % 3) * 100, judge });
      night += 1;
    }
  }
  return out;
}

const count = async (db: Client, sql: string): Promise<number> =>
  Number((await db.execute(sql)).rows[0]!.n);

describe("runPromotion", () => {
  it("writes one request and one warning line when a kind meets all three conditions", async () => {
    const db = await build(specs(15, 1000)); // 60 settled, two judge versions of 30
    const r = await runPromotion(db, { market: "AU", d: "2030-02-01", now: NOW, minN: 60 });
    expect(r.requested).toEqual(["committee"]);
    expect(await count(db, "SELECT COUNT(*) n FROM opinion_promotion_request")).toBe(1);
    const row = (await db.execute("SELECT * FROM opinion_promotion_request")).rows[0]!;
    expect(row).toMatchObject({
      market: "AU",
      kind: "committee",
      requested_d: "2030-02-01",
      created_at: NOW,
    });
    const ev = JSON.parse(String(row.evidence_json)) as Record<string, unknown>;
    expect(ev).toMatchObject({
      settled: 60,
      needed: 60,
      lift_ppm: 1000,
      lift_lower90_ppm: 972,
      for_n: 30,
      against_n: 30,
    });
    const logs = (
      await db.execute("SELECT level, source, message FROM app_log WHERE source = 'opinions'")
    ).rows;
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ level: "warn", message: PROMOTION_LINE });
    expect(PROMOTION_LINE).toBe(
      "An opinion has earned a review: needs a new spec version and an Owner decision",
    );
  });

  it("writes the request once, ever: a second night adds neither a row nor a line", async () => {
    const db = await build(specs(15, 1000));
    await runPromotion(db, { market: "AU", d: "2030-02-01", now: NOW, minN: 60 });
    const again = await runPromotion(db, {
      market: "AU",
      d: "2030-02-02",
      now: "2030-02-02T00:00:00.000Z",
      minN: 60,
    });
    expect(again.requested).toEqual([]);
    expect(again.meters.find((m) => m.kind === "committee")!.earned).toBe(true);
    expect(await count(db, "SELECT COUNT(*) n FROM opinion_promotion_request")).toBe(1);
    expect(await count(db, "SELECT COUNT(*) n FROM app_log WHERE source = 'opinions'")).toBe(1);
    expect(
      (await db.execute("SELECT requested_d FROM opinion_promotion_request")).rows[0]!.requested_d,
    ).toBe("2030-02-01");
  });

  it("writes nothing below the count, with one judge version, or with a gap that could be chance", async () => {
    const below = await build(specs(15, 1000));
    await runPromotion(below, { market: "AU", d: "2030-02-01", now: NOW, minN: 61 });
    expect(await count(below, "SELECT COUNT(*) n FROM opinion_promotion_request")).toBe(0);

    const one = await build(specs(15, 1000).map((s) => ({ ...s, judge: "j1" })));
    await runPromotion(one, { market: "AU", d: "2030-02-01", now: NOW, minN: 60 });
    expect(await count(one, "SELECT COUNT(*) n FROM opinion_promotion_request")).toBe(0);

    const chance = await build(specs(15, 0));
    await runPromotion(chance, { market: "AU", d: "2030-02-01", now: NOW, minN: 60 });
    expect(await count(chance, "SELECT COUNT(*) n FROM opinion_promotion_request")).toBe(0);
    expect(await count(chance, "SELECT COUNT(*) n FROM app_log WHERE source = 'opinions'")).toBe(0);
  });

  it("reads opinion_min_n from the config store when no count is given (default 150)", async () => {
    const db = await build(specs(15, 1000));
    const r = await runPromotion(db, { market: "AU", d: "2030-02-01", now: NOW });
    expect(r.meters.every((m) => m.needed === 150)).toBe(true);
    expect(r.requested).toEqual([]);
  });

  it("writes only the request table and the log: nothing else of the database moves", async () => {
    const db = await build(specs(15, 1000));
    const names = (
      await db.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
    ).rows.map((x) => String(x.name));
    const sizes = async () =>
      Object.fromEntries(
        await Promise.all(
          names.map(async (t) => [t, await count(db, `SELECT COUNT(*) n FROM ${t}`)]),
        ),
      );
    const before = await sizes();
    await runPromotion(db, { market: "AU", d: "2030-02-01", now: NOW, minN: 60 });
    const after = await sizes();
    expect(
      Object.keys(after)
        .filter((t) => after[t] !== before[t])
        .sort(),
    ).toEqual(["app_log", "opinion_promotion_request"]);
  });

  it("the table refuses a rewrite and a delete", async () => {
    const db = await build(specs(15, 1000));
    await runPromotion(db, { market: "AU", d: "2030-02-01", now: NOW, minN: 60 });
    await expect(
      db.execute("UPDATE opinion_promotion_request SET requested_d = '2031-01-01'"),
    ).rejects.toThrow(/append-only/);
    await expect(db.execute("DELETE FROM opinion_promotion_request")).rejects.toThrow(
      /append-only/,
    );
  });

  it("requestPromotion reports whether it wrote", async () => {
    const db = await freshDb("main");
    const ev = { settled: 1 };
    expect(
      await requestPromotion(db, {
        market: "AU",
        kind: "steelman",
        d: "2030-02-01",
        evidence: ev,
        now: NOW,
      }),
    ).toBe(true);
    expect(
      await requestPromotion(db, {
        market: "AU",
        kind: "steelman",
        d: "2030-02-05",
        evidence: ev,
        now: NOW,
      }),
    ).toBe(false);
    expect(
      await requestPromotion(db, {
        market: "AU",
        kind: "committee",
        d: "2030-02-05",
        evidence: ev,
        now: NOW,
      }),
    ).toBe(true);
  });
});

describe("evidenceOf", () => {
  it("holds the figures and the versions and fits the 4,000-character cap", () => {
    const cases: Case[] = Array.from({ length: 60 }, (_, i) => ({
      lean: i % 2 === 0 ? "for" : "against",
      netPpm: i % 2 === 0 ? 1000 : 0,
      model: `m${i % 30}`,
    }));
    const ev = evidenceOf(meterOf("AU", "steelman", cases, 60));
    expect(JSON.stringify(ev).length).toBeLessThan(4000);
    expect(Object.keys(ev).sort()).toEqual([
      "against_n",
      "for_n",
      "lift_lower90_ppm",
      "lift_ppm",
      "needed",
      "settled",
      "versions",
    ]);
  });
});

describe("System Health lines", () => {
  it("counting: one line per kind and one for the kinds with no meter, in plain words", () => {
    const h = opinionsHealthOf(
      [meterOf("AU", "steelman", [], 150), meterOf("AU", "committee", [], 150)],
      new Set(),
    );
    expect(h.state).toBe("ok");
    expect(h.lines).toEqual([
      "Bull and bear notes: 0 of 150 settled cases so far",
      "Committee opinions: 0 of 150 settled cases so far",
      "Looking-back notes: no forward meter. They are written after the result is known, so there is no forward test to measure.",
      "Proposed new ideas: no forward meter. They are screened as ideas in their own right, and that screening counts them.",
    ]);
  });

  it("an earned kind is an attention line with the sentence of D-1428", async () => {
    const db = await build(specs(15, 1000));
    await runPromotion(db, { market: "AU", d: "2030-02-01", now: NOW, minN: 60 });
    const h = await loadOpinionsHealth(db);
    // the stored minimum is the default 150 here, so the Committee has not met it: counting
    expect(h.state).toBe("ok");
    const earned = opinionsHealthOf(
      [
        meterOf(
          "AU",
          "committee",
          Array.from({ length: 60 }, (_, i): Case => ({
            lean: i % 2 === 0 ? "for" : "against",
            netPpm: (i % 2 === 0 ? 1000 : 0) + (i % 3) * 100,
            model: i < 30 ? "a" : "b",
          })),
          60,
        ),
      ],
      new Set(["committee"]),
    );
    expect(earned.state).toBe("attention");
    expect(earned.lines[0]).toBe(
      "Committee opinions: An opinion has earned a review: needs a new spec version and an Owner decision.",
    );
  });

  it("names no internal code, table or role", () => {
    const h = opinionsHealthOf(
      [meterOf("AU", "steelman", [], 150), meterOf("AU", "committee", [], 150)],
      new Set(),
    );
    expect(h.lines.join(" ")).not.toMatch(/\b(R[0-9]|opinion_|committee_|steelman_|CTX|AGT|D-\d)/);
  });

  it("a failed read is an attention line, not a throw", async () => {
    const broken = { execute: () => Promise.reject(new Error("boom")) } as never;
    const h = await loadOpinionsHealth(broken);
    expect(h).toEqual({ state: "attention", lines: ["Opinions: the meters could not be read."] });
  });
});

describe("opinionMetersMain", () => {
  const env = { TURSO_MAIN_URL: "file:zz" };
  it("refuses a replay flag, degrades without a database, and never fails", async () => {
    const lines: string[] = [];
    const out = (s: string) => lines.push(s);
    expect(await opinionMetersMain(["--recorded-day"], env, { out })).toBe(0);
    expect(await opinionMetersMain([], {}, { out })).toBe(0);
    expect(
      await opinionMetersMain([], env, {
        out,
        openDb: () => {
          throw new Error("x");
        },
      }),
    ).toBe(0);
    expect(lines).toEqual([
      "opinions: refused (a replay or recorded-day run)",
      "opinions: degraded (database not configured)",
      "opinions: degraded (cannot open database)",
    ]);
  });

  it("prints counts only (the default minimum of 150 is not met by 60 cases)", async () => {
    const db = await build(specs(15, 1000));
    const lines: string[] = [];
    const closing = {
      ...db,
      execute: db.execute.bind(db),
      close: () => undefined,
    } as unknown as Client;
    const code = await opinionMetersMain(["--date", "2030-02-01"], env, {
      out: (s) => lines.push(s),
      openDb: () => closing,
      nowMs: () => Date.parse(NOW),
    });
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^opinions AU 2030-02-01: steelman=0\/\d+ committee=\d+\/\d+ requested=\d$/,
    );
  });

  it("prints nothing on a night with no settled case and no request (D-1536)", async () => {
    const db = await build([]);
    const lines: string[] = [];
    const closing = {
      ...db,
      execute: db.execute.bind(db),
      close: () => undefined,
    } as unknown as Client;
    const code = await opinionMetersMain(["--date", "2030-02-01"], env, {
      out: (s) => lines.push(s),
      openDb: () => closing,
      nowMs: () => Date.parse(NOW),
    });
    expect(code).toBe(0);
    expect(lines).toEqual([]);
  });
});
