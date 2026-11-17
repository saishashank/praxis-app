// @vitest-environment node
// Owner-run expert seed import (M13-lite WP3; D-513, D-521, D-531, D-536, AT-39 (b)(c)): schema rejection before
// any write, dry run, idempotency, the private-folder rule, what the import writes. Synthetic ZZ data only.
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "@libsql/client";
import { loadMigrations, migrateUp } from "@/lib/db/migrate-core.mjs";
import { run, itemId, preregSha } from "../../scripts/experts/import.mjs";
import { wordCount } from "../../scripts/experts/validate.mjs";
import {
  allowMarket,
  cleanupTempDbs,
  freshDb as baseFreshDb,
  MIGRATIONS,
  tempDbUrl,
  track,
} from "../db/helpers";

// M19 0035: the ZZ seed holds one US call; the write guard needs that market enabled to store it.
const freshDb = async (name: "main" | "auth") => {
  const db = await baseFreshDb(name);
  if (name === "main") await allowMarket(db, "US");
  return db;
};
import { type SeedFiles, writeSeed, zzSeedFiles } from "./zzSeed";
import { PREREG_TEXT, type SeedFilesV2, zzSeedV2 } from "./zzExpress";

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
      (f) => (f["clusters.json"].clusters[0].family_fit = { family: "F1", params: { a: null } }),
      "clusters.json: clusters[0].family_fit.params.a",
    ],
    [
      "a family fit with a free-text parameter",
      (f) =>
        (f["clusters.json"].clusters[0].family_fit = {
          family: "F1",
          params: { a: "Not An Enum Word" },
        }),
      "clusters.json: clusters[0].family_fit.params.a",
    ],
    [
      "a family fit with an object parameter",
      (f) =>
        (f["clusters.json"].clusters[0].family_fit = { family: "F6", params: { w: { x: 1 } } }),
      "clusters.json: clusters[0].family_fit.params.w",
    ],
    [
      "a platforms array over the 500-character JSON cap",
      (f) =>
        (f["experts.json"].experts[0].platforms = Array.from({ length: 12 }, () => "p".repeat(40))),
      "experts.json: experts[0].platforms: longer than 500 characters as JSON",
    ],
    [
      "a handles key that is not a platform id (the key is not echoed)",
      (f) => (f["experts.json"].experts[0].handles = { "ZZ leaky key": "h" }),
      "experts.json: experts[0].handles[0]: key must be a platform id",
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
    const r3 = await go(
      [seed((f) => (f["experts.json"].experts[0].handles = { "zz-leaky key": "h" }))],
      await freshDb("main"),
    );
    expect(r3.code).toBe(1);
    expect(r3.text).not.toContain("zz-leaky");
  });

  it("accepts an enum word for a structural key in a family fit (D-570)", async () => {
    const db = await freshDb("main");
    const r = await go(
      [
        seed((f) => {
          f["clusters.json"].clusters[0].family_fit = {
            family: "F1",
            params: { lookback: 126, f1_momentum_variant: "skip_month_u2" },
          };
        }),
      ],
      db,
    );
    expect(r.code).toBe(0);
    const fit = await db.execute("SELECT family_fit_json FROM cluster WHERE id = 'K-ZZ1'");
    expect(JSON.parse(String(fit.rows[0]!.family_fit_json)).params.f1_momentum_variant).toBe(
      "skip_month_u2",
    );
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

// ---- format praxis-expert-seed/2 (M22 E4; KB-085, D-1437, D-1523) -----------------------------------------------

function seed2(mod?: (f: SeedFilesV2) => void) {
  const f = zzSeedV2();
  mod?.(f);
  const a = writeSeed(f as unknown as SeedFiles);
  cleanups.push(a.cleanup);
  return a.dir;
}

describe("format 2: licence check, call proposals, expressions", () => {
  it("dry run counts the new rows and the checked proposals; nothing is written", async () => {
    const r = await go([seed2(), "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.text).toContain('"licence":3');
    expect(r.text).toContain('"expressions":4');
    expect(r.text).toContain("call proposals checked 2 (not stored)");
    expect(r.text).not.toContain("ZZ pre-registration");
    expect(r.text).not.toContain("ZZ low oscillator");
  });

  it("writes licence rows (actor import, the time of the file), expressions and no call proposal; a second run adds nothing", async () => {
    const db = await freshDb("main");
    const dir = seed2();
    const first = await go([dir], db);
    expect(first.code).toBe(0);
    expect(first.text).toContain('"licence":3');
    const lic = await db.execute(
      "SELECT expert_id, source_key, checked_at, robots, status, actor, note FROM expert_source_licence ORDER BY expert_id",
    );
    expect(lic.rows.map((r) => [r.expert_id, r.status, r.actor, r.checked_at])).toEqual([
      ["X-ZZ1", "enabled", "import", "2030-02-10T00:00:00.000Z"],
      ["X-ZZ2", "no", "import", "2030-02-10T00:00:00.000Z"],
      ["X-ZZ3", "unchecked", "import", "2030-02-10T00:00:00.000Z"],
    ]);
    const ex = await db.execute(
      "SELECT cluster_id, version, outcome, rule_json, exit_json, park_reason, reason_text, prereg_sha FROM cluster_expression ORDER BY cluster_id",
    );
    expect(ex.rows.map((r) => [r.cluster_id, Number(r.version), r.outcome, r.park_reason])).toEqual(
      [
        ["K-ZZ2", 1, "expressed", null],
        ["K-ZZ3", 1, "expressed", null],
        ["K-ZZ4", 1, "parked", "overlay_only"],
        ["K-ZZ5", 1, "parked", "not_testable"],
      ],
    );
    // the pre-registration text is not stored: only its sha is
    expect(ex.rows[0]!.prereg_sha).toBe(preregSha(PREREG_TEXT));
    expect(JSON.stringify(ex.rows)).not.toContain("pre-registration");
    expect(JSON.parse(String(ex.rows[0]!.rule_json))).toEqual({
      entry: { field: "rsi2", op: "<", value: 10 },
      schema_version: 2,
    });
    expect(ex.rows[2]).toMatchObject({ rule_json: null, exit_json: null, prereg_sha: null });
    // a proposal is not stored (the Owner queue recomputes it) and no call is created from it
    expect(await count(db, "expert_call_proposal")).toBe(0);
    expect(await count(db, "expert_call")).toBe(2);

    const second = await go([dir], db);
    expect(second.code).toBe(0);
    expect(second.text).toContain('"licence":0');
    expect(second.text).toContain('"expressions":0');
    expect(await count(db, "expert_source_licence")).toBe(3);
    expect(await count(db, "cluster_expression")).toBe(4);
  });

  it("an older licence file never replaces a newer row: the latest by time stays the status", async () => {
    const db = await freshDb("main");
    await go([seed2()], db);
    await db.execute(
      "INSERT INTO expert_source_licence (expert_id, source_key, checked_at, robots, summarisation, status, actor) VALUES ('X-ZZ1', 'origin:zz1.example.test', '2030-03-01T00:00:00.000Z', 'disallows', 'unknown', 'no', 'job')",
    );
    await go([seed2()], db);
    const r = await db.execute(
      "SELECT status FROM expert_source_licence WHERE expert_id = 'X-ZZ1' ORDER BY checked_at DESC LIMIT 1",
    );
    expect(r.rows[0]!.status).toBe("no");
  });

  it("a database below schema 39 refuses format-2 rows and still takes a plain seed", async () => {
    const db = await freshDb("main");
    await db.execute("DELETE FROM schema_migrations WHERE version >= 39");
    const refused = await go([seed2()], db);
    expect(refused.code).toBe(1);
    expect(refused.text).toMatch(/below 39/);
    expect(await count(db, "expert")).toBe(0);
    expect((await go([seed()], db)).code).toBe(0);
  });

  describe("rejections name the file and the field and never the value; nothing is written", () => {
    const cases: [string, (f: SeedFilesV2) => void, string][] = [
      [
        "owner-accepted-risk is not an importable status",
        (f) => {
          f["licence-check.json"].results[0]!.status = "owner-accepted-risk";
        },
        "licence-check.json: results[0].status",
      ],
      [
        "a licence row for an unknown expert",
        (f) => {
          f["licence-check.json"].results[1]!.expert_id = "X-NOPE";
        },
        "licence-check.json: results[1].expert_id: unknown expert",
      ],
      [
        "an unknown key in a licence row",
        (f) => {
          f["licence-check.json"].results[0]!.page_text = "ZZ-SECRET-PAGE-TEXT";
        },
        "licence-check.json: results[0].page_text: unknown key",
      ],
      [
        "a licence note that is too long",
        (f) => {
          f["licence-check.json"].results[0]!.note = "ZZ-LONG-NOTE".repeat(30);
        },
        "licence-check.json: results[0].note",
      ],
      [
        "a call proposal for a claim that is not a call",
        (f) => {
          f["call-proposals.json"].proposals[0]!.claim_id = "C-ZZ-001";
        },
        "call-proposals.json: proposals[0].claim_id: claim is not of type call",
      ],
      [
        "an expression for an unknown cluster",
        (f) => {
          f["expressions.json"].expressions[0]!.cluster_id = "K-NOPE";
        },
        "expressions.json: expressions[0].cluster_id: unknown cluster",
      ],
      [
        "an expression for a cluster that has a family fit",
        (f) => {
          f["expressions.json"].expressions[0]!.cluster_id = "K-ZZ1";
        },
        "expressions.json: expressions[0].cluster_id: cluster has a family fit",
      ],
      [
        "an unknown park reason",
        (f) => {
          f["expressions.json"].expressions[2]!.park_reason = "ZZ-WHIM";
        },
        "expressions.json: expressions[2].park_reason: unknown park reason",
      ],
      [
        "an expressed entry with a park reason",
        (f) => {
          f["expressions.json"].expressions[0]!.park_reason = "duplicate";
        },
        "expressions.json: expressions[0].park_reason",
      ],
      [
        "an expressed entry without a pre-registration",
        (f) => {
          delete f["expressions.json"].expressions[0]!.preregistration;
        },
        "expressions.json: expressions[0].preregistration",
      ],
      [
        "a parked entry that carries a rule",
        (f) => {
          f["expressions.json"].expressions[2]!.rule = { schema_version: 2 };
        },
        "expressions.json: expressions[2].rule",
      ],
      [
        "a reason that is too long",
        (f) => {
          f["expressions.json"].expressions[3]!.reason = "ZZ-LONG-REASON".repeat(30);
        },
        "expressions.json: expressions[3].reason",
      ],
      [
        "the same cluster and version twice",
        (f) => {
          f["expressions.json"].expressions[1]!.cluster_id = "K-ZZ2";
        },
        "expressions.json: expressions[1]: duplicate cluster_id and version",
      ],
      [
        "format-2 files in a format-1 seed",
        (f) => {
          f["manifest.json"].format = "praxis-expert-seed/1";
        },
        "expressions.json: $: file needs format praxis-expert-seed/2",
      ],
      [
        "a wrong licence-check format word",
        (f) => {
          f["licence-check.json"].format = "praxis-licence-check/9";
        },
        "licence-check.json: format",
      ],
    ];
    for (const [name, mod, where] of cases) {
      it(name, async () => {
        const db = await freshDb("main");
        const r = await go([seed2(mod)], db);
        expect(r.code).toBe(1);
        expect(r.text).toContain("rejected");
        expect(r.text).toContain(where);
        expect(r.text).not.toMatch(/ZZ-SECRET|ZZ-LONG|ZZ-WHIM|owner-accepted-risk/);
        expect(await totals(db)).toEqual(Object.fromEntries(TABLES.map((t) => [t, 0])));
      });
    }
  });
});
