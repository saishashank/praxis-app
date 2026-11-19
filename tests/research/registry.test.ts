// @vitest-environment node
// The registry gate (M23 A2; CXA-015, D-1602…D-1605): the plan is frozen first (or the trigger aborts), one look per lineage and
// market, a second look is refused and audited and never computes, below sample writes nothing, a changed plan is refused.
import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import { preregister, sha256Hex, takeLook, canonicalJson } from "@/lib/research/registry";
import { displayVerdict } from "@/lib/research/verdict";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const NOW = "2030-01-02T10:00:00Z";
const PLAN = { hypothesis: "A synthetic claim.", floor: 5 };

const n = async (db: Client, t: string): Promise<number> =>
  Number((await db.execute(`SELECT COUNT(*) n FROM ${t}`)).rows[0]!.n);

const look = (db: Client, sha: string, compute: () => never | object, lineage = "zz_one") =>
  takeLook(db, {
    lineage,
    market: "AU",
    sha,
    caller: "test",
    now: NOW,
    compute: compute as never,
  });

const GOOD = () => ({ verdict: "PASS" as const, nSetups: 12, nBlocks: 4, stats: { mean: 7 } });

describe("preregister", () => {
  it("freezes a plan once with the sha256 of its canonical text; the same plan again is present", async () => {
    const db = await freshDb("main");
    const a = await preregister(db, {
      lineage: "zz_one",
      market: "AU",
      item: "CXA-003",
      frozen: PLAN,
      now: NOW,
    });
    expect(a).toEqual({ status: "written", sha: sha256Hex(canonicalJson(PLAN)) });
    const again = await preregister(db, {
      lineage: "zz_one",
      market: "AU",
      item: "CXA-003",
      frozen: { floor: 5, hypothesis: "A synthetic claim." }, // key order does not matter
      now: NOW,
    });
    expect(again.status).toBe("present");
    expect(await n(db, "research_prereg")).toBe(1);
  });

  it("a changed plan is refused, logged for the Owner, and the first plan stands", async () => {
    const db = await freshDb("main");
    const a = await preregister(db, {
      lineage: "zz_one",
      market: "AU",
      item: "CXA-003",
      frozen: PLAN,
      now: NOW,
    });
    const b = await preregister(db, {
      lineage: "zz_one",
      market: "AU",
      item: "CXA-003",
      frozen: { ...PLAN, floor: 1 },
      now: NOW,
    });
    expect(b).toEqual({ status: "refused", reason: "changed", sha: a.sha });
    const stored = await db.execute("SELECT sha FROM research_prereg");
    expect(stored.rows.map((r) => r.sha)).toEqual([a.sha]);
    const log = await db.execute("SELECT level, message FROM app_log");
    expect(log.rows).toHaveLength(1);
    expect(String(log.rows[0]!.message)).toMatch(/changed after it was frozen/);
  });

  it("a plan that is not JSON text is refused loudly", async () => {
    const db = await freshDb("main");
    await expect(
      preregister(db, {
        lineage: "zz_one",
        market: "AU",
        item: "CXA-003",
        frozen: "not json",
        now: NOW,
      }),
    ).rejects.toThrow();
  });
});

describe("takeLook", () => {
  it("writes the look and its numbers together, with the three-word vocabulary", async () => {
    const db = await freshDb("main");
    const { sha } = await preregister(db, {
      lineage: "zz_one",
      market: "AU",
      item: "CXA-003",
      frozen: PLAN,
      now: NOW,
    });
    const r = await look(db, sha, GOOD);
    expect(r).toMatchObject({ status: "looked", verdict: "PASS", nSetups: 12, nBlocks: 4 });
    const row = (
      await db.execute("SELECT lineage, market, looked_at, prereg_sha, verdict FROM holdout_look")
    ).rows[0]!;
    expect({ ...row }).toEqual({
      lineage: "zz_one",
      market: "AU",
      looked_at: NOW,
      prereg_sha: sha,
      verdict: "PASS",
    });
    const res = (
      await db.execute("SELECT n_setups, n_blocks, stats_json, prereg_sha FROM research_result")
    ).rows[0]!;
    expect({ ...res }).toEqual({
      n_setups: 12,
      n_blocks: 4,
      stats_json: '{"mean":7}',
      prereg_sha: sha,
    });
  });

  it("the plan is frozen first: without it nothing is written, and the database trigger would abort a direct insert", async () => {
    const db = await freshDb("main");
    let called = 0;
    const r = await look(db, "a".repeat(64), () => {
      called += 1;
      return GOOD() as never;
    });
    expect(r).toEqual({ status: "refused", reason: "not_preregistered" });
    expect(called).toBe(0);
    expect(await n(db, "holdout_look")).toBe(0);
    await expect(
      db.execute(
        `INSERT INTO holdout_look (lineage, market, looked_at, prereg_sha, verdict) VALUES ('zz_one', 'AU', '${NOW}', '${"a".repeat(64)}', 'PASS')`,
      ),
    ).rejects.toThrow(/PreregistrationMissing/);
  });

  it("a sha that is not the frozen one is refused", async () => {
    const db = await freshDb("main");
    await preregister(db, {
      lineage: "zz_one",
      market: "AU",
      item: "CXA-003",
      frozen: PLAN,
      now: NOW,
    });
    const r = await look(db, "b".repeat(64), GOOD);
    expect(r).toEqual({ status: "refused", reason: "not_preregistered" });
    expect(await n(db, "holdout_look")).toBe(0);
  });

  it("a second look is refused, audited and logged; compute is not called; nothing throws", async () => {
    const db = await freshDb("main");
    const { sha } = await preregister(db, {
      lineage: "zz_one",
      market: "AU",
      item: "CXA-003",
      frozen: PLAN,
      now: NOW,
    });
    await look(db, sha, GOOD);
    let called = 0;
    const r = await takeLook(db, {
      lineage: "zz_one",
      market: "AU",
      sha,
      caller: "second-caller",
      now: "2030-01-03T10:00:00Z",
      compute: () => {
        called += 1;
        return { verdict: "NULL", nSetups: 1, nBlocks: 1, stats: {} };
      },
    });
    expect(r).toEqual({ status: "refused", reason: "already_looked" });
    expect(called).toBe(0);
    expect(await n(db, "holdout_look")).toBe(1);
    expect((await db.execute("SELECT verdict FROM holdout_look")).rows[0]!.verdict).toBe("PASS");
    const ref = (
      await db.execute("SELECT lineage, market, at, prereg_sha, caller FROM holdout_look_refusal")
    ).rows;
    expect(ref.map((x) => ({ ...x }))).toEqual([
      {
        lineage: "zz_one",
        market: "AU",
        at: "2030-01-03T10:00:00Z",
        prereg_sha: sha,
        caller: "second-caller",
      },
    ]);
    const log = await db.execute("SELECT level, source, message FROM app_log");
    expect(log.rows.map((x) => ({ ...x }))).toEqual([
      {
        level: "warn",
        source: "research",
        message: "A second look at a finished test was refused.",
      },
    ]);
    // a third attempt at the same instant still does not throw (the audit key repeats and is kept once)
    const again = await takeLook(db, {
      lineage: "zz_one",
      market: "AU",
      sha,
      caller: "second-caller",
      now: "2030-01-03T10:00:00Z",
      compute: () => GOOD(),
    });
    expect(again.status).toBe("refused");
    expect(await n(db, "holdout_look_refusal")).toBe(1);
  });

  it("below sample writes no look and no result, and the look stays available (D-1605)", async () => {
    const db = await freshDb("main");
    const { sha } = await preregister(db, {
      lineage: "zz_one",
      market: "AU",
      item: "CXA-003",
      frozen: PLAN,
      now: NOW,
    });
    const r = await look(db, sha, () => ({ status: "below_sample", reason: "too few" }) as never);
    expect(r).toEqual({ status: "below_sample", reason: "too few" });
    expect(await n(db, "holdout_look")).toBe(0);
    expect(await n(db, "research_result")).toBe(0);
    expect(await n(db, "holdout_look_refusal")).toBe(0);
    // the day n arrives, the one look is still there
    const later = await look(db, sha, GOOD);
    expect(later.status).toBe("looked");
  });

  it("an INCONCLUSIVE verdict whose statistic was undefined is a look and is spent", async () => {
    const db = await freshDb("main");
    const { sha } = await preregister(db, {
      lineage: "zz_one",
      market: "AU",
      item: "CXA-003",
      frozen: PLAN,
      now: NOW,
    });
    const r = await look(db, sha, () => ({
      verdict: "INCONCLUSIVE",
      nSetups: 9,
      nBlocks: 3,
      stats: {},
    }));
    expect(r.status).toBe("looked");
    expect((await look(db, sha, GOOD)).status).toBe("refused");
  });

  it("a verdict outside the three words is refused before any write", async () => {
    const db = await freshDb("main");
    const { sha } = await preregister(db, {
      lineage: "zz_one",
      market: "AU",
      item: "CXA-003",
      frozen: PLAN,
      now: NOW,
    });
    await expect(
      look(db, sha, () => ({ verdict: "pass", nSetups: 1, nBlocks: 1, stats: {} })),
    ).rejects.toThrow();
    expect(await n(db, "holdout_look")).toBe(0);
  });

  it("a primary-key conflict at insert (another writer looked between the probe and the write) is the same refusal", async () => {
    const db = await freshDb("main");
    const { sha } = await preregister(db, {
      lineage: "zz_one",
      market: "AU",
      item: "CXA-003",
      frozen: PLAN,
      now: NOW,
    });
    const r = await takeLook(db, {
      lineage: "zz_one",
      market: "AU",
      sha,
      caller: "race",
      now: NOW,
      compute: async () => {
        // the racing writer gets in while this computation runs
        await db.execute(
          `INSERT INTO holdout_look (lineage, market, looked_at, prereg_sha, verdict) VALUES ('zz_one', 'AU', '${NOW}', '${sha}', 'NULL')`,
        );
        return GOOD();
      },
    });
    expect(r).toEqual({ status: "refused", reason: "already_looked" });
    expect(await n(db, "holdout_look")).toBe(1);
    expect(await n(db, "research_result")).toBe(0);
    expect(await n(db, "holdout_look_refusal")).toBe(1);
  });
});

describe("displayVerdict (D-1602)", () => {
  it("maps the older words and keeps the three", () => {
    expect(displayVerdict("pass")).toBe("PASS");
    expect(displayVerdict("fail")).toBe("NULL");
    expect(displayVerdict("FAIL")).toBe("NULL");
    for (const w of ["PASS", "NULL", "INCONCLUSIVE"]) expect(displayVerdict(w)).toBe(w);
    expect(displayVerdict("maybe")).toBeNull();
  });
});
