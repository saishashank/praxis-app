// @vitest-environment node
// CXA-007 monthly job (M23 T3; D-1637, D-1730...D-1739): when it runs, what it writes, and that nothing else moves. The model
// side is a fake `ask` here; the router and the injection boundary are exercised in injection.test.ts.
import type { Client } from "@libsql/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isFirstSession, runProposalJob, type AskResult } from "@/lib/research/proposals/job";
import { lineageOf } from "@/lib/research/proposals/store";
import { lineageName } from "@/lib/research/names";
import { cleanupTempDbs, freshDb } from "../../db/helpers";

afterAll(cleanupTempDbs);

const NOW = "2031-03-03T08:00:00.000Z";
const FIX = JSON.parse(
  readFileSync(join(__dirname, "../../fixtures/research/proposals-20.json"), "utf8"),
) as { items: Array<{ id: string; item: unknown }> };
const RAW = FIX.items.map((f) => f.item);
const OWN = new Set(["angle_proposal", "trial_ledger", "app_log"]);

const answer = (proposals: unknown[], over: Partial<AskResult> = {}): AskResult => ({
  value: { proposals },
  live: true,
  modelId: "mock-model",
  budgetExhausted: false,
  ...over,
});
const asker = (res: AskResult) => vi.fn(async () => res);

async function dump(db: Client, skip: ReadonlySet<string>): Promise<Record<string, string>> {
  const names = (
    await db.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
  ).rows.map((r) => String(r.name));
  const out: Record<string, string> = {};
  for (const t of names) {
    if (skip.has(t)) continue;
    out[t] = JSON.stringify((await db.execute(`SELECT * FROM ${t}`)).rows);
  }
  return out;
}
const count = async (db: Client, t: string): Promise<number> =>
  Number((await db.execute(`SELECT COUNT(*) n FROM ${t}`)).rows[0]!.n);

const job = (db: Client, ask: ReturnType<typeof asker> | null, perMonth = 3, d = "2031-03-03") =>
  runProposalJob(db, { market: "AU", d, now: NOW, perMonth, ask });

describe("when the job runs", () => {
  it("a limit of 0 or no live model: nothing is asked and nothing is written", async () => {
    const db = await freshDb("main");
    const before = await dump(db, new Set());
    const ask = asker(answer(RAW));
    expect((await job(db, ask, 0)).status).toBe("off");
    expect((await job(db, null)).status).toBe("no_live_model");
    expect(ask).not.toHaveBeenCalled();
    expect(await dump(db, new Set())).toEqual(before);
  });

  it("only on the first session of a month; a later session of the month asks nothing", async () => {
    const db = await freshDb("main");
    await db.execute(
      "INSERT INTO trading_calendar (market, d, kind, confirmed, source) VALUES ('AU', '2031-03-03', 'session', 1, 'test')",
    );
    await db.execute(
      "INSERT INTO trading_calendar (market, d, kind, confirmed, source) VALUES ('AU', '2031-03-04', 'session', 1, 'test')",
    );
    expect(await isFirstSession(db, "AU", "2031-03-03")).toBe(true);
    expect(await isFirstSession(db, "AU", "2031-03-04")).toBe(false);
    const ask = asker(answer(RAW));
    expect((await job(db, ask, 3, "2031-03-04")).status).toBe("not_first_session");
    expect(ask).not.toHaveBeenCalled();
    expect((await job(db, ask, 3, "2031-03-03")).status).toBe("stored");
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("once a month: a second run in the same month asks nothing", async () => {
    const db = await freshDb("main");
    const ask = asker(answer(RAW));
    expect((await job(db, ask)).status).toBe("stored");
    expect((await job(db, ask)).status).toBe("already_run");
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("a spent budget or a rules-only answer stores nothing", async () => {
    for (const res of [
      answer([], { live: false, budgetExhausted: true, modelId: null }),
      answer([], { live: false, modelId: null }),
    ]) {
      const db = await freshDb("main");
      const before = await dump(db, new Set());
      const r = await job(db, asker(res));
      expect(r.status).toBe(res.budgetExhausted ? "no_budget" : "no_live_model");
      expect(await dump(db, new Set())).toEqual(before);
    }
  });

  it("a live answer with an empty list stores nothing and records no month", async () => {
    const db = await freshDb("main");
    expect((await job(db, asker(answer([])))).status).toBe("no_answer");
    expect(await count(db, "angle_proposal")).toBe(0);
  });
});

describe("what it writes (D-1735, D-1736)", () => {
  it("stores at most the monthly limit, charges each stored one, and cuts the rest unread", async () => {
    const db = await freshDb("main");
    const r = await job(db, asker(answer(RAW)), 3);
    expect(r).toEqual({ status: "stored", stored: 3, refused: 0, cut: 17 });
    expect(await count(db, "angle_proposal")).toBe(3);
    const charges = (
      await db.execute("SELECT * FROM trial_ledger WHERE kind = 'new_lineage' ORDER BY id")
    ).rows;
    expect(charges).toHaveLength(3);
    for (const c of charges) {
      expect(String(c.lineage_id)).toMatch(/^llm_proposal_[0-9a-f]{12}$/);
      expect(c.market).toBe("AU");
      expect(c.split_version).toBe(0);
      expect(["angle", "challenger"]).toContain(String(c.variant));
      expect(lineageName(String(c.lineage_id))).toBe(
        "Model-written rule proposal (kept for your review)",
      );
    }
    const ids = (await db.execute("SELECT proposal_id FROM angle_proposal")).rows.map((x) =>
      lineageOf(String(x.proposal_id)),
    );
    expect(charges.map((c) => String(c.lineage_id)).sort()).toEqual(ids.sort());
    const log = (await db.execute("SELECT level, source, message FROM app_log")).rows;
    expect(log).toHaveLength(1);
    expect(String(log[0]!.message)).toBe(
      "The monthly model-written proposals were checked: 3 kept for you to review, 0 refused. Nothing in the book changed.",
    );
  });

  it("with a limit of 10: the first ten items are read; the six valid ones are stored and charged, four out-of-grammar ones refused", async () => {
    const db = await freshDb("main");
    const r = await job(db, asker(answer(RAW)), 10);
    expect(r).toEqual({ status: "stored", stored: 6, refused: 4, cut: 10 });
    const states = (
      await db.execute("SELECT state, COUNT(*) n FROM angle_proposal GROUP BY state ORDER BY state")
    ).rows.map((x) => `${x.state}:${x.n}`);
    expect(states).toEqual(["refused_schema:4", "stored:6"]);
    expect(await count(db, "trial_ledger")).toBe(6);
  });

  it("the duplicate, hostile and weight fixtures, asked for in their own month, are refused and never charged", async () => {
    const db = await freshDb("main");
    await job(db, asker(answer(RAW.slice(0, 6))), 10, "2031-03-03"); // the six valid ones, month 1
    const before = await count(db, "trial_ledger");
    const r = await job(db, asker(answer(RAW.slice(10))), 10, "2031-04-01");
    expect(r).toEqual({ status: "stored", stored: 0, refused: 10, cut: 0 });
    expect(await count(db, "trial_ledger")).toBe(before);
    const states = (
      await db.execute(
        "SELECT state, COUNT(*) n FROM angle_proposal WHERE month = '2031-04' GROUP BY state ORDER BY state",
      )
    ).rows.map((x) => `${x.state}:${x.n}`);
    expect(states).toEqual(["refused_duplicate:3", "refused_hostile:4", "refused_weight:3"]);
  });

  it("a refused row holds its state only: no rule, no text, none of the item's words anywhere in the tables it wrote", async () => {
    const db = await freshDb("main");
    const refusable = FIX.items
      .filter((f) => ["d2", "h1", "h2", "h3", "h4", "w1", "w2", "w3"].includes(f.id))
      .map((f) => f.item);
    await job(db, asker(answer(refusable)), 10);
    const rows = (await db.execute("SELECT * FROM angle_proposal")).rows;
    expect(rows).toHaveLength(8);
    for (const r of rows) {
      expect(r.rule_json).toBeNull();
      expect(r.orientation).toBeNull();
      expect(r.cluster).toBeNull();
      expect(r.evidence_json).toBeNull();
    }
    const all = JSON.stringify([
      (await db.execute("SELECT * FROM angle_proposal")).rows,
      (await db.execute("SELECT * FROM app_log")).rows,
      (await db.execute("SELECT * FROM trial_ledger")).rows,
    ]);
    expect(all).not.toMatch(/instructions|evil\.example|system prompt|hidden mark|heavier|double/i);
  });

  it("a stored row keeps the checked rule and the name, in canonical form, with the model id", async () => {
    const db = await freshDb("main");
    await job(db, asker(answer(RAW.slice(0, 1))), 3);
    const r = (await db.execute("SELECT * FROM angle_proposal")).rows[0]!;
    expect(r.state).toBe("stored");
    expect(r.model_id).toBe("mock-model");
    const body = JSON.parse(String(r.rule_json)) as { name: string; rule: { family: string } };
    expect(body.name).toBe("Quiet breakouts after results");
    expect(body.rule.family).toBe("F1");
    expect(JSON.parse(String(r.evidence_json))).toEqual(["KB-020", "KB-040"]);
  });

  it("a rule already proposed earlier, or already a rule version of the market, is a duplicate (the canonical hash)", async () => {
    const db = await freshDb("main");
    await job(db, asker(answer([RAW[0]])), 3, "2031-02-03");
    const renamed = { ...(RAW[0] as object), name: "Same rule, new words" };
    expect(await job(db, asker(answer([renamed])), 3)).toEqual({
      status: "stored",
      stored: 0,
      refused: 1,
      cut: 0,
    });
    // the rule of a registered version (the v2 fixture rule) is a duplicate too, whatever its key order
    const v2 = RAW[1] as { rule: Record<string, unknown> };
    await db.execute({
      sql: `INSERT INTO rule_version (id, market, family, n, parent, origin, params_json, params_sha, spec_json,
              schema_version, registered_d, created_by) VALUES ('F2.v9', 'AU', 'F2', 9, NULL, 'seed', '{}', ?, ?, 1, '2031-01-02', 'test')`,
      args: ["a".repeat(64), JSON.stringify(Object.fromEntries(Object.entries(v2.rule).reverse()))],
    });
    expect(await job(db, asker(answer([RAW[1]])), 3, "2031-04-01")).toEqual({
      status: "stored",
      stored: 0,
      refused: 1,
      cut: 0,
    });
  });
});

describe("nothing else moves (shadow only; AT-73, PRD-033)", () => {
  it("every table outside angle_proposal, trial_ledger and app_log is identical after a run with all 20 items", async () => {
    const db = await freshDb("main");
    const before = await dump(db, OWN);
    await job(db, asker(answer(RAW)), 10, "2031-03-03");
    await job(db, asker(answer(RAW.slice(10))), 10, "2031-04-01");
    expect(await dump(db, OWN)).toEqual(before);
    // and in the three own tables only the expected kinds of rows appeared
    const kinds = (await db.execute("SELECT DISTINCT kind FROM trial_ledger")).rows.map((r) =>
      String(r.kind),
    );
    expect(kinds).toEqual(["new_lineage"]);
  });
});
