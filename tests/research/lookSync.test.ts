// @vitest-environment node
// The ledger import (M23 A2; D-1607, D-1609) and the lineage names: rows come from the committed file only, once; a mismatch
// or a database look missing from the file is one plain Owner line; the committed ledger holds F1.v2-mom as NULL, never re-looked.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import { LEDGER_PATH, parseLedger } from "@/lib/research/ledgerFile";
import { LINEAGE_NAMES, lineageName } from "@/lib/research/names";
import { preregister, sha256Hex } from "@/lib/research/registry";
import { RESEARCH_STEPS } from "@/lib/research/night";
import { diskIo, syncLedger, type LedgerIo } from "@/lib/research/steps/lookSync";
import { registryRows } from "@/lib/research/view";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const NOW = "2030-02-01T10:00:00Z";
const PLAN = '{"hypothesis":"a synthetic offline plan"}\n';
const LOOKED = "2030-01-15T00:00:00Z";

const ledgerOf = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    format: 1,
    entries: [
      {
        seq: 1,
        item: "CXA-003",
        lineage: "f1_v2_mom",
        market: "AU",
        sha: sha256Hex(PLAN),
        preregPath: "docs/research/prereg/ZZ-1.json",
        lookedAt: LOOKED,
        verdict: "NULL",
        nSetups: 40,
        nBlocks: 6,
        stats: { mean: -3 },
        ...over,
      },
    ],
  });
const io = (ledger: string, plan = PLAN): LedgerIo => ({
  read: (p) => (p === LEDGER_PATH ? ledger : p === "docs/research/prereg/ZZ-1.json" ? plan : null),
});
const n = async (db: Client, t: string): Promise<number> =>
  Number((await db.execute(`SELECT COUNT(*) n FROM ${t}`)).rows[0]!.n);
const warns = async (db: Client): Promise<string[]> =>
  (await db.execute("SELECT message FROM app_log WHERE level = 'warn' ORDER BY rowid")).rows.map(
    (r) => String(r.message),
  );

describe("syncLedger", () => {
  it("imports a new entry through the gate with the recorded date and numbers, once", async () => {
    const db = await freshDb("main");
    const a = await syncLedger(db, { market: "AU", now: NOW }, io(ledgerOf()));
    expect(a).toEqual({ imported: 1, present: 0, problems: 0 });
    const look = (await db.execute("SELECT * FROM holdout_look")).rows[0]!;
    expect({ ...look }).toMatchObject({
      lineage: "f1_v2_mom",
      market: "AU",
      looked_at: LOOKED,
      prereg_sha: sha256Hex(PLAN),
      verdict: "NULL",
    });
    expect(
      (await db.execute("SELECT n_setups, n_blocks FROM research_result")).rows[0],
    ).toMatchObject({ n_setups: 40, n_blocks: 6 });
    // the next night: present, nothing new, no refusal row and no log line
    const b = await syncLedger(db, { market: "AU", now: NOW }, io(ledgerOf()));
    expect(b).toEqual({ imported: 0, present: 1, problems: 0 });
    expect(await n(db, "holdout_look")).toBe(1);
    expect(await n(db, "holdout_look_refusal")).toBe(0);
    expect(await warns(db)).toEqual([]);
  });

  it("another market's entry is not imported", async () => {
    const db = await freshDb("main");
    const r = await syncLedger(db, { market: "IN", now: NOW }, io(ledgerOf()));
    expect(r.imported).toBe(0);
    expect(await n(db, "holdout_look")).toBe(0);
  });

  it("an entry that names only a frozen plan freezes it and takes no look", async () => {
    const db = await freshDb("main");
    const l = JSON.parse(ledgerOf()) as { entries: Array<Record<string, unknown>> };
    for (const k of ["lookedAt", "verdict", "nSetups", "nBlocks", "stats"]) delete l.entries[0]![k];
    const r = await syncLedger(db, { market: "AU", now: NOW }, io(JSON.stringify(l)));
    expect(r.imported).toBe(0);
    expect(await n(db, "research_prereg")).toBe(1);
    expect(await n(db, "holdout_look")).toBe(0);
  });

  it("a frozen file that no longer matches its hash is not imported and raises one plain Owner line", async () => {
    const db = await freshDb("main");
    const r = await syncLedger(
      db,
      { market: "AU", now: NOW },
      io(ledgerOf(), '{"hypothesis":"edited"}\n'),
    );
    expect(r).toEqual({ imported: 0, present: 0, problems: 1 });
    expect(await n(db, "holdout_look")).toBe(0);
    const w = await warns(db);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/does not match its frozen plan/);
    expect(w[0]).not.toMatch(/f1_v2_mom|CXA|M15/); // no internal code in an Owner line
    expect(w[0]).toContain(lineageName("f1_v2_mom"));
  });

  it("a database look that differs from the record raises an Owner line and changes nothing", async () => {
    const db = await freshDb("main");
    const p = await preregister(db, {
      lineage: "f1_v2_mom",
      market: "AU",
      item: "M15",
      frozen: PLAN,
      now: NOW,
    });
    await db.execute(
      `INSERT INTO holdout_look (lineage, market, looked_at, prereg_sha, verdict) VALUES ('f1_v2_mom', 'AU', '${LOOKED}', '${p.sha}', 'PASS')`,
    );
    const r = await syncLedger(db, { market: "AU", now: NOW }, io(ledgerOf()));
    expect(r).toEqual({ imported: 0, present: 1, problems: 1 });
    expect((await warns(db))[0]).toMatch(/differs between the record and the database/);
    expect((await db.execute("SELECT verdict FROM holdout_look")).rows[0]!.verdict).toBe("PASS");
  });

  it("a database look of an offline test that the record does not hold raises an Owner line", async () => {
    const db = await freshDb("main");
    const p = await preregister(db, {
      lineage: "f1_v2_mom",
      market: "AU",
      item: "M15",
      frozen: PLAN,
      now: NOW,
    });
    await db.execute(
      `INSERT INTO holdout_look (lineage, market, looked_at, prereg_sha, verdict) VALUES ('f1_v2_mom', 'AU', '${LOOKED}', '${p.sha}', 'NULL')`,
    );
    const empty = JSON.stringify({ format: 1, entries: [] });
    const r = await syncLedger(
      db,
      { market: "AU", now: NOW },
      { read: (x) => (x === LEDGER_PATH ? empty : null) },
    );
    expect(r.problems).toBe(1);
    expect((await warns(db))[0]).toMatch(/not in the committed record/);
  });

  it("no ledger file means nothing happens; an unreadable one is one plain line", async () => {
    const db = await freshDb("main");
    expect(await syncLedger(db, { market: "AU", now: NOW }, { read: () => null })).toEqual({
      imported: 0,
      present: 0,
      problems: 0,
    });
    const r = await syncLedger(db, { market: "AU", now: NOW }, { read: () => "{not json" });
    expect(r.problems).toBe(1);
    expect(await warns(db)).toHaveLength(1);
  });

  it("the disk reader refuses a path outside the repo", () => {
    expect(diskIo.read("../package.json")).toBeNull();
    expect(diskIo.read("/etc/passwd")).toBeNull();
  });
});

describe("the committed ledger (D-1609)", () => {
  const ledger = parseLedger(readFileSync(path.join(process.cwd(), LEDGER_PATH), "utf8"));

  it("entry 1 is the F1.v2-mom look: NULL, stays in shadow, under the gap cap", () => {
    expect(ledger.entries[0]).toMatchObject({
      seq: 1,
      item: "M15",
      lineage: "f1_v2_mom",
      market: "AU",
      verdict: "NULL",
      note: "stays in shadow, gap cap",
    });
  });

  it("the live step imports it into a fresh database once and never looks again", async () => {
    const db = await freshDb("main");
    const a = await syncLedger(db, { market: "AU", now: NOW });
    // every recorded look of the committed ledger (F1.v2-mom and the later offline looks) comes in once
    const looks = ledger.entries.filter((e) => e.verdict !== undefined).length;
    expect(a).toEqual({ imported: looks, present: 0, problems: 0 });
    expect(
      (await db.execute("SELECT verdict FROM holdout_look WHERE lineage = 'f1_v2_mom'")).rows[0]!
        .verdict,
    ).toBe("NULL");
    await RESEARCH_STEPS[0]!.run(db, { market: "AU", d: "2030-02-01", now: NOW });
    expect(await n(db, "holdout_look")).toBe(looks);
    expect(await n(db, "holdout_look_refusal")).toBe(0);
  });

  it("every ledger lineage has a plain name, and every name is plain", () => {
    for (const e of ledger.entries) expect(LINEAGE_NAMES[e.lineage], e.lineage).toBeDefined();
    for (const l of ["short_shadow", "regime_altinputs", "committee_trial"])
      expect(LINEAGE_NAMES[l], l).toBeDefined();
    for (const [k, v] of Object.entries(LINEAGE_NAMES)) {
      expect(v.name, k).not.toMatch(/[A-Z]{3}-\d|\b(AU|IN|US)\b|_/);
      expect(lineageName(k)).toBe(v.name);
    }
    expect(lineageName("not_a_lineage")).toBe("An unnamed test");
  });
});

describe("registryRows (the page list)", () => {
  it("lists every look with its full hash, the display word, numbers and refused second looks", async () => {
    const db = await freshDb("main");
    await syncLedger(db, { market: "AU", now: NOW }, io(ledgerOf()));
    const p = await preregister(db, {
      lineage: "short_shadow",
      market: "AU",
      item: "VAL-121",
      frozen: { h: 1 },
      now: NOW,
    });
    // a look written before 0040, with the older word and no result row
    await db.execute(
      `INSERT INTO holdout_look (lineage, market, looked_at, prereg_sha, verdict) VALUES ('short_shadow', 'AU', '2029-12-01T00:00:00Z', '${p.sha.slice(0, 16)}', 'fail')`,
    );
    const rows = await registryRows(db, "AU");
    expect(
      rows.map((r) => [r.lineage, r.name, r.verdict, r.sha.length, r.nSetups, r.refusals]),
    ).toEqual([
      ["short_shadow", "Short-selling shadow test", "NULL", 16, null, 0],
      ["f1_v2_mom", "Long-hold momentum rule", "NULL", 64, 40, 0],
    ]);
  });
});
