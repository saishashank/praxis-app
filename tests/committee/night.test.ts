// @vitest-environment node
// Committee night stage (M22 C1; AGT-145, AGT-132, LLM-066; D-1417, D-1418, D-1419): ratings, call records, opinions,
// the skips, the refusals, idempotence and the never-throws rule. Mock providers over the real migrations.
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import type { CommitteeLlm } from "@/lib/committee/debate";
import { addMonths, committeeNight, reasonsJson } from "@/lib/committee/night";
import { MemoryStore } from "@/lib/llm/store";
import { cleanupTempDbs } from "../db/helpers";
import {
  committeeLlm,
  committeeProvider,
  count,
  D,
  defaultAnswer,
  judgeSays,
  nightOptions,
  params,
  seedNight,
  seedTrial,
} from "./harness";

afterEach(cleanupTempDbs);

async function world(trial: "none" | "running" | "final" = "running"): Promise<Client> {
  const db = await seedNight();
  if (trial !== "none") await seedTrial(db, trial === "final");
  return db;
}

const ratings = async (db: Client) =>
  (await db.execute("SELECT * FROM committee_rating ORDER BY signal_id")).rows;

describe("committeeNight: the rated path", () => {
  it("rates the shortlist, stores every call, the rating row and an opinion", async () => {
    const db = await world();
    const a = committeeProvider("alpha");
    const b = committeeProvider("beta");
    const res = await committeeNight(db, nightOptions(committeeLlm([a, b])));
    expect(res).toMatchObject({ status: "done", requested: 2, rated: 2, failed: 0 });
    const rows = await ratings(db);
    expect(rows.map((r) => r.signal_id)).toEqual(["s2", "s3"]); // the top two by rank score
    for (const r of rows) {
      expect(r).toMatchObject({
        market: "AU",
        d: D,
        trial_id: "t1",
        rating: "approve",
        same_family: 0,
        bull_model: "alpha-r6",
        bear_model: "beta-r6",
        risk_model: "alpha-r6", // the risk call uses the bull's model
        judge_model: "alpha-r7",
      });
      expect(r.judge_model).not.toBe(r.bear_model); // the judge is never the bear's model
      expect(JSON.parse(String(r.reasons_json)).length).toBeGreaterThan(0);
      expect(Object.keys(JSON.parse(String(r.timings_json)))).toContain("total");
    }
    // four calls per signal, each stored with its record (LLM-066, D-1419)
    expect(await count(db, "committee_call")).toBe(8);
    const call = (await db.execute("SELECT * FROM committee_call WHERE stage = 'judge' LIMIT 1"))
      .rows[0]!;
    expect(call).toMatchObject({ market: "AU", d: D, provider: "alpha", model_id: "alpha-r7" });
    expect(String(call.prompt_sha).length).toBeGreaterThan(0);
    expect(String(call.pack_id)).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(String(call.params_json))).toMatchObject({ budgetKey: "committee" });
    expect(String(call.raw_response).length).toBeLessThanOrEqual(8000);
    expect(String(call.expires_d)).toBe(addMonths(D, 18));
    // the opinion kind `committee` for the lift meter
    const op = (
      await db.execute("SELECT kind, code, d, value_json FROM opinion_track ORDER BY code")
    ).rows;
    expect(op.map((o) => [o.kind, o.code, o.d])).toEqual([
      ["committee", "ZZB", D],
      ["committee", "ZZC", D],
    ]);
    expect(JSON.parse(String(op[0]!.value_json))).toEqual({ rating: "approve" });
  });

  it("carries the judge's rating through (reject)", async () => {
    const db = await world();
    // alpha writes the bull and risk and judges (the judge avoids the bear, beta): alpha says reject
    const llm = committeeLlm([
      committeeProvider("alpha", undefined, judgeSays("reject")),
      committeeProvider("beta"),
    ]);
    await committeeNight(db, nightOptions(llm));
    expect((await ratings(db)).map((r) => r.rating)).toEqual(["reject", "reject"]);
    const op = (await db.execute("SELECT value_json FROM opinion_track")).rows.map((r) =>
      JSON.parse(String(r.value_json)),
    );
    expect(op).toEqual([{ rating: "reject" }, { rating: "reject" }]); // one per code
  });

  it("with one provider the bear shares the bull's (same_family = 1) and no legal judge exists: skipped_models", async () => {
    const db = await world();
    const res = await committeeNight(db, nightOptions(committeeLlm([committeeProvider("alpha")])));
    expect(res).toMatchObject({ rated: 0, skippedModels: 2 });
    const rows = await ratings(db);
    expect(
      rows.every(
        (r) => r.rating === "skipped_models" && r.same_family === 1 && r.judge_model === null,
      ),
    ).toBe(true);
    // the three statement calls that were made are still on file
    expect(await count(db, "committee_call")).toBe(6);
    expect(await count(db, "opinion_track")).toBe(0);
  });

  it("the judge is not the bear's model even when another provider shares that model id", async () => {
    const db = await world();
    const a = committeeProvider("alpha", { R6: "m-a", R7: "shared" });
    const b = committeeProvider("beta", { R6: "shared", R7: "m-b" });
    // bull alpha (m-a), bear beta (shared); the judge avoids beta so alpha judges with "shared" = the bear's model
    const res = await committeeNight(db, nightOptions(committeeLlm([a, b])));
    expect(res).toMatchObject({ rated: 0, skippedModels: 2 });
    expect((await ratings(db)).every((r) => r.judge_model === null)).toBe(true);
  });

  it("is idempotent: a second run adds no row and calls no model", async () => {
    const db = await world();
    const a = committeeProvider("alpha");
    const b = committeeProvider("beta");
    const llm = committeeLlm([a, b]);
    await committeeNight(db, nightOptions(llm));
    const calls = a.calls.length + b.calls.length;
    const res = await committeeNight(db, nightOptions(llm));
    expect(res).toMatchObject({ status: "done", requested: 2, rated: 0, alreadyDone: 2 });
    expect(a.calls.length + b.calls.length).toBe(calls);
    expect(await count(db, "committee_rating")).toBe(2);
    expect(await count(db, "committee_call")).toBe(8);
  });

  it("rates a signal that has no decision card", async () => {
    const db = await world();
    await db.execute({
      sql: `INSERT INTO signal (id, market, d, family, rule_version, variant, code, regime, rank_score, rules_json, evidence_json, schema_version, agent_version, inputs_ref, decided_at)
            VALUES ('s6', 'AU', ?, 'F3', 'v1', 'base', 'ZZE', 'NEUTRAL', '99', '[]', '{}', 1, 'a', 'r', '2026-03-04T07:10:00.000Z')`,
      args: [D],
    });
    const llm = committeeLlm([
      committeeProvider("alpha", undefined, defaultAnswer),
      committeeProvider("beta"),
    ]);
    const res = await committeeNight(
      db,
      nightOptions(llm, { keys: { ...nightOptions(llm).keys, shortlist: 1 } }),
    );
    expect(res.rated).toBe(1);
    expect((await ratings(db))[0]).toMatchObject({ signal_id: "s6", rating: "approve" });
  });
});

describe("committeeNight: skips", () => {
  it("budget exhaustion gives skipped_budget rows and no call", async () => {
    const db = await world();
    const a = committeeProvider("alpha");
    const b = committeeProvider("beta");
    const lp = { ...params.llm, roleDailyTokens: { ...params.llm.roleDailyTokens, committee: 0 } };
    const res = await committeeNight(
      db,
      nightOptions(committeeLlm([a, b], new MemoryStore(), lp), { llmParams: lp }),
    );
    expect(res).toMatchObject({ rated: 0, skippedBudget: 2 });
    expect((await ratings(db)).map((r) => r.rating)).toEqual(["skipped_budget", "skipped_budget"]);
    expect(a.calls.length + b.calls.length).toBe(0);
    expect(await count(db, "opinion_track")).toBe(0);
  });

  it("a budget stop inside the debate gives skipped_budget too", async () => {
    const db = await world();
    const stub: CommitteeLlm = {
      providers: [],
      store: new MemoryStore(),
      routerFor: () => ({
        mode: "mock",
        route: <T>() =>
          Promise.resolve({
            value: { points: [] } as unknown as T,
            source: "rules-only",
            llmUsed: false,
            cached: false,
            outcome: "budget-exhausted",
            budgetExhausted: true,
            injectionFiltered: false,
            injectionRemoved: 0,
            attempts: [],
            call: { id: "x", promptShas: [], tokensIn: 0, tokensOut: 0, costMicro: 0 as const },
          }),
      }),
    };
    const res = await committeeNight(db, nightOptions(stub));
    expect(res.skippedBudget).toBe(2);
  });

  it("the time-box: a signal not started by the stop is skipped_time, with no pack and no call", async () => {
    const db = await world();
    const a = committeeProvider("alpha");
    const res = await committeeNight(
      db,
      nightOptions(committeeLlm([a, committeeProvider("beta")]), {
        nowMs: () => 10,
        deadlineMs: 10,
      }),
    );
    expect(res).toMatchObject({ rated: 0, skippedTime: 2 });
    expect(
      (await ratings(db)).every((r) => r.rating === "skipped_time" && r.pack_id === "none"),
    ).toBe(true);
    expect(a.calls).toHaveLength(0);
  });

  it("the time-box cuts a signal part way: its answered calls stay, the later signals are skipped_time", async () => {
    const db = await world();
    let clock = 0;
    const tick = () => (clock += 1000);
    const a = committeeProvider("alpha", undefined, defaultAnswer, tick);
    const b = committeeProvider("beta", undefined, defaultAnswer, tick);
    const res = await committeeNight(
      db,
      nightOptions(committeeLlm([a, b]), { nowMs: () => clock, deadlineMs: 1500 }),
    );
    expect(res).toMatchObject({ rated: 0, skippedTime: 2 });
    expect((await ratings(db)).map((r) => r.rating)).toEqual(["skipped_time", "skipped_time"]);
    expect(await count(db, "committee_call")).toBe(2); // the first signal's bull and bear
  });

  it("neither role live (rules-only production): skipped_models rows, no model called", async () => {
    const db = await world();
    const a = committeeProvider("alpha");
    for (const live of [
      { R6: false, R7: false },
      { R6: true, R7: false },
      { R6: false, R7: true },
    ]) {
      const d2 = await world();
      const res = await committeeNight(d2, nightOptions(committeeLlm([a]), { live }));
      expect(res).toMatchObject({ rated: 0, skippedModels: 2 });
      expect(
        (await ratings(d2)).every((r) => r.rating === "skipped_models" && r.pack_id === "none"),
      ).toBe(true);
    }
    expect(a.calls).toHaveLength(0);
    void db;
  });

  it("a statement that fails its claim checks gives failed, with the earlier calls kept", async () => {
    const db = await world();
    const bad = (_r: unknown, stage: string): string =>
      stage === "bear"
        ? JSON.stringify({ points: [{ text: "Volume rose 77 percent.", citations: ["E01"] }] })
        : defaultAnswer(_r as never, stage);
    const res = await committeeNight(
      db,
      nightOptions(committeeLlm([committeeProvider("alpha", undefined, bad)])),
    );
    expect(res).toMatchObject({ rated: 0, failed: 2 });
    expect((await ratings(db)).every((r) => r.rating === "failed")).toBe(true);
    expect(await count(db, "committee_call")).toBe(2); // each signal's bull
  });
});

describe("committeeNight: refusals write nothing", () => {
  const nothing = async (db: Client) => {
    for (const t of ["committee_rating", "committee_call", "opinion_track"])
      expect(await count(db, t), t).toBe(0);
  };

  it("off: no row and no call", async () => {
    const db = await world();
    const a = committeeProvider("alpha");
    const llm = committeeLlm([a, committeeProvider("beta")]);
    const res = await committeeNight(
      db,
      nightOptions(llm, { keys: { ...nightOptions(llm).keys, enabled: false } }),
    );
    expect(res.status).toBe("off");
    await nothing(db);
    expect(a.calls).toHaveLength(0);
  });

  it("a past date is refused (forward only), and so is a future one", async () => {
    const db = await world();
    const llm = committeeLlm([committeeProvider("alpha"), committeeProvider("beta")]);
    expect((await committeeNight(db, nightOptions(llm, { today: "2026-03-05" }))).status).toBe(
      "refused_date",
    );
    expect((await committeeNight(db, nightOptions(llm, { today: "2026-03-03" }))).status).toBe(
      "refused_date",
    );
    await nothing(db);
  });

  it("a replay is refused", async () => {
    const db = await world();
    const llm = committeeLlm([committeeProvider("alpha"), committeeProvider("beta")]);
    expect((await committeeNight(db, nightOptions(llm, { replay: true }))).status).toBe(
      "refused_replay",
    );
    await nothing(db);
  });

  it("no pre-registration, or a finished trial: nothing is rated", async () => {
    const llm = committeeLlm([committeeProvider("alpha"), committeeProvider("beta")]);
    const none = await world("none");
    expect((await committeeNight(none, nightOptions(llm))).status).toBe("no_trial");
    await nothing(none);
    const done = await world("final");
    expect((await committeeNight(done, nightOptions(llm))).status).toBe("trial_done");
    await nothing(done);
  });

  it("a shortlist of 0 rates nothing", async () => {
    const db = await world();
    const llm = committeeLlm([committeeProvider("alpha"), committeeProvider("beta")]);
    const res = await committeeNight(
      db,
      nightOptions(llm, { keys: { ...nightOptions(llm).keys, shortlist: 0 } }),
    );
    expect(res).toMatchObject({ status: "done", requested: 0 });
    await nothing(db);
  });
});

describe("committeeNight: never throws", () => {
  it("returns failed on a broken database", async () => {
    const broken = { execute: () => Promise.reject(new Error("down")) } as unknown as Client;
    const llm = committeeLlm([committeeProvider("alpha")]);
    await expect(committeeNight(broken, nightOptions(llm))).resolves.toMatchObject({
      status: "failed",
    });
  });

  it("a router that throws is a failed rating, not an exception", async () => {
    const db = await world();
    const llm: CommitteeLlm = {
      providers: [],
      store: new MemoryStore(),
      routerFor: () => {
        throw new Error("boom");
      },
    };
    const res = await committeeNight(db, nightOptions(llm));
    expect(res.status).toBe("done");
    expect(res.failed).toBe(2);
  });
});

describe("helpers", () => {
  it("addMonths keeps the calendar date and rolls the year", () => {
    expect(addMonths("2026-03-04", 18)).toBe("2027-09-04");
    expect(addMonths("2026-11-30", 3)).toBe("2027-03-02"); // a short month rolls over, never fails
    expect(addMonths("2026-03-04", 0)).toBe("2026-03-04");
  });

  it("reasonsJson holds at most five reasons and 2,000 characters", () => {
    const long = { text: "x".repeat(399), citations: ["E01", "E02"] };
    const out = JSON.parse(reasonsJson(Array.from({ length: 8 }, () => long))) as unknown[];
    expect(out.length).toBeLessThanOrEqual(5);
    expect(reasonsJson(Array.from({ length: 8 }, () => long)).length).toBeLessThanOrEqual(2000);
    expect(reasonsJson([])).toBe("[]");
  });
});
