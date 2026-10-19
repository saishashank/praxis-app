// @vitest-environment node
// The `learn` and `words` phases over the golden nights (M6 T11; D-113: the attribution hook is wired
// here; design 4.1 order 2b -> 3 -> learn -> words). The synthetic scenario of the batch 2b / 3 tests
// runs through 2a, 2b and 3; on the last nights `learn` and `words` follow back-to-back as in the job.
import type { Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { reviewDay } from "@/lib/agents/batch3";
import { learnDay, learnKey, type LearnResult } from "@/lib/learning/learnStage";
import { wordsDay, wordsKey, type WordsLlm } from "@/lib/learning/wordsStage";
import { MemoryStore } from "@/lib/llm/store";
import { readNarrativeRow } from "@/lib/review/sections";
import { cleanupTempDbs } from "../db/helpers";
import {
  DATES,
  MARKET,
  NOW,
  freshReplayDb,
  runNights,
  setMode,
  startCohortsAt,
  testParams,
} from "../agents/batch2bHarness";
import { buildGolden } from "../agents/batch2bScenario";
import { makeRouter } from "../llm/helpers";

vi.setConfig({ testTimeout: 300000, hookTimeout: 600000 });

const KEEP = ["E01", "E07", "E08", "C2-F1", "C2-F4", "C3-F4"];
const params = testParams();
const LAST = 320;
const FIRST_LEARN = LAST - 2;
const d = (i: number): string => DATES[i]!;

type Row = Record<string, unknown>;
const rows = async (db: Client, sql: string, args: (string | number)[] = []): Promise<Row[]> =>
  (await db.execute({ sql, args })).rows.map((r) => ({ ...r }));

const rulesOnly = (): WordsLlm => {
  const store = new MemoryStore();
  return {
    r5Router: makeRouter("rules-only", [], store).router,
    providers: [],
    routerFor: () => makeRouter("rules-only", [], store).router,
    store,
  };
};

async function dumpLedger(db: Client): Promise<string> {
  const parts: string[] = [];
  for (const sql of [
    "SELECT * FROM ledger_row ORDER BY id",
    "SELECT * FROM ledger_control ORDER BY row_id, idx",
    "SELECT run_id, scope, metric, d, value_json FROM replay_stat WHERE run_id LIKE 'arena-3%' ORDER BY run_id, scope, metric",
  ]) {
    parts.push(
      JSON.stringify(await rows(db, sql), (_, v) => (typeof v === "bigint" ? String(v) : v)),
    );
  }
  return parts.join("\n");
}

let db: Client;
const learns = new Map<string, LearnResult>();
let ledgerBefore = "";
let ledgerAfter = "";
beforeAll(async () => {
  db = await freshReplayDb();
  await buildGolden(db);
  await setMode(db, "full");
  await startCohortsAt(db, 295, KEEP);
  await runNights(db, params, 295, LAST, async (day) => {
    await reviewDay(db, { market: MARKET, d: day, replay: true, now: NOW, params });
    if (day < d(FIRST_LEARN)) return;
    if (day === d(LAST)) ledgerBefore = await dumpLedger(db);
    learns.set(day, await learnDay(db, { market: MARKET, d: day, replay: true, now: NOW, params }));
    if (day === d(LAST)) {
      ledgerAfter = await dumpLedger(db);
      await wordsDay(db, {
        market: MARKET,
        d: day,
        replay: true,
        now: NOW,
        params,
        llm: rulesOnly,
      });
    }
  });
});
afterAll(cleanupTempDbs);

describe("the nights", () => {
  it("learn ran after batch 3 on each night, keyed arena-learn:AU:<d>, and finished", () => {
    expect([...learns.keys()]).toEqual([d(FIRST_LEARN), d(FIRST_LEARN + 1), d(LAST)]);
    for (const [, r] of learns) {
      expect(r.status).toBe("success");
      expect(r.stats.variant).toBe("full");
      expect(r.stats.stepsFailed).toEqual([]);
    }
  });

  it("the run records are ordered 3 -> learn -> words for the last night", async () => {
    const runs = await rows(
      db,
      `SELECT job, concurrency_key AS k, status, id FROM run_record WHERE scheduled_for = ?
       AND job IN ('arena-signals', 'arena-review', 'arena-learn', 'arena-words') ORDER BY id`,
      [d(LAST)],
    );
    expect(runs.map((r) => r.job)).toEqual([
      "arena-signals",
      "arena-review",
      "arena-learn",
      "arena-words",
    ]);
    expect(runs.map((r) => r.k)).toContain(learnKey(MARKET, d(LAST)));
    expect(runs.map((r) => r.k)).toContain(wordsKey(MARKET, d(LAST)));
    expect(runs.every((r) => r.status === "success")).toBe(true);
  });
});

describe("attribution through the afterWrite hook (D-113)", () => {
  it("attributes forward rows, trades and not-taken signals; the hook ran in the ledger's own world", async () => {
    const kinds = await rows(db, "SELECT subject_kind AS k FROM attribution GROUP BY 1 ORDER BY 1");
    expect(kinds.map((r) => r.k)).toEqual(["blocked", "ledger_row", "trade"]);
    // `blocked` is only set inside the afterWrite hook: the learn phase wired it (D-113)
    for (const r of learns.values()) expect(r.stats.blocked).not.toBeNull();
    for (const r of learns.values()) expect(r.stats.attribution).not.toBeNull();
    const first = learns.get(d(FIRST_LEARN))!;
    expect(first.stats.attribution!.trades.inserted).toBeGreaterThan(0);
  });

  it("learn rewrites no ledger or batch 3 row (the sync it repeats is a no-op)", () => {
    expect(ledgerAfter).toBe(ledgerBefore);
  });

  it("no attribution row is dated after the night that wrote it (look-ahead)", async () => {
    const future = await rows(db, "SELECT COUNT(*) AS n FROM attribution WHERE d > ?", [d(LAST)]);
    expect(Number(future[0]!.n)).toBe(0);
    const entries = await rows(
      db,
      `SELECT COUNT(*) AS n FROM attribution WHERE subject_kind = 'ledger_row'
       AND json_extract(tags_json, '$.entry_d') > d`,
    );
    expect(Number(entries[0]!.n)).toBe(0);
  });
});

describe("comparisons (design 2.5)", () => {
  // The golden scenario has excess rows for one family only, so no pair has two sides here; the pairs
  // themselves are tested on seeded attribution in learnComparisons.test.ts.
  it("writes only labelled nightly rows, none dated after D", async () => {
    const cmp = await rows(
      db,
      "SELECT kind, pair_id, d, label FROM comparison_result WHERE d = ?",
      [d(LAST)],
    );
    expect(cmp.every((r) => r.kind === "nightly")).toBe(true);
    for (const r of cmp) {
      expect(
        String(r.label) === "descriptive — not a finding" ||
          /^not enough data \(n = \d+\)$/.test(String(r.label)),
      ).toBe(true);
    }
    expect(
      Number(
        (await rows(db, "SELECT COUNT(*) AS n FROM comparison_result WHERE d > ?", [d(LAST)]))[0]!
          .n,
      ),
    ).toBe(0);
    expect(learns.get(d(LAST))!.stats.comparisons).toBe(cmp.length);
  });
});

describe("idempotency", () => {
  it("a rerun of the last night is already_done and writes nothing", async () => {
    const before = await rows(db, "SELECT COUNT(*) AS n FROM attribution");
    const again = await learnDay(db, {
      market: MARKET,
      d: d(LAST),
      replay: true,
      now: NOW,
      params,
    });
    expect(again.status).toBe("already_done");
    expect(await rows(db, "SELECT COUNT(*) AS n FROM attribution")).toEqual(before);
  });

  it("a failed run can be repeated and reaches the same rows", async () => {
    const snapshot = JSON.stringify(
      await rows(db, "SELECT * FROM attribution ORDER BY subject_kind, subject_id, version"),
      (_, v) => (typeof v === "bigint" ? String(v) : v),
    );
    await db.execute({
      sql: "UPDATE run_record SET status = 'failed' WHERE concurrency_key = ?",
      args: [learnKey(MARKET, d(LAST))],
    });
    const again = await learnDay(db, {
      market: MARKET,
      d: d(LAST),
      replay: true,
      now: NOW,
      params,
    });
    expect(again.status).toBe("success");
    const after = JSON.stringify(
      await rows(db, "SELECT * FROM attribution ORDER BY subject_kind, subject_id, version"),
      (_, v) => (typeof v === "bigint" ? String(v) : v),
    );
    expect(after).toBe(snapshot);
  });
});

describe("words after learn", () => {
  it("the R5 narrative of the last night is stored under the words run, not under batch 3", async () => {
    const stored = await rows(db, "SELECT run_id FROM replay_stat WHERE metric = 'narrative'");
    expect(stored).toEqual([{ run_id: wordsKey(MARKET, d(LAST)) }]);
    const row = await readNarrativeRow(db, MARKET, d(LAST));
    expect(row?.kind).toBe("rules");
    // the facts-only lists carry the A6 output (section 4-6 content from learn)
    expect(row!.s6.join(" ")).toContain("Next trading session");
  });
});
