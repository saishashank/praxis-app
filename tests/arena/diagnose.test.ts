// Read-only batch 2b diagnosis (src/lib/arena/diagnose.ts): on the batch 2b golden scenario it
// prints the universe, inputs and family counts with the live and the default parameters, writes no
// row, and its client refuses every statement but a plain SELECT before it reaches the database.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  diagnoseDay,
  diagnoseMain,
  picksReadiness,
  readOnly,
  WriteRefused,
} from "@/lib/arena/diagnose";
import { seedRuleVersions } from "@/lib/learning/ruleVersions";
import { cleanupTempDbs } from "../db/helpers";
import { DATES, freshReplayDb, setMode } from "../agents/batch2bHarness";
import { buildGolden, D } from "../agents/batch2bScenario";

vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });

async function tableCounts(db: Client): Promise<Record<string, number>> {
  const names = await db.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  );
  const out: Record<string, number> = {};
  for (const r of names.rows) {
    const n = await db.execute(`SELECT COUNT(*) AS n FROM "${String(r.name)}"`);
    out[String(r.name)] = Number(n.rows[0]!.n);
  }
  return out;
}

let db: Client;
beforeAll(async () => {
  db = await freshReplayDb();
  await buildGolden(db);
  await setMode(db, "full");
});
afterAll(cleanupTempDbs);

describe("diagnoseDay", () => {
  it("prints counts for the decision session and writes nothing", async () => {
    const before = await tableCounts(db);
    const lines: string[] = [];
    await diagnoseDay(readOnly(db), DATES[D]!, (l) => lines.push(l));
    expect(await tableCounts(db)).toEqual(before);
    const text = lines.join("\n");
    expect(lines[0]).toMatch(new RegExp(`^diagnose ${DATES[D]}: mode=full universe=\\[".+\\]`));
    expect(text).toMatch(/activeUniverseWithBar=[1-9]/);
    // D-861: tiers recomputed from the stored bars, with the window and the U1 pool's bar counts
    expect(lines[1]).toMatch(
      /^ {2}tiers now: \{.+\} window=\d{4}-\d{2}-\d{2}\.\.\S+ sessionsWithBars=[1-9]\d* busiest=[1-9]\d* thin=\[.*\] u1AdvPool=\d+ poolBars: 60=\d+ 54-59=\d+ under54=\d+$/,
    );
    expect(text).toMatch(/versions: none \(single v1 run\)/);
    // the golden index history is shorter than the default regime warm-up: regime "unknown" with
    // no partial reason, so batch 2b would still record success while every family is blocked
    expect(text).toMatch(/inputs: regime=unknown regimeD=\d{4}-\d{2}-\d{2} partial=\[\]/);
    expect(text).toMatch(/index: rows=\d+ visibleAtCutoff=\d+ first=\S+ needed=1281 raw=unknown/);
    expect(text).toMatch(/live params: candidates=0 by=\{\}/);
    expect(text).toMatch(/live params: blocked=[1-9]\d* .*reasons=\{"regime_unknown":/);
    expect(text).toMatch(/default params: blocked=[1-9]/);
  });

  it("lists the live rule versions once they are seeded", async () => {
    await seedRuleVersions(db, { market: "AU", d: "2030-01-02" });
    const lines: string[] = [];
    await diagnoseDay(readOnly(db), DATES[D]!, (l) => lines.push(l));
    const text = lines.join("\n");
    expect(text).toMatch(/versions: live=\["F1\.v1:\d+keys",.*\] extra=\[\]/);
    expect(text).toMatch(/live params: blocked=[1-9]/);
  });

  it("an empty database prints zero counts and no regime", async () => {
    const empty = await freshReplayDb();
    const lines: string[] = [];
    await diagnoseDay(readOnly(empty), "2031-01-02", (l) => lines.push(l));
    const text = lines.join("\n");
    expect(lines[0]).toMatch(/universe=\[\] lastUniverseD=none barsOnD=0 activeUniverseWithBar=0/);
    expect(lines[1]).toMatch(
      /tiers now: \{\} .* sessionsWithBars=0 busiest=0 thin=\[\] u1AdvPool=0 poolBars: 60=0 54-59=0 under54=0$/,
    );
    expect(text).toMatch(/inputs: regime=unknown regimeD=none partial=\["a3_no_index_data"\]/);
    expect(text).toMatch(
      /index: rows=0 visibleAtCutoff=0 first=none needed=1281 raw=none smaNull=true/,
    );
    expect(text).toMatch(/bars per code: min=0 median=0 max=0 /);
  });

  it("says so when the market row is missing", async () => {
    const lines: string[] = [];
    const empty = { execute: async () => ({ rows: [] }) } as unknown as Client;
    await diagnoseDay(empty, "2031-01-01", (l) => lines.push(l));
    expect(lines).toEqual(["diagnose 2031-01-01: market row missing"]);
  });
});

describe("picksReadiness (D-883)", () => {
  it("an empty database: no splits and no ledger rows, and nothing is written", async () => {
    const empty = await freshReplayDb();
    const before = await tableCounts(empty);
    const lines: string[] = [];
    await picksReadiness(readOnly(empty), (l) => lines.push(l));
    expect(lines).toEqual(["diagnose picks: splits=0", "  ledger: rows=0"]);
    expect(await tableCounts(empty)).toEqual(before);
  });

  it("per lineage: the latest split and the closed development rows by rule version and variant", async () => {
    const lines: string[] = [];
    const calls: string[] = [];
    const fake = {
      execute: async (q: { sql: string }) => {
        calls.push(q.sql);
        if (q.sql.includes("FROM lineage_split")) {
          return {
            rows: [
              {
                lineage_id: "AU:F1",
                version: 2n,
                dev_end_d: "2024-06-28",
                data_end_d: "2026-10-31",
                deferred_until_d: null,
              },
              {
                lineage_id: "AU:F2",
                version: 1n,
                dev_end_d: null,
                data_end_d: "2026-10-31",
                deferred_until_d: "2027-01-04",
              },
            ],
          };
        }
        if (q.sql.includes("GROUP BY k")) return { rows: [{ k: "F1.v1|full", n: 0n }] };
        return { rows: [{ f: 1n, n: 21n, closed: 0n, first: "2026-11-03", last: "2026-11-03" }] };
      },
    } as unknown as Client;
    await picksReadiness(fake, (l) => lines.push(l));
    expect(lines).toEqual([
      "diagnose picks: splits=2",
      '  AU:F1: v=2 devEnd=2024-06-28 dataEnd=2026-10-31 deferredUntil=none devClosed={"F1.v1|full":"0"}',
      "  AU:F2: v=1 devEnd=none dataEnd=2026-10-31 deferredUntil=2027-01-04 devClosed={}",
      "  ledger forward=1: rows=21 closed=0 entries=2026-11-03..2026-11-03",
    ]);
    expect(calls.filter((s) => s.includes("GROUP BY k"))).toHaveLength(1); // no dev end: no count
  });
});

describe("diagnoseMain", () => {
  it("rejects a call without valid dates (exit 2) and an unconfigured database (exit 1)", async () => {
    const lines: string[] = [];
    expect(await diagnoseMain([], {}, (l) => lines.push(l))).toBe(2);
    expect(await diagnoseMain(["--dates", "30/10/2026"], {}, (l) => lines.push(l))).toBe(2);
    expect(
      await diagnoseMain(["--dates", "2026-10-30"], { TURSO_MAIN_URL: " " }, (l) => lines.push(l)),
    ).toBe(1);
    expect(lines.at(-1)).toBe("diagnose: failed (database not configured)");
  });

  it("reports failures by error name only, never the message or the URL", async () => {
    const lines: string[] = [];
    const env = (url: string) => ({ TURSO_MAIN_URL: url, TURSO_MAIN_TOKEN: "secret-token" });
    // a database that cannot be opened
    expect(
      await diagnoseMain(["--dates", "2026-10-30"], env("file:/no-such-dir-xyz/secret.db"), (l) =>
        lines.push(l),
      ),
    ).toBe(1);
    // an empty (unmigrated) database: every session fails, the next one still runs
    const dir = mkdtempSync(path.join(tmpdir(), "praxis-diagnose-"));
    const url = pathToFileURL(path.join(dir, "empty.db")).href;
    expect(
      await diagnoseMain(["--dates", "2026-10-29,2026-10-30"], env(url), (l) => lines.push(l)),
    ).toBe(1);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^diagnose: failed \(\w+\)$/);
    expect(lines[1]).toMatch(/^diagnose 2026-10-29: failed \(\w+\)$/);
    expect(lines[2]).toMatch(/^diagnose 2026-10-30: failed \(\w+\)$/);
    expect(lines[3]).toMatch(/^diagnose picks: failed \(\w+\)$/);
    expect(lines.join("\n")).not.toMatch(/secret|file:/);
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Windows may keep the file locked for a moment; the OS temp folder is cleaned later.
    }
  });
});

describe("readOnly", () => {
  const calls: unknown[] = [];
  const fake = {
    execute: async (s: unknown, a?: unknown) => (calls.push([s, a]), { rows: [] }),
    batch: async (s: unknown, mode: unknown) => (calls.push([s, mode]), []),
    close: () => calls.push("close"),
    protocol: "file",
  } as unknown as Client;
  const ro = readOnly(fake);

  it("passes plain SELECT and WITH ... SELECT statements through, batches in read mode", async () => {
    await ro.execute("SELECT 1");
    await ro.execute("SELECT ?", [1]);
    await ro.execute({ sql: "WITH x AS (SELECT 1) SELECT * FROM x", args: [] });
    await ro.batch(["SELECT 1"]);
    ro.close();
    expect(ro.protocol).toBe("file");
    expect(calls).toEqual([
      ["SELECT 1", undefined],
      ["SELECT ?", [1]],
      [{ sql: "WITH x AS (SELECT 1) SELECT * FROM x", args: [] }, undefined],
      [["SELECT 1"], "read"],
      "close",
    ]);
  });

  it("refuses every write before it reaches the database", () => {
    const n = calls.length;
    for (const sql of [
      "INSERT INTO signal VALUES (1)",
      "UPDATE run_record SET status = 'x'",
      "DELETE FROM signal",
      "REPLACE INTO signal VALUES (1)",
      "WITH x AS (SELECT 1) INSERT INTO signal SELECT * FROM x",
      "SELECT 1; DROP TABLE signal",
      "PRAGMA journal_mode = WAL",
    ]) {
      expect(() => ro.execute(sql)).toThrow(WriteRefused);
    }
    expect(() => ro.batch(["SELECT 1", "DELETE FROM signal"])).toThrow(WriteRefused);
    for (const k of ["transaction", "executeMultiple", "migrate", "sync"] as const) {
      expect(() => (ro[k] as () => unknown)()).toThrow(WriteRefused);
    }
    expect(calls.length).toBe(n);
  });
});
