// @vitest-environment node
// Migration 0022_experts (M13-lite WP1; docs/M13L_design.md "Schema"): applies, rolls back and comes back
// identical; every TEXT column is capped and no column can hold a body (PRD-036); every trigger fires; the
// claim-status edges of KB-073 are enforced for all 64 pairs; the eight licence-register rows are as D-522
// says (AT-39 a, d). Synthetic ZZ data on example.test hosts only (SEC-110, D-521).
import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "@/lib/db/migrate-core.mjs";
import { cleanupTempDbs, freshDb, MIGRATIONS, schemaOf, tempDbUrl, track } from "./helpers";

afterEach(cleanupTempDbs);

const NEW_TABLES = [
  "expert",
  "expert_red_flag",
  "source_item",
  "claim",
  "claim_revision",
  "claim_expert",
  "claim_item",
  "claim_status",
  "cluster",
  "cluster_state",
  "claim_cluster",
  "screening_run",
  "screening_result",
  "expert_proposal",
  "expert_call",
  "expert_call_outcome",
];
const AUTOMATED = ["expert_rss", "expert_youtube_feed", "expert_own_site"];
const MANUAL = [
  "expert_x",
  "expert_instagram",
  "expert_tiktok",
  "expert_facebook",
  "expert_linkedin",
];
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const NOW = "2030-03-05T08:00:00.000Z";
const D = "2030-03-05";

const fails = async (
  db: Client,
  sql: string,
  args: (string | number | null)[] = [],
): Promise<string> => {
  try {
    await db.execute({ sql, args });
  } catch (e) {
    return String((e as Error).message);
  }
  throw new Error(`expected to fail: ${sql}`);
};
const run = (db: Client, sql: string, args: (string | number | null)[] = []) =>
  db.execute({ sql, args });

const expert = (db: Client, id = "X-001", over: Record<string, string | number | null> = {}) => {
  const v = {
    name: `ZZ Expert ${id}`,
    status: "tracked",
    tier: "core",
    ...over,
  };
  return run(
    db,
    `INSERT INTO expert (id, name, status, tier, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, String(v.name), String(v.status), String(v.tier), NOW, NOW],
  );
};
const cluster = (db: Client, id = "K-001") =>
  run(
    db,
    `INSERT INTO cluster (id, name, category, statement, testability, external_grade, created_at)
     VALUES (?, 'ZZ cluster', 'trend_momentum', 'A statement.', 'testable_eod', 'none', ?)`,
    [id, NOW],
  );
const claim = (db: Client, id = "C-B1-001", type = "method", clusterId: string | null = null) =>
  run(
    db,
    `INSERT INTO claim (id, type, testability, cluster_id, created_at) VALUES (?, ?, 'testable_eod', ?, ?)`,
    [id, type, clusterId, NOW],
  );
const status = (db: Client, id: string, seq: number, s: string) =>
  run(
    db,
    `INSERT INTO claim_status (claim_id, seq, status, actor, at) VALUES (?, ?, ?, 'seed', ?)`,
    [id, seq, s, NOW],
  );
const item = (db: Client, expertId = "X-001", id = SHA_A, over = "") =>
  run(
    db,
    `INSERT INTO source_item (id, expert_id, url, platform, ingested_at, kind, extraction_status${over ? ", summary" : ""})
     VALUES (?, ?, 'https://a.example.test/p1', 'web', ?, 'method', 'seeded'${over ? ", ?" : ""})`,
    over ? [id, expertId, NOW, over] : [id, expertId, NOW],
  );

describe("migration 0022_experts: apply, roll back, apply again", () => {
  it("creates the sixteen tables, rolls back to 0021 and comes back identical", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    const ms = await loadMigrations(MIGRATIONS("main"));
    await migrateUp(db, ms);
    const after = await schemaOf(db);
    expect(NEW_TABLES).toHaveLength(16);
    for (const t of NEW_TABLES) expect(after.some((s) => s.startsWith(`table:${t}:`))).toBe(true);

    expect(await migrateDown(db, ms, 4)).toEqual({ rolledBack: 4, version: 21 });
    const mid = await schemaOf(db);
    for (const t of NEW_TABLES) expect(mid.some((s) => s.startsWith(`table:${t}:`))).toBe(false);
    const reg = await db.execute(
      "SELECT 1 FROM source_register WHERE source LIKE 'expert\\_%' ESCAPE '\\'",
    );
    expect(reg.rows).toHaveLength(0);
    const st = await db.execute(
      "SELECT 1 FROM source_status WHERE source LIKE 'expert\\_%' ESCAPE '\\'",
    );
    expect(st.rows).toHaveLength(0);
    const hist = await db.execute(
      "SELECT 1 FROM source_register_history WHERE source LIKE 'expert\\_%' ESCAPE '\\'",
    );
    expect(hist.rows).toHaveLength(0);

    expect(await migrateUp(db, ms)).toEqual({ applied: 4, version: 25 });
    expect(await schemaOf(db)).toEqual(after);
  });

  it("the no-delete guards on the register tables survive the roll-back", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    const ms = await loadMigrations(MIGRATIONS("main"));
    await migrateUp(db, ms);
    await migrateDown(db, ms, 4);
    expect(await fails(db, "DELETE FROM source_register WHERE source = 'yahoo_eod'")).toContain(
      "forever table",
    );
    expect(await fails(db, "DELETE FROM source_register_history")).toContain("append-only");
    expect(await fails(db, "DELETE FROM source_status WHERE source = 'yahoo_eod'")).toContain(
      "never deleted",
    );
  });
});

describe("PRD-036: caps on every TEXT column, no body-like column", () => {
  it("every TEXT column is capped by length() or an enumeration", async () => {
    const db = await freshDb("main");
    const missing: string[] = [];
    let seen = 0;
    for (const t of NEW_TABLES) {
      const sql = String(
        (
          await db.execute({
            sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
            args: [t],
          })
        ).rows[0].sql,
      ).replace(/\s+/g, " ");
      const cols = (await db.execute(`PRAGMA table_info(${t})`)).rows;
      for (const c of cols) {
        if (String(c.type) !== "TEXT") continue;
        seen += 1;
        const n = String(c.name);
        const capped =
          new RegExp(`length\\(${n}\\) (<=|=|BETWEEN) `).test(sql) ||
          new RegExp(`\\b${n} IN \\(`).test(sql);
        if (!capped) missing.push(`${t}.${n}`);
      }
    }
    expect(missing).toEqual([]);
    expect(seen).toBeGreaterThan(80);
  });

  it("no column is named like a body, and the widest cap is 4,000 characters", async () => {
    const db = await freshDb("main");
    const bad = /(body|content|transcript|html|raw|article|page_text|full_text)/i;
    for (const t of NEW_TABLES) {
      const cols = (await db.execute(`PRAGMA table_info(${t})`)).rows;
      for (const c of cols) {
        const n = String(c.name);
        // content_hash is a 64-character digest, not content.
        if (n === "content_hash") continue;
        expect(`${t}.${n}`).not.toMatch(bad);
      }
      const sql = String(
        (
          await db.execute({
            sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
            args: [t],
          })
        ).rows[0].sql,
      );
      for (const m of sql.matchAll(/length\(\w+\) <= (\d+)/g))
        expect(Number(m[1])).toBeLessThanOrEqual(4000);
    }
  });

  it("enforces the caps the design names", async () => {
    const db = await freshDb("main");
    await expert(db);
    await cluster(db);
    await claim(db);
    // summary 800, quote 160, title 200
    await item(db, "X-001", SHA_A, "s".repeat(800));
    expect(await fails(db, "DELETE FROM source_item")).toContain("append-only");
    const over = (col: string, n: number) =>
      fails(
        db,
        `INSERT INTO source_item (id, expert_id, url, platform, ingested_at, kind, extraction_status, ${col})
         VALUES (?, 'X-001', 'https://a.example.test/p2', 'web', ?, 'method', 'seeded', ?)`,
        [SHA_B, NOW, "x".repeat(n)],
      );
    expect(await over("summary", 801)).toContain("CHECK");
    expect(await over("quote", 161)).toContain("CHECK");
    expect(await over("title", 201)).toContain("CHECK");
    // claim_revision texts
    const rev = (col: string, n: number) =>
      fails(
        db,
        `INSERT INTO claim_revision (claim_id, seq, statement, ${col}, actor, at) VALUES ('C-B1-001', 1, 's', ?, 'seed', ?)`,
        ["x".repeat(n), NOW],
      );
    expect(await rev("formalisation_text", 1201)).toContain("CHECK");
    expect(await rev("vocabulary_gap_text", 301)).toContain("CHECK");
    expect(await rev("claimed_edge_text", 401)).toContain("CHECK");
    expect(
      await fails(
        db,
        `INSERT INTO claim_revision (claim_id, seq, statement, actor, at) VALUES ('C-B1-001', 1, ?, 'seed', ?)`,
        ["x".repeat(601), NOW],
      ),
    ).toContain("CHECK");
    // expert name 120, red flag 400
    expect(
      await fails(
        db,
        `INSERT INTO expert (id, name, status, tier, created_at, updated_at) VALUES ('X-002', ?, 'tracked', 'core', ?, ?)`,
        ["n".repeat(121), NOW, NOW],
      ),
    ).toContain("CHECK");
    expect(
      await fails(
        db,
        `INSERT INTO expert_red_flag (id, expert_id, text, source_url, noted_d, created_at) VALUES ('R1', 'X-001', ?, 'https://a.example.test/r', ?, ?)`,
        ["t".repeat(401), D, NOW],
      ),
    ).toContain("CHECK");
  });
});

describe("expert, red flags, items", () => {
  it("the expert row moves only in status, licence_status, poll_json and updated_at; no delete", async () => {
    const db = await freshDb("main");
    await expert(db);
    const r = await db.execute("SELECT licence_status, no_feed FROM expert WHERE id = 'X-001'");
    expect(r.rows[0].licence_status).toBe("unchecked");
    await run(
      db,
      `UPDATE expert SET status = 'paused', licence_status = 'registered', poll_json = '{"every":"weekly"}', updated_at = ? WHERE id = 'X-001'`,
      ["2030-03-06T00:00:00.000Z"],
    );
    for (const set of [
      "name = 'ZZ Other'",
      "tier = 'discovered'",
      "no_feed = 1",
      "audience_size = 5",
      "platforms_json = '[\"web\"]'",
      "created_at = '2031-01-01T00:00:00.000Z'",
    ])
      expect(await fails(db, `UPDATE expert SET ${set} WHERE id = 'X-001'`)).toContain(
        "only status",
      );
    expect(await fails(db, "DELETE FROM expert")).toContain("append-only");
  });

  it("enumerations and JSON shapes are checked", async () => {
    const db = await freshDb("main");
    expect(
      await fails(
        db,
        `INSERT INTO expert (id, name, status, tier, created_at, updated_at) VALUES ('X-9', 'ZZ', 'gone', 'core', ?, ?)`,
        [NOW, NOW],
      ),
    ).toContain("CHECK");
    expect(
      await fails(
        db,
        `INSERT INTO expert (id, name, status, tier, platforms_json, created_at, updated_at) VALUES ('X-9', 'ZZ', 'tracked', 'core', '{}', ?, ?)`,
        [NOW, NOW],
      ),
    ).toContain("CHECK");
    expect(
      await fails(
        db,
        `INSERT INTO expert (id, name, status, tier, licence_status, created_at, updated_at) VALUES ('X-9', 'ZZ', 'tracked', 'core', 'valid', ?, ?)`,
        [NOW, NOW],
      ),
    ).toContain("CHECK");
  });

  it("a red flag needs an expert and a source link (D-521); append-only", async () => {
    const db = await freshDb("main");
    const ins = (src: string | null, ex = "X-001") =>
      fails(
        db,
        `INSERT INTO expert_red_flag (id, expert_id, text, source_url, noted_d, created_at) VALUES ('R1', ?, 'A sourced note.', ?, ?, ?)`,
        [ex, src, D, NOW],
      );
    expect(await ins("https://a.example.test/r")).toContain("needs its expert");
    await expert(db);
    expect(await ins(null)).toContain("NOT NULL");
    expect(await ins("ftp://a.example.test/r")).toContain("CHECK");
    expect(await ins("not a url at all")).toContain("CHECK");
    await run(
      db,
      `INSERT INTO expert_red_flag (id, expert_id, text, source_url, noted_d, created_at) VALUES ('R1', 'X-001', 'A sourced note.', 'https://a.example.test/r', ?, ?)`,
      [D, NOW],
    );
    expect(await fails(db, "UPDATE expert_red_flag SET text = 'x'")).toContain("append-only");
    expect(await fails(db, "DELETE FROM expert_red_flag")).toContain("append-only");
  });

  it("an item needs an expert, an http(s) link and a lower-case hex id; URL plus hash is unique", async () => {
    const db = await freshDb("main");
    expect(
      await fails(
        db,
        `INSERT INTO source_item (id, expert_id, url, platform, ingested_at, kind, extraction_status) VALUES ('${SHA_A}', 'X-001', 'https://a.example.test/p', 'web', '${NOW}', 'other', 'seeded')`,
      ),
    ).toContain("needs its expert");
    await expert(db);
    await item(db);
    expect(
      await fails(
        db,
        `INSERT INTO source_item (id, expert_id, url, platform, ingested_at, kind, extraction_status) VALUES ('${"G".repeat(64)}', 'X-001', 'https://a.example.test/q', 'web', '${NOW}', 'other', 'seeded')`,
      ),
    ).toContain("CHECK");
    expect(
      await fails(
        db,
        `INSERT INTO source_item (id, expert_id, url, platform, ingested_at, kind, extraction_status) VALUES ('${SHA_B}', 'X-001', 'javascript:alert(1)', 'web', '${NOW}', 'other', 'seeded')`,
      ),
    ).toContain("CHECK");
    expect(
      await fails(
        db,
        `INSERT INTO source_item (id, expert_id, url, platform, ingested_at, kind, extraction_status) VALUES ('${SHA_B}', 'X-001', 'https://a.example.test/p', 'web', '${NOW}', 'other', 'bad')`,
      ),
    ).toContain("CHECK");
    // same URL and hash under another id is refused (UNIQUE) when a hash is present
    const h = "c".repeat(64);
    await run(
      db,
      `INSERT INTO source_item (id, expert_id, url, platform, ingested_at, content_hash, kind, extraction_status) VALUES ('${"d".repeat(64)}', 'X-001', 'https://a.example.test/h', 'web', '${NOW}', '${h}', 'other', 'seeded')`,
    );
    expect(
      await fails(
        db,
        `INSERT INTO source_item (id, expert_id, url, platform, ingested_at, content_hash, kind, extraction_status) VALUES ('${"e".repeat(64)}', 'X-001', 'https://a.example.test/h', 'web', '${NOW}', '${h}', 'other', 'seeded')`,
      ),
    ).toContain("UNIQUE");
    expect(await fails(db, "UPDATE source_item SET title = 'x'")).toContain("append-only");
  });
});

describe("claims, revisions, links", () => {
  it("claim: cluster must exist; cluster_id may be set once from NULL; nothing else moves; no delete", async () => {
    const db = await freshDb("main");
    expect(
      await fails(
        db,
        `INSERT INTO claim (id, type, testability, cluster_id, created_at) VALUES ('C1', 'method', 'testable_eod', 'K-404', '${NOW}')`,
      ),
    ).toContain("cluster must exist");
    await cluster(db, "K-001");
    await cluster(db, "K-002");
    await claim(db, "C1");
    const GUARD = "cluster_id may be set once from NULL or follow a cluster merge";
    expect(await fails(db, "UPDATE claim SET cluster_id = 'K-404' WHERE id = 'C1'")).toContain(
      GUARD,
    );
    await run(db, "UPDATE claim SET cluster_id = 'K-001' WHERE id = 'C1'");
    expect(await fails(db, "UPDATE claim SET cluster_id = 'K-002' WHERE id = 'C1'")).toContain(
      GUARD,
    );
    expect(await fails(db, "UPDATE claim SET cluster_id = NULL WHERE id = 'C1'")).toContain(GUARD);
    expect(await fails(db, "UPDATE claim SET type = 'call' WHERE id = 'C1'")).toContain(GUARD);
    expect(
      await fails(db, "UPDATE claim SET testability = 'not_testable' WHERE id = 'C1'"),
    ).toContain(GUARD);
    expect(await fails(db, "DELETE FROM claim")).toContain("append-only");

    // D-535: after K-001 is merged into K-002, the claim may follow the merge, and only that merge.
    await cluster(db, "K-003");
    await run(
      db,
      `INSERT INTO cluster_state (cluster_id, seq, state, actor, at) VALUES ('K-001', 1, 'confirmed', 'seed', '${NOW}')`,
    );
    expect(await fails(db, "UPDATE claim SET cluster_id = 'K-002' WHERE id = 'C1'")).toContain(
      GUARD,
    );
    await run(
      db,
      `INSERT INTO cluster_state (cluster_id, seq, state, merged_into, actor, at) VALUES ('K-001', 2, 'merged', 'K-002', 'seed', '${NOW}')`,
    );
    expect(await fails(db, "UPDATE claim SET cluster_id = 'K-003' WHERE id = 'C1'")).toContain(
      GUARD,
    );
    expect(await fails(db, "UPDATE claim SET cluster_id = NULL WHERE id = 'C1'")).toContain(GUARD);
    await run(db, "UPDATE claim SET cluster_id = 'K-002' WHERE id = 'C1'");
    expect(await fails(db, "UPDATE claim SET cluster_id = 'K-001' WHERE id = 'C1'")).toContain(
      GUARD,
    );
    expect(await fails(db, "UPDATE claim SET cluster_id = 'K-003' WHERE id = 'C1'")).toContain(
      GUARD,
    );
  });

  it("revisions are numbered 1, 2, 3 and never change", async () => {
    const db = await freshDb("main");
    expect(
      await fails(
        db,
        `INSERT INTO claim_revision (claim_id, seq, statement, actor, at) VALUES ('C1', 1, 's', 'seed', '${NOW}')`,
      ),
    ).toContain("needs its claim");
    await claim(db, "C1");
    const rev = (seq: number) =>
      run(
        db,
        `INSERT INTO claim_revision (claim_id, seq, statement, actor, at) VALUES ('C1', ?, 's', 'seed', ?)`,
        [seq, NOW],
      );
    expect(
      await fails(
        db,
        `INSERT INTO claim_revision (claim_id, seq, statement, actor, at) VALUES ('C1', 2, 's', 'seed', '${NOW}')`,
      ),
    ).toContain("next seq");
    await rev(1);
    await rev(2);
    expect(
      await fails(
        db,
        `INSERT INTO claim_revision (claim_id, seq, statement, actor, at) VALUES ('C1', 2, 's', 'seed', '${NOW}')`,
      ),
    ).toContain("next seq");
    expect(await fails(db, "UPDATE claim_revision SET statement = 'x'")).toContain("append-only");
    expect(await fails(db, "DELETE FROM claim_revision")).toContain("append-only");
  });

  it("claim_expert, claim_item and claim_cluster need both ends and are append-only", async () => {
    const db = await freshDb("main");
    await expert(db);
    await cluster(db);
    await claim(db, "C1");
    await item(db);
    expect(await fails(db, "INSERT INTO claim_expert VALUES ('C1', 'X-404')")).toContain(
      "must exist",
    );
    expect(await fails(db, "INSERT INTO claim_expert VALUES ('C-404', 'X-001')")).toContain(
      "must exist",
    );
    await run(db, "INSERT INTO claim_expert VALUES ('C1', 'X-001')");
    expect(await fails(db, `INSERT INTO claim_item VALUES ('C1', '${SHA_B}')`)).toContain(
      "must exist",
    );
    await run(db, `INSERT INTO claim_item VALUES ('C1', '${SHA_A}')`);
    expect(
      await fails(db, "INSERT INTO claim_cluster VALUES ('C1', 'K-404', 'supports')"),
    ).toContain("must exist");
    expect(
      await fails(db, "INSERT INTO claim_cluster VALUES ('C1', 'K-001', 'neutral')"),
    ).toContain("CHECK");
    await run(db, "INSERT INTO claim_cluster VALUES ('C1', 'K-001', 'supports')");
    for (const t of ["claim_expert", "claim_item", "claim_cluster"]) {
      expect(await fails(db, `UPDATE ${t} SET claim_id = claim_id`)).toContain("append-only");
      expect(await fails(db, `DELETE FROM ${t}`)).toContain("append-only");
    }
  });
});

describe("claim status chain (KB-073)", () => {
  const STATES = [
    "extracted",
    "owner_checked",
    "formalised",
    "screened",
    "challenger",
    "promoted",
    "rejected",
    "parked",
  ];
  const EDGES = new Set([
    "extracted>owner_checked",
    "extracted>rejected",
    "extracted>parked",
    "owner_checked>formalised",
    "owner_checked>rejected",
    "owner_checked>parked",
    "formalised>screened",
    "formalised>parked",
    "screened>challenger",
    "screened>parked",
    "screened>rejected",
    "challenger>promoted",
    "challenger>rejected",
    "challenger>parked",
    "parked>owner_checked",
  ]);
  // A path of allowed edges from 'extracted' to each state.
  const PATH: Record<string, string[]> = {
    extracted: [],
    owner_checked: ["owner_checked"],
    formalised: ["owner_checked", "formalised"],
    screened: ["owner_checked", "formalised", "screened"],
    challenger: ["owner_checked", "formalised", "screened", "challenger"],
    promoted: ["owner_checked", "formalised", "screened", "challenger", "promoted"],
    rejected: ["rejected"],
    parked: ["parked"],
  };

  it("the first status must be extracted; seq runs 1, 2, 3 in order", async () => {
    const db = await freshDb("main");
    expect(
      await fails(
        db,
        `INSERT INTO claim_status (claim_id, seq, status, actor, at) VALUES ('C1', 1, 'extracted', 'seed', '${NOW}')`,
      ),
    ).toContain("needs its claim");
    await claim(db, "C1");
    expect(
      await fails(
        db,
        `INSERT INTO claim_status (claim_id, seq, status, actor, at) VALUES ('C1', 1, 'owner_checked', 'seed', '${NOW}')`,
      ),
    ).toContain("first status");
    await status(db, "C1", 1, "extracted");
    expect(
      await fails(
        db,
        `INSERT INTO claim_status (claim_id, seq, status, actor, at) VALUES ('C1', 3, 'owner_checked', 'seed', '${NOW}')`,
      ),
    ).toContain("next seq");
    await status(db, "C1", 2, "owner_checked");
    expect(await fails(db, "UPDATE claim_status SET status = 'rejected'")).toContain("append-only");
    expect(await fails(db, "DELETE FROM claim_status")).toContain("append-only");
  });

  it("allows exactly the 15 edges of KB-073 and refuses the other 49 of the 64 pairs", async () => {
    const db = await freshDb("main");
    let n = 0;
    for (const from of STATES) {
      for (const to of STATES) {
        n += 1;
        const id = `C-${from}-${to}`;
        await claim(db, id);
        let seq = 1;
        await status(db, id, seq, "extracted");
        for (const s of PATH[from]) await status(db, id, (seq += 1), s);
        const attempt = status(db, id, seq + 1, to);
        if (EDGES.has(`${from}>${to}`)) await attempt;
        else await expect(attempt).rejects.toThrow(/edge not allowed/);
      }
    }
    expect(n).toBe(64);
    expect(EDGES.size).toBe(15);
  });

  it("a parked claim returns only to owner_checked; rejected and promoted are final", async () => {
    const db = await freshDb("main");
    await claim(db, "P");
    await status(db, "P", 1, "extracted");
    await status(db, "P", 2, "parked");
    await expect(status(db, "P", 3, "extracted")).rejects.toThrow(/edge not allowed/);
    await status(db, "P", 3, "owner_checked");
    await status(db, "P", 4, "rejected");
    for (const s of STATES) await expect(status(db, "P", 5, s)).rejects.toThrow(/edge not allowed/);
  });
});

describe("clusters and their state", () => {
  it("cluster rows never change; the enumerations are checked", async () => {
    const db = await freshDb("main");
    await cluster(db);
    expect(await fails(db, "UPDATE cluster SET name = 'x'")).toContain("append-only");
    expect(await fails(db, "DELETE FROM cluster")).toContain("append-only");
    expect(
      await fails(
        db,
        `INSERT INTO cluster (id, name, category, statement, testability, external_grade, created_at) VALUES ('K-2', 'n', 'astrology', 's', 'testable_eod', 'none', '${NOW}')`,
      ),
    ).toContain("CHECK");
    expect(
      await fails(
        db,
        `INSERT INTO cluster (id, name, category, statement, testability, external_grade, closest_family, created_at) VALUES ('K-2', 'n', 'none', 's', 'testable_eod', 'none', 'F9', '${NOW}')`,
      ),
    ).toContain("CHECK");
    expect(
      await fails(
        db,
        `INSERT INTO cluster (id, name, category, statement, testability, external_grade, family_fit_json, created_at) VALUES ('K-2', 'n', 'none', 's', 'testable_eod', 'none', '[1]', '${NOW}')`,
      ),
    ).toContain("CHECK");
    await run(
      db,
      `INSERT INTO cluster (id, name, category, statement, testability, external_grade, closest_family, family_fit_json, created_at) VALUES ('K-3', 'n', 'none', 's', 'testable_eod', 'none', 'F1', '{"family":"F1","params":{}}', '${NOW}')`,
    );
  });

  it("cluster_state: next seq, merge needs another existing cluster, append-only", async () => {
    const db = await freshDb("main");
    const st = (cid: string, seq: number, state: string, into: string | null = null) =>
      run(
        db,
        `INSERT INTO cluster_state (cluster_id, seq, state, merged_into, actor, at) VALUES (?, ?, ?, ?, 'seed', ?)`,
        [cid, seq, state, into, NOW],
      );
    await expect(st("K-001", 1, "proposed")).rejects.toThrow(/needs its cluster/);
    await cluster(db, "K-001");
    await cluster(db, "K-002");
    await expect(st("K-001", 2, "proposed")).rejects.toThrow(/next seq/);
    await st("K-001", 1, "proposed");
    await st("K-001", 2, "confirmed");
    await expect(st("K-001", 3, "merged")).rejects.toThrow(/CHECK/);
    await expect(st("K-001", 3, "confirmed", "K-002")).rejects.toThrow(/CHECK/);
    await expect(st("K-001", 3, "merged", "K-001")).rejects.toThrow(/another existing cluster/);
    await expect(st("K-001", 3, "merged", "K-404")).rejects.toThrow(/another existing cluster/);
    await st("K-001", 3, "merged", "K-002");
    // D-535: merged is final
    await expect(st("K-001", 4, "confirmed")).rejects.toThrow(/merged cluster is final/);
    await expect(st("K-001", 4, "parked")).rejects.toThrow(/merged cluster is final/);
    expect(await fails(db, "UPDATE cluster_state SET reason = 'x'")).toContain("append-only");
    expect(await fails(db, "DELETE FROM cluster_state")).toContain("append-only");
  });
});

describe("screening, proposals, calls", () => {
  const runRow = (db: Client, id = "expscreen:ZZ:2030-03-05") =>
    run(
      db,
      `INSERT INTO screening_run (run_id, market, d, q, considered, eligible, screened, survivors, splits_json, created_at)
       VALUES (?, 'ZZ', ?, 0.1, 5, 4, 3, 1, '{"F1":"s1"}', ?)`,
      [id, D, NOW],
    );
  const result = (
    db: Client,
    cid: string,
    over: { bh?: number; sign?: number; surv?: number; grade?: string } = {},
  ) =>
    run(
      db,
      `INSERT INTO screening_result (run_id, cluster_id, family, params_sha, rows, blocks, mean_net_ppm, p, adjusted_p,
         bh_rejected, sign_agrees, survived, rank, grade)
       VALUES ('expscreen:ZZ:2030-03-05', ?, 'F1', ?, 100, 12, 1500, 0.01, 0.03, ?, ?, ?, 1, ?)`,
      [cid, SHA_A, over.bh ?? 1, over.sign ?? 1, over.surv ?? 1, over.grade ?? "L1"],
    );

  it("screening_run is insert-once, one per market and day", async () => {
    const db = await freshDb("main");
    await runRow(db);
    await expect(runRow(db)).rejects.toThrow();
    await expect(runRow(db, "other")).rejects.toThrow(/UNIQUE/);
    expect(await fails(db, "UPDATE screening_run SET q = 0.2")).toContain("append-only");
    expect(await fails(db, "DELETE FROM screening_run")).toContain("append-only");
    expect(
      await fails(
        db,
        `INSERT INTO screening_run (run_id, market, d, q, considered, eligible, screened, survivors, splits_json, created_at) VALUES ('r2', 'ZZ', '2030-03-12', 0.1, 1, 2, 0, 0, '{}', '${NOW}')`,
      ),
    ).toContain("CHECK");
  });

  it("screening_result needs its run and cluster; survived and grade follow KB-076", async () => {
    const db = await freshDb("main");
    await expect(result(db, "K-001")).rejects.toThrow(/run and cluster must exist/);
    await runRow(db);
    await expect(result(db, "K-001")).rejects.toThrow(/run and cluster must exist/);
    await cluster(db, "K-001");
    await cluster(db, "K-002");
    await cluster(db, "K-003");
    await result(db, "K-001");
    // survived must equal BH-rejected AND sign agreement; grade L1 iff survived
    await expect(result(db, "K-002", { bh: 1, sign: 0, surv: 1, grade: "L1" })).rejects.toThrow(
      /CHECK/,
    );
    await expect(result(db, "K-002", { bh: 1, sign: 1, surv: 0, grade: "L0" })).rejects.toThrow(
      /CHECK/,
    );
    await expect(result(db, "K-002", { bh: 1, sign: 1, surv: 1, grade: "L0" })).rejects.toThrow(
      /CHECK/,
    );
    await expect(result(db, "K-002", { bh: 1, sign: 1, surv: 1, grade: "L2" })).rejects.toThrow(
      /CHECK/,
    );
    await result(db, "K-002", { bh: 0, sign: 1, surv: 0, grade: "L0" });
    expect(await fails(db, "UPDATE screening_result SET rank = 2")).toContain("append-only");
    expect(await fails(db, "DELETE FROM screening_result")).toContain("append-only");
  });

  it("expert_proposal: kind and status agree; the F7 row has no cluster; append-only", async () => {
    const db = await freshDb("main");
    await cluster(db, "K-001");
    const prop = (id: string, kind: string, status: string, cid: string | null) =>
      run(
        db,
        `INSERT INTO expert_proposal (id, market, d, cluster_id, kind, status, created_at) VALUES (?, 'ZZ', ?, ?, ?, ?, ?)`,
        [id, D, cid, kind, status, NOW],
      );
    await prop("p1", "challenger", "created", "K-001");
    await prop("p2", "new_lineage", "parked_build_change", "K-001");
    await prop("p3", "f7_lineage", "dormant", null);
    await expect(prop("p4", "challenger", "dormant", "K-001")).rejects.toThrow(/CHECK/);
    await expect(prop("p5", "new_lineage", "created", "K-001")).rejects.toThrow(/CHECK/);
    await expect(prop("p6", "f7_lineage", "dormant", "K-001")).rejects.toThrow(/CHECK/);
    await expect(prop("p7", "challenger", "refused", null)).rejects.toThrow(/CHECK/);
    await expect(prop("p8", "challenger", "created", "K-404")).rejects.toThrow(
      /cluster must exist/,
    );
    expect(await fails(db, "UPDATE expert_proposal SET status = 'refused'")).toContain(
      "append-only",
    );
    expect(await fails(db, "DELETE FROM expert_proposal")).toContain("append-only");
  });

  it("calls: a call claim only; the outcome needs a tracked call and is insert-once", async () => {
    const db = await freshDb("main");
    const call = (id: string, tracked: number) =>
      run(
        db,
        `INSERT INTO expert_call (claim_id, market, code, direction, call_d, horizon_sessions, tracked, created_at) VALUES (?, 'ZZ', 'ZZA1', 'long', ?, 20, ?, ?)`,
        [id, D, tracked, NOW],
      );
    const out = (id: string, state = "closed_horizon", entry: string | null = D) =>
      run(
        db,
        `INSERT INTO expert_call_outcome (claim_id, state, entry_d, exit_d, net_ppm, index_code, basis, settled_d) VALUES (?, ?, ?, ?, 1000, 'ZZIDX', 'total_return', ?)`,
        [id, state, entry, entry, "2030-04-05"],
      );
    await claim(db, "M1", "method");
    await claim(db, "CALL1", "call");
    await claim(db, "CALL2", "call");
    await claim(db, "CALL3", "call");
    await expect(call("M1", 1)).rejects.toThrow(/type call/);
    await expect(call("NOPE", 1)).rejects.toThrow(/type call/);
    await call("CALL1", 1);
    await call("CALL2", 0);
    await expect(out("CALL2")).rejects.toThrow(/tracked call/);
    await expect(out("CALL1", "closed_target", null)).rejects.toThrow(/CHECK/);
    await out("CALL1");
    await expect(out("CALL1")).rejects.toThrow();
    expect(await fails(db, "UPDATE expert_call SET tracked = 1")).toContain("append-only");
    expect(await fails(db, "UPDATE expert_call_outcome SET net_ppm = 1")).toContain("append-only");
    expect(await fails(db, "DELETE FROM expert_call_outcome")).toContain("append-only");
    expect(await fails(db, "DELETE FROM expert_call")).toContain("append-only");
    expect(
      await fails(
        db,
        `INSERT INTO expert_call (claim_id, market, code, direction, call_d, horizon_sessions, tracked, created_at) VALUES ('CALL3', 'ZZ', 'ZZA1', 'sideways', '${D}', 20, 0, '${NOW}')`,
      ),
    ).toContain("CHECK");
  });
});

describe("licence register rows (DAT-227, D-522; AT-39 d)", () => {
  it("three automated classes are pending, five platforms are disabled and manual-only, status rows are off", async () => {
    const db = await freshDb("main");
    const rows = (
      await db.execute(
        "SELECT source, permitted_use, risk, status, owner_ref, summarisation_permitted FROM source_register WHERE source LIKE 'expert\\_%' ESCAPE '\\' ORDER BY source",
      )
    ).rows;
    expect(rows.map((r) => String(r.source)).sort()).toEqual([...AUTOMATED, ...MANUAL].sort());
    for (const r of rows) {
      const s = String(r.source);
      expect(r.owner_ref).toBeNull();
      if (AUTOMATED.includes(s)) {
        expect(r.status).toBe("pending");
        expect(r.risk).toBe("medium");
        expect(r.summarisation_permitted).toBe(1);
        expect(String(r.permitted_use)).toContain("[VERIFY]");
        expect(String(r.permitted_use)).toContain("own summary only");
      } else {
        expect(r.status).toBe("disabled");
        expect(r.risk).toBe("high");
        expect(r.summarisation_permitted).toBe(0);
        expect(String(r.permitted_use)).toMatch(/^manual-only: Owner pastes a link/);
      }
    }
    const st = (
      await db.execute(
        "SELECT source, mode FROM source_status WHERE source LIKE 'expert\\_%' ESCAPE '\\'",
      )
    ).rows;
    expect(st).toHaveLength(8);
    for (const r of st) expect(r.mode).toBe("off");
    // the 0004 trigger logged one 'insert' history row each
    const hist = await db.execute(
      "SELECT COUNT(*) AS n FROM source_register_history WHERE op = 'insert' AND source LIKE 'expert\\_%' ESCAPE '\\'",
    );
    expect(hist.rows[0].n).toBe(8);
  });
});
