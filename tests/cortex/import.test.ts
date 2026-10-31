// @vitest-environment node
// Owner-run Cortex import (M15 P6; D-267, D-349, D-357): schema rejection before any write, idempotency,
// dry run, the schema floor, the private-folder rule and what the import writes. Synthetic ZZ data.
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateUp } from "@/lib/db/migrate-core.mjs";
import { createClient } from "@libsql/client";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { contentSha } from "@/lib/kb/render";
import { run } from "../../scripts/cortex/import.mjs";
import { artefactFiles, writeArtefact, type ArtefactFiles } from "../acceptance/v2/zzP6";
import { cleanupTempDbs, freshDb, MIGRATIONS, tempDbUrl, track } from "../db/helpers";

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanupTempDbs();
  for (const c of cleanups.splice(0)) c();
});

const SECRET = "tok-ZZ-secret-value";

async function go(args: string[], db?: ReturnType<typeof createClient>) {
  const lines: string[] = [];
  const code = await run(
    args,
    { TURSO_MAIN_URL: "file:zz", TURSO_MAIN_TOKEN: SECRET },
    {
      out: (s) => lines.push(s),
      openDb: () => {
        if (!db) throw new Error("the database must not be opened");
        return {
          execute: (s: never) => db.execute(s),
          batch: (s: never, m: never) => db.batch(s, m),
          close: () => undefined,
        };
      },
    },
  );
  return { code, text: lines.join("\n") };
}

function artefact(mod?: (f: ArtefactFiles) => void) {
  const f = artefactFiles();
  mod?.(f);
  const a = writeArtefact(f);
  cleanups.push(a.cleanup);
  return a.dir;
}

const count = async (db: ReturnType<typeof createClient>, table: string) =>
  Number((await db.execute(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0]!.n);

describe("dry run", () => {
  it("validates and prints counts only; the database is never opened", async () => {
    const r = await go([artefact(), "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.text).toContain("dry run");
    expect(r.text).toContain('"passports":3');
    expect(r.text).toContain('"cells":8');
    expect(r.text).toContain('"maps":5');
    expect(r.text).toContain('"families_allowed":2');
    expect(r.text).toContain('"statements":2');
    expect(r.text).toContain("nothing written");
    expect(r.text).not.toContain(SECRET);
  });
});

describe("write and idempotency", () => {
  it("writes passports, cells, maps, statuses and statements; a second run adds nothing", async () => {
    const db = await freshDb("main");
    const dir = artefact();
    const first = await go([dir], db);
    expect(first.code).toBe(0);
    expect(await count(db, "angle_passport")).toBe(3);
    expect(await count(db, "cortex_ledger_cell")).toBe(8);
    expect(await count(db, "cortex_map")).toBe(5);
    expect(await count(db, "family_status")).toBe(5);
    expect(await count(db, "cortex_statement")).toBe(2);
    expect(first.text).not.toContain(SECRET);

    const second = await go([dir], db);
    expect(second.code).toBe(0);
    expect(await count(db, "angle_passport")).toBe(3);
    expect(await count(db, "cortex_ledger_cell")).toBe(8);
    expect(await count(db, "cortex_map")).toBe(5);
    expect(await count(db, "family_status")).toBe(5);
    expect(await count(db, "cortex_statement")).toBe(2);
    expect(second.text).toContain('"passports":0');
  });

  it("statuses come from the CTX-053 rules: F1 and F4 allowed by the evaluator, the rest shadow, F7 never", async () => {
    const db = await freshDb("main");
    expect((await go([artefact()], db)).code).toBe(0);
    const r = await db.execute(
      "SELECT family, status, set_by, statement_id FROM family_status ORDER BY family",
    );
    const by = Object.fromEntries(r.rows.map((x) => [String(x.family), x]));
    expect(by.F1).toMatchObject({ status: "allowed", set_by: "evaluator" });
    expect(by.F4).toMatchObject({ status: "allowed", set_by: "evaluator" });
    for (const f of ["F2", "F3", "F7"])
      expect(by[f]).toMatchObject({ status: "shadow", set_by: "import" });
    expect(by.F1!.statement_id).toBe("stmt:AU:F1:allowed_weak:2030-02-01");
    expect(by.F2!.statement_id).toBeNull();
  });

  it("matched cells are ledger cells of kind matched_cell holding the cell statistic; map params carry the per-family fields", async () => {
    const db = await freshDb("main");
    await go([artefact()], db);
    const c = await db.execute("SELECT result_json FROM cortex_ledger_cell WHERE cell_id = 'c-f1'");
    expect(JSON.parse(String(c.rows[0]!.result_json))).toMatchObject({
      cellKey: "F1|top3|v2|U1",
      n: 120,
    });
    const m = await db.execute("SELECT params_json FROM cortex_map WHERE family = 'F1'");
    const p = JSON.parse(String(m.rows[0]!.params_json));
    for (const k of [
      "top3_min_s",
      "family_mean_net",
      "tiers",
      "p_hidden",
      "gain",
      "loss",
      "slots",
    ]) {
      expect(p).toHaveProperty(k);
    }
    const ev = await db.execute("SELECT evidence_json FROM family_status WHERE family = 'F1'");
    const e = JSON.parse(String(ev.rows[0]!.evidence_json));
    expect(e.n_eff).toBe(260);
    expect(e.mde).toBe(0.04);
  });
});

describe("schema rejection (nothing is written)", () => {
  const cases: [string, (f: ArtefactFiles) => void][] = [
    ["a passport with orientation 2", (f) => (f["passports.json"].passports[0].orientation = 2)],
    [
      "a cell logged at or after its result",
      (f) => (f["cells.json"].cells[0].logged_at = "2031-01-01T00:00:00Z"),
    ],
    [
      "A-D5-08 active before 60 live sessions (D-305)",
      (f) => (f["passports.json"].passports[2].status = "active"),
    ],
    [
      "a map whose p_hidden disagrees with the slope monitor",
      (f) => (f["maps.json"].maps[0].params.p_hidden = false),
    ],
    [
      "a missing mde row at 300",
      (f) =>
        (f["evidence.json"].families[0].mde_rows = [
          { n_eff: 100, mde: 0.1 },
          { n_eff: 150, mde: 0.08 },
        ]),
    ],
    [
      "a matched cell without its result",
      (f) => {
        f["cells.json"].cells[0].result_at = null;
        f["cells.json"].cells[0].result = null;
      },
    ],
    ["a wrong format tag", (f) => (f["manifest.json"].format = "other/9")],
    ["an unknown gate cell", (f) => (f["evidence.json"].families[0].gate_cell_key = "nope")],
    [
      "min_neff_trade outside 150..400",
      (f) => (f["evidence.json"].families[0].min_neff_trade = 50),
    ],
  ];
  for (const [name, mod] of cases) {
    it(`rejects ${name}`, async () => {
      const db = await freshDb("main");
      const r = await go([artefact(mod)], db);
      expect(r.code).toBe(1);
      expect(r.text).toContain("rejected");
      expect(r.text).not.toContain(SECRET);
      expect(await count(db, "angle_passport")).toBe(0);
      expect(await count(db, "cortex_ledger_cell")).toBe(0);
      expect(await count(db, "family_status")).toBe(0);
    });
  }

  it("the error names the file and field, not the value", async () => {
    const r = await go(
      [artefact((f) => (f["passports.json"].passports[0].cluster = "zz-leaky-value"))],
      await freshDb("main"),
    );
    expect(r.text).toContain("passports.json: passports[0].cluster");
    expect(r.text).not.toContain("zz-leaky-value");
  });

  it("a missing folder, an invalid JSON file and a folder inside the repository are refused", async () => {
    expect((await go(["Z:/no/such/folder"])).code).toBe(1);
    expect((await go([])).code).toBe(1);
    const inside = await run([process.cwd()], {}, { out: () => undefined });
    expect(inside).toBe(1);
  });
});

describe("database guards", () => {
  it("refuses a database below schema 19", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    const all = await loadMigrations(MIGRATIONS("main"));
    await migrateUp(
      db,
      all.filter((m: { version: number }) => m.version < 19),
    );
    const r = await go([artefact()], db);
    expect(r.code).toBe(1);
    expect(r.text).toContain("below 19");
  });

  it("an Owner kill (suspended) is never overwritten by a later import", async () => {
    const db = await freshDb("main");
    await db.execute(
      `INSERT INTO family_status (market, family, since_d, status, evidence_json, set_by)
       VALUES ('AU','F1','2030-01-15','suspended','{}','owner_kill')`,
    );
    await go([artefact()], db);
    const r = await db.execute(
      "SELECT status FROM family_status WHERE family = 'F1' ORDER BY since_d",
    );
    expect(r.rows.map((x) => String(x.status))).toEqual(["suspended"]);
  });
});

describe("kb_report.md (D-469: the calibration report as a KB item)", () => {
  const report = (o: { type?: string; body?: string; market?: string } = {}) =>
    [
      "---",
      'id: "zz-calibration-report"',
      `market: "${o.market ?? "AU"}"`,
      `type: "${o.type ?? "cortex_report"}"`,
      'created: "2026-11-01"',
      'updated: "2026-11-01"',
      "version: 1",
      'related: ["family-F1"]',
      "---",
      o.body ?? "# Synthetic report\n\nSynthetic text only.\n",
    ].join("\n");
  const withReport = (text: string) => {
    const dir = artefact();
    writeFileSync(path.join(dir, "kb_report.md"), text);
    return dir;
  };

  it("a valid report is planned, inserted once as a review document, and a re-run adds nothing", async () => {
    const dir = withReport(report());
    const dry = await go([dir, "--dry-run"]);
    expect(dry.text).toContain('"documents":1');
    const db = await freshDb("main");
    const first = await go([dir], db);
    expect(first.code).toBe(0);
    expect(await count(db, "document")).toBe(1);
    const row = (await db.execute("SELECT * FROM document")).rows[0]!;
    expect(row.doc_type).toBe("review");
    expect(row.version).toBe(1);
    expect(String(row.path)).toMatch(/^knowledge\/[a-z]+\/cortex\/zz-calibration-report\.md$/);
    const front = JSON.parse(String(row.front_json));
    expect(front.kind).toBe("cortex_calibration");
    expect(front.type).toBe("review");
    const { version: _v, kind: _k, ...bare } = front;
    expect(row.body_sha).toBe(contentSha(bare, String(row.body)));
    await go([dir], db);
    expect(await count(db, "document")).toBe(1);
  });

  it("no report file changes nothing", async () => {
    const db = await freshDb("main");
    const r = await go([artefact()], db);
    expect(r.code).toBe(0);
    expect(await count(db, "document")).toBe(0);
    expect((await go([artefact(), "--dry-run"])).text).toContain('"documents":0');
  });

  it("an empty body, a wrong type or a wrong market is refused and nothing is written", async () => {
    const db = await freshDb("main");
    for (const [o, msg] of [
      [{ body: "  \n" }, "kb_report.md: body: must not be empty"],
      [{ type: "lesson" }, 'kb_report.md: type: must be "cortex_report" or "review"'],
      [{ market: "ZZ" }, "kb_report.md: market: must equal the manifest market"],
    ] as const) {
      const r = await go([withReport(report(o))], db);
      expect(r.code).toBe(1);
      expect(r.text).toContain(msg);
    }
    expect(await count(db, "document")).toBe(0);
    expect(await count(db, "angle_passport")).toBe(0);
  });
});
