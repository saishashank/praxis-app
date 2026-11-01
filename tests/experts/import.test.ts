// @vitest-environment node
// Owner-run expert seed import (M13-lite WP3; D-513, D-521, D-531, D-536, AT-39 (b)(c)): schema rejection before
// any write, dry run, idempotency, the private-folder rule, what the import writes. Synthetic ZZ data only.
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "@libsql/client";
import { loadMigrations, migrateUp } from "@/lib/db/migrate-core.mjs";
import { run, itemId } from "../../scripts/experts/import.mjs";
import { wordCount } from "../../scripts/experts/validate.mjs";
import { cleanupTempDbs, freshDb, MIGRATIONS, tempDbUrl, track } from "../db/helpers";
import { type SeedFiles, writeSeed, zzSeedFiles } from "./zzSeed";

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

function seed(mod?: (f: SeedFiles) => void) {
  const f = zzSeedFiles();
  mod?.(f);
  const a = writeSeed(f);
  cleanups.push(a.cleanup);
  return a.dir;
}

const count = async (db: ReturnType<typeof createClient>, table: string) =>
  Number((await db.execute(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0]!.n);

const TABLES = [
  "expert",
  "expert_red_flag",
  "source_item",
  "cluster",
  "cluster_state",
  "claim",
  "claim_revision",
  "claim_status",
  "claim_expert",
  "claim_item",
  "claim_cluster",
  "expert_call",
];

async function totals(db: ReturnType<typeof createClient>) {
  return Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, await count(db, t)])));
}

describe("fixture", () => {
  it("is the synthetic ZZ seed: 6 experts, 12 items, 20 claims incl. 2 calls, 5 clusters, 1 sourced red flag", () => {
    const f = zzSeedFiles();
    expect(f["experts.json"].experts).toHaveLength(6);
    expect(f["experts.json"].experts.every((e) => e.name.startsWith("ZZ "))).toBe(true);
    expect(f["items.json"].items).toHaveLength(12);
    expect(f["claims.json"].claims).toHaveLength(20);
    expect(f["claims.json"].claims.filter((c) => c.type === "call")).toHaveLength(2);
    expect(f["clusters.json"].clusters).toHaveLength(5);
    const flags = f["experts.json"].experts.flatMap((e) => e.red_flags ?? []);
    expect(flags).toHaveLength(1);
    expect(JSON.stringify(f)).not.toMatch(/https?:\/\/(?![a-z0-9.-]*example\.test)/);
  });
});

describe("dry run", () => {
  it("validates and prints counts only; the database is never opened", async () => {
    const r = await go([seed(), "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.text).toContain("dry run");
    expect(r.text).toContain('"experts":6');
    expect(r.text).toContain('"items":12');
    expect(r.text).toContain('"claims":20');
    expect(r.text).toContain('"clusters":5');
    expect(r.text).toContain('"calls":2');
    expect(r.text).toContain('"red_flags":1');
    expect(r.text).toContain("nothing written");
    expect(r.text).not.toContain(SECRET);
    expect(r.text).not.toContain("ZZ Expert");
  });
});

describe("write and idempotency (AT-39 (c))", () => {
  it("writes every table in the D-536 order; a second run adds nothing", async () => {
    const db = await freshDb("main");
    const dir = seed();
    const first = await go([dir], db);
    expect(first.code).toBe(0);
    const t = await totals(db);
    expect(t).toMatchObject({
      expert: 6,
      expert_red_flag: 1,
      source_item: 12,
      cluster: 5,
      cluster_state: 5,
      claim: 20,
      claim_revision: 20,
      claim_status: 20,
      expert_call: 2,
    });
    expect(first.text).not.toContain(SECRET);

    const second = await go([dir], db);
    expect(second.code).toBe(0);
    expect(await totals(db)).toEqual(t);
    expect(second.text).toContain('"experts":0');
    expect(second.text).toContain('"claim_statuses":0');
    expect(second.text).toContain('"claims":0');
  });

  it("a re-import after a claim was confirmed leaves the later status chain alone", async () => {
    const db = await freshDb("main");
    const dir = seed();
    await go([dir], db);
    await db.execute(
      "INSERT INTO claim_status (claim_id, seq, status, actor, at) VALUES ('C-ZZ-001', 2, 'owner_checked', 'u1', '2030-02-02T00:00:00.000Z')",
    );
    expect((await go([dir], db)).code).toBe(0);
    const r = await db.execute(
      "SELECT MAX(seq) AS s FROM claim_status WHERE claim_id = 'C-ZZ-001'",
    );
    expect(Number(r.rows[0]!.s)).toBe(2);
    expect(await count(db, "claim_status")).toBe(21);
  });

  it("seed claims are extracted (L0), clusters proposed, licence unchecked, texts in revision 1 (D-512, D-520)", async () => {
    const db = await freshDb("main");
    await go([seed()], db);
    const st = await db.execute("SELECT DISTINCT status, seq, actor FROM claim_status");
    expect(st.rows.map((x) => [x.status, Number(x.seq), x.actor])).toEqual([
      ["extracted", 1, "seed"],
    ]);
    const cs = await db.execute("SELECT DISTINCT state, seq FROM cluster_state");
    expect(cs.rows.map((x) => [x.state, Number(x.seq)])).toEqual([["proposed", 1]]);
    const lic = await db.execute("SELECT DISTINCT licence_status FROM expert");
    expect(lic.rows.map((x) => x.licence_status)).toEqual(["unchecked"]);
    const rev = await db.execute(
      "SELECT statement, formalisation_text, claimed_edge_text FROM claim_revision WHERE claim_id = 'C-ZZ-003'",
    );
    expect(rev.rows[0]).toMatchObject({
      statement: "ZZ synthetic claim 3.",
      formalisation_text: "ZZ draft rule 3.",
      claimed_edge_text: "ZZ claimed edge (as claimed)",
    });
  });

  it("source_item ids are sha256(url|hash) and the URL plus hash is idempotent (AT-39)", async () => {
    const db = await freshDb("main");
    await go([seed()], db);
    const url = "https://zz1.example.test/post-1";
    const id = itemId(url, null);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    const r = await db.execute({
      sql: "SELECT url, extraction_status, quote FROM source_item WHERE id = ?",
      args: [id],
    });
    expect(r.rows[0]).toMatchObject({
      url,
      extraction_status: "seeded",
      quote: "a short synthetic quote",
    });
    const dup = seed((f) => {
      f["items.json"].items.push({ ...f["items.json"].items[0]!, expert_id: "X-ZZ2" });
    });
    const d = await go([dup], await freshDb("main"));
    expect(d.code).toBe(1);
    expect(d.text).toContain("duplicate (url, content_hash)");
  });

  it("links: claim_expert, claim_item, claim_cluster roles and the primary cluster", async () => {
    const db = await freshDb("main");
    await go([seed()], db);
    const sup = await db.execute(
      "SELECT role, COUNT(*) AS n FROM claim_cluster GROUP BY role ORDER BY role",
    );
    expect(sup.rows.map((x) => [x.role, Number(x.n)])).toEqual([
      ["contradicts", 2],
      ["supports", 13],
    ]);
    const two = await db.execute(
      "SELECT COUNT(*) AS n FROM claim_expert WHERE claim_id = 'C-ZZ-007'",
    );
    expect(Number(two.rows[0]!.n)).toBe(2);
    expect(await count(db, "claim_item")).toBe(20);
    const p = await db.execute("SELECT cluster_id FROM claim WHERE id = 'C-ZZ-002'");
    expect(p.rows[0]!.cluster_id).toBe("K-ZZ1");
    const fit = await db.execute("SELECT family_fit_json FROM cluster WHERE id = 'K-ZZ1'");
    expect(JSON.parse(String(fit.rows[0]!.family_fit_json))).toEqual({
      family: "F1",
      params: { lookback: 126 },
    });
    const call = await db.execute(
      "SELECT code, direction, tracked FROM expert_call ORDER BY claim_id",
    );
    expect(call.rows.map((x) => [x.code, x.direction, Number(x.tracked)])).toEqual([
      ["ZZA", "long", 1],
      ["ZZB", "short", 0],
    ]);
  });
});

describe("schema rejection (nothing is written; AT-39 (b))", () => {
  const long = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
  const cases: [string, (f: SeedFiles) => void, string][] = [
    [
      "a 120-word summary",
      (f) => (f["items.json"].items[0].summary = long(120)),
      "items.json: items[0].summary",
    ],
    [
      "an 81-word summary",
      (f) => (f["items.json"].items[0].summary = long(81)),
      "items.json: items[0].summary: more than 80 words",
    ],
    [
      "a 16-word quote",
      (f) => (f["items.json"].items[0].quote = long(16)),
      "items.json: items[0].quote: more than 15 words",
    ],
    [
      "two quotes in one item",
      (f) => (f["items.json"].items[0].quote = '"one two" and "three four"'),
      "items.json: items[0].quote: more than one quote",
    ],
    [
      "a list of quotes",
      (f) => (f["items.json"].items[0].quote = ["a b", "c d"]),
      "items.json: items[0].quote: a single string required",
    ],
    [
      "a red flag without a source",
      (f) => delete f["experts.json"].experts[1].red_flags[0].source_url,
      "experts.json: experts[1].red_flags[0].source_url",
    ],
    [
      "an unknown key body on an item",
      (f) => (f["items.json"].items[2].body = "page text"),
      "items.json: items[2].body: unknown key",
    ],
    [
      "an unknown key transcript on a claim",
      (f) => (f["claims.json"].claims[0].transcript = "x"),
      "claims.json: claims[0].transcript: unknown key",
    ],
    [
      "a claim naming an unknown expert",
      (f) => (f["claims.json"].claims[3].experts = ["X-NOPE"]),
      "claims.json: claims[3].experts[0]: unknown expert",
    ],
    [
      "a claim naming an unknown item",
      (f) => (f["claims.json"].claims[3].items = ["https://nope.example.test/x"]),
      "claims.json: claims[3].items[0]: no such item",
    ],
    [
      "a claim naming an unknown cluster",
      (f) => (f["claims.json"].claims[3].cluster_id = "K-NOPE"),
      "claims.json: claims[3].cluster_id: unknown cluster",
    ],
    [
      "a cluster naming an unknown claim",
      (f) => f["clusters.json"].clusters[0].supports.push("C-NOPE"),
      "clusters.json: clusters[0].supports[3]: unknown claim",
    ],
    [
      "a call for a claim that is not a call",
      (f) => (f["calls.json"]!.calls[0].claim_id = "C-ZZ-001"),
      "calls.json: calls[0].claim_id: claim is not of type call",
    ],
    [
      "a family fit with an unknown family",
      (f) => (f["clusters.json"].clusters[0].family_fit = { family: "F7", params: { a: 1 } }),
      "clusters.json: clusters[0].family_fit.family",
    ],
    [
      "a family fit with a non-numeric parameter",
      (f) => (f["clusters.json"].clusters[0].family_fit = { family: "F1", params: { a: "x" } }),
      "clusters.json: clusters[0].family_fit.params.a",
    ],
    [
      "a statement over the 600-character cap",
      (f) => (f["claims.json"].claims[0].statement = "x".repeat(601)),
      "claims.json: claims[0].statement: longer than 600",
    ],
    [
      "an http-less URL",
      (f) => (f["items.json"].items[0].url = "ftp://zz.example.test/a"),
      "items.json: items[0].url",
    ],
    ["a wrong format tag", (f) => (f["manifest.json"].format = "other/9"), "manifest.json: format"],
    [
      "an unknown claim type",
      (f) => (f["claims.json"].claims[0].type = "opinion"),
      "claims.json: claims[0].type",
    ],
  ];
  for (const [name, mod, expected] of cases) {
    it(`rejects ${name}`, async () => {
      const db = await freshDb("main");
      const r = await go([seed(mod)], db);
      expect(r.code).toBe(1);
      expect(r.text).toContain("rejected");
      expect(r.text).toContain(expected);
      expect(r.text).not.toContain(SECRET);
      expect(await totals(db)).toEqual(Object.fromEntries(TABLES.map((t) => [t, 0])));
    });
  }

  it("the error names the file and field, never the value", async () => {
    const r = await go(
      [seed((f) => (f["claims.json"].claims[0].type = "zz-leaky-value"))],
      await freshDb("main"),
    );
    expect(r.text).toContain("claims.json: claims[0].type");
    expect(r.text).not.toContain("zz-leaky-value");
    const r2 = await go(
      [seed((f) => (f["items.json"].items[0].summary = `zz-leaky ${"w ".repeat(100)}`))],
      await freshDb("main"),
    );
    expect(r2.text).not.toContain("zz-leaky");
  });

  it("a missing file, invalid JSON, a missing folder and a folder inside the repository are refused", async () => {
    expect((await go(["Z:/no/such/folder"])).code).toBe(1);
    expect((await go([])).code).toBe(1);
    expect(await run([process.cwd()], {}, { out: () => undefined })).toBe(1);
    const partial = writeSeed();
    cleanups.push(partial.cleanup);
    rmSync(path.join(partial.dir, "clusters.json"));
    const r = await go([partial.dir]);
    expect(r.code).toBe(1);
    expect(r.text).toContain("clusters.json: $: file missing");
    writeFileSync(path.join(partial.dir, "clusters.json"), "{ not json");
    expect((await go([partial.dir])).text).toContain("clusters.json: $: not valid JSON");
  });
});

describe("database guards", () => {
  it("refuses a database below schema 22", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    const all = await loadMigrations(MIGRATIONS("main"));
    await migrateUp(
      db,
      all.filter((m: { version: number }) => m.version < 22),
    );
    const r = await go([seed()], db);
    expect(r.code).toBe(1);
    expect(r.text).toContain("below 22");
  });

  it("a database failure prints no detail and exits 1", async () => {
    const broken = {
      execute: async () => ({ rows: [{ v: 22 }] }) as never,
      batch: async () => {
        throw new Error("zz-leaky-db-detail");
      },
      close: () => undefined,
    };
    const lines: string[] = [];
    const code = await run(
      [seed()],
      { TURSO_MAIN_URL: "file:zz" },
      { out: (s) => lines.push(s), openDb: () => broken },
    );
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("nothing was written");
    expect(lines.join("\n")).not.toContain("zz-leaky-db-detail");
  });

  it("a refused database write by a trigger (unknown expert on an item) leaves every table empty", async () => {
    const db = await freshDb("main");
    // Bypass the validator by calling the batch directly with a bad second statement.
    await expect(
      db.batch(
        [
          "INSERT INTO expert (id,name,status,tier,created_at,updated_at) VALUES ('X-1','ZZ A','tracked','core','t','t')",
          "INSERT INTO claim_status (claim_id, seq, status, actor, at) VALUES ('C-NOPE', 1, 'extracted', 's', 't')",
        ],
        "write",
      ),
    ).rejects.toThrow();
    expect(await count(db, "expert")).toBe(0);
  });
});

describe("word count", () => {
  it("counts whitespace-separated words", () => {
    expect(wordCount("")).toBe(0);
    expect(wordCount("  a  b\nc ")).toBe(3);
  });
});
