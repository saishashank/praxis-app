// @vitest-environment node
// AT-72 (registry part; M23 A2; CXA-015, D-1602…D-1605, D-1609): on all four writer kinds (short-selling shadow, outside-signal
// state, Committee trial, offline ledger) a second look is refused, audited in holdout_look_refusal and logged, and never
// computes; the page list carries every look with its hash and the three-word vocabulary; F1.v2-mom is NULL and never re-looked.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import { evaluateAlt, ALT_LINEAGE, PREREG_SHA as ALT_SHA } from "@/lib/regime/alt/evaluate";
import { evaluateShort, SHORT_LINEAGE, PREREG_SHA as SHORT_SHA } from "@/lib/shortShadow/evaluate";
import { TRIAL_LINEAGE } from "@/lib/committee/prereg";
import { LEDGER_PATH } from "@/lib/research/ledgerFile";
import { preregister, takeLook } from "@/lib/research/registry";
import { syncLedger } from "@/lib/research/steps/lookSync";
import { registryRows } from "@/lib/research/view";
import { cleanupTempDbs, freshDb } from "../../db/helpers";

afterEach(cleanupTempDbs);

const NOW = "2030-03-01T10:00:00Z";
const LATER = "2030-03-02T10:00:00Z";

async function firstLook(
  db: Client,
  lineage: string,
  item: "VAL-121" | "DAT-248" | "VAL-111",
  frozen: string,
) {
  const p = await preregister(db, { lineage, market: "AU", item, frozen, now: NOW });
  expect(p.status).toBe("written");
  const r = await takeLook(db, {
    lineage,
    market: "AU",
    sha: p.sha,
    caller: "test",
    now: NOW,
    compute: () => ({ verdict: "NULL", nSetups: 3, nBlocks: 1, stats: {} }),
  });
  expect(r.status).toBe("looked");
  return p.sha;
}

const refusals = async (db: Client, lineage: string): Promise<Array<Record<string, unknown>>> =>
  (
    await db.execute({
      sql: "SELECT lineage, market, at, prereg_sha, caller FROM holdout_look_refusal WHERE lineage = ?",
      args: [lineage],
    })
  ).rows.map((r) => ({ ...r }));
const warnCount = async (db: Client): Promise<number> =>
  Number(
    (await db.execute("SELECT COUNT(*) n FROM app_log WHERE message LIKE 'A second look%'"))
      .rows[0]!.n,
  );

describe("AT-72: a second look is refused and audited on every writer kind", () => {
  it("short-selling shadow test (the writer's own entry point)", async () => {
    const db = await freshDb("main");
    // the first look is the writer's own pre-registration text; here a recorded look stands in for a finished test
    const plan = await preregister(db, {
      lineage: SHORT_LINEAGE,
      market: "AU",
      item: "VAL-121",
      frozen: { hypothesis: "x" },
      now: NOW,
    });
    expect(plan.status).toBe("written");
    await db.execute(
      `INSERT INTO holdout_look (lineage, market, looked_at, prereg_sha, verdict) VALUES ('${SHORT_LINEAGE}', 'AU', '${NOW}', '${plan.sha}', 'PASS')`,
    );
    const r = await evaluateShort(db, { market: "AU", now: () => LATER });
    // the plan stored first is not the writer's own text: the writer refuses the second look either way
    expect(r).toEqual({ status: "refused", reason: "already_looked" });
    expect((await refusals(db, SHORT_LINEAGE)).map((x) => x.at)).toEqual([LATER]);
    expect(await warnCount(db)).toBeGreaterThanOrEqual(1);
    expect(SHORT_SHA).toMatch(/^[0-9a-f]{64}$/);
  });

  it("outside-signal market-state test (the writer's own entry point)", async () => {
    const db = await freshDb("main");
    const sha = await firstLook(db, ALT_LINEAGE, "DAT-248", '{"hypothesis":"x"}');
    const r = await evaluateAlt(db, { market: "AU", now: () => LATER });
    expect(r).toEqual({ status: "refused", reason: "already_looked" });
    expect((await refusals(db, ALT_LINEAGE)).map((x) => [x.at, x.caller])).toEqual([
      [LATER, "regime_altinputs"],
    ]);
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    expect(ALT_SHA).toMatch(/^[0-9a-f]{64}$/);
  });

  it("Committee trial (through the gate it writes with)", async () => {
    const db = await freshDb("main");
    const frozen = '{"market":"AU","statistic":"x"}';
    const sha = await firstLook(db, TRIAL_LINEAGE, "VAL-111", frozen);
    let computed = 0;
    const r = await takeLook(db, {
      lineage: TRIAL_LINEAGE,
      market: "AU",
      sha,
      caller: "committee_trial",
      now: LATER,
      compute: () => {
        computed += 1;
        return { verdict: "PASS", nSetups: 1, nBlocks: 1, stats: {} };
      },
    });
    expect(r).toEqual({ status: "refused", reason: "already_looked" });
    expect(computed).toBe(0);
    expect(await refusals(db, TRIAL_LINEAGE)).toEqual([
      {
        lineage: TRIAL_LINEAGE,
        market: "AU",
        at: LATER,
        prereg_sha: sha,
        caller: "committee_trial",
      },
    ]);
  });

  it("offline ledger (an imported look cannot be looked at again)", async () => {
    const db = await freshDb("main");
    await syncLedger(db, { market: "AU", now: NOW });
    const rows = await registryRows(db, "AU");
    const f1 = rows.find((x) => x.lineage === "f1_v2_mom")!;
    const r = await takeLook(db, {
      lineage: "f1_v2_mom",
      market: "AU",
      sha: f1.sha,
      caller: "ledger",
      now: LATER,
      compute: () => ({ verdict: "PASS", nSetups: 1, nBlocks: 1, stats: {} }),
    });
    expect(r).toEqual({ status: "refused", reason: "already_looked" });
    expect((await refusals(db, "f1_v2_mom")).length).toBe(1);
    // the import itself is idempotent: it never turns into a second look
    await syncLedger(db, { market: "AU", now: LATER });
    expect((await refusals(db, "f1_v2_mom")).length).toBe(1);
  });
});

describe("AT-72: the list carries every look with its hash; F1.v2-mom is NULL", () => {
  it("lists the looks oldest first with full hashes and the three words", async () => {
    const db = await freshDb("main");
    await syncLedger(db, { market: "AU", now: NOW });
    await firstLook(db, "zz_extra", "VAL-121", '{"hypothesis":"extra"}');
    const rows = await registryRows(db, "AU");
    // the committed ledger's looks come first, in ledger order (one timestamp, then lineage), then the one taken here
    const ledgerLooks = (
      JSON.parse(readFileSync(join(__dirname, "../../..", LEDGER_PATH), "utf8")) as {
        entries: { lineage: string; verdict?: string }[];
      }
    ).entries
      .filter((e) => e.verdict !== undefined)
      .map((e) => e.lineage);
    expect(ledgerLooks[0]).toBe("f1_v2_mom");
    expect(rows.map((r) => r.lineage)).toEqual([...ledgerLooks, "zz_extra"]);
    for (const r of rows) {
      expect(r.sha).toMatch(/^[0-9a-f]{64}$/);
      expect(["PASS", "NULL", "INCONCLUSIVE"]).toContain(r.verdict);
    }
    expect(rows[0]).toMatchObject({ name: "Long-hold momentum rule", verdict: "NULL" });
    expect(await registryRows(db, "IN")).toEqual([]);
  });
});
