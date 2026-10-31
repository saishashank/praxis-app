// @vitest-environment node
// Main DB migration 0009_sentinel_email (M5 T1, docs/M5_design.md section 3, D-096, D-097).
// HIGH-RISK (alerts, the email ledger and the pre-open money trail): up/down/up, every append-only /
// one-way / counter / prune-only trigger refuses the forbidden write, the allowed transitions pass,
// CHECK constraints, backup round trip. All values are synthetic.
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "@/lib/db/migrate-core.mjs";
import { dumpDatabase, restoreDatabase } from "../../scripts/backup/core.mjs";
import {
  ALERT_KINDS,
  BREAKER_PHASES,
  CREDENTIAL_NAME_LIST,
  EMAIL_KINDS,
  EMAIL_SLOTS,
  HEALTH_COMPONENTS,
  SENTINEL_APPEND_ONLY_TABLES,
  SENTINEL_COLUMNS,
  SENTINEL_FOREVER_TABLES,
  SENTINEL_ONE_WAY_TABLES,
  SENTINEL_PRUNED_TABLES,
  SENTINEL_TABLES,
} from "@/lib/sentinel/schema";
import { cleanupTempDbs, freshDb, MIGRATIONS, schemaOf, tempDbUrl, track } from "../db/helpers";
import { createClient } from "@libsql/client";

afterEach(cleanupTempDbs);

type V = string | number | null;
const q = async (db: Client, sql: string, args: V[] = []) =>
  (await db.execute({ sql, args })).rows.map((r) => ({ ...r }));
const run = (db: Client, sql: string, args: V[] = []) => db.execute({ sql, args });
const ins = (db: Client, table: string, row: Record<string, V>) =>
  run(
    db,
    `INSERT INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row)
      .map(() => "?")
      .join(", ")})`,
    Object.values(row),
  );

const TODAY = new Date().toISOString().slice(0, 10);
const NOW = new Date().toISOString();
const OLD_D = "2020-01-01";
const OLD_AT = "2020-01-01T00:00:00.000Z";
const AT = "2026-10-12T08:10:00.000Z";
const HEX64 = "a".repeat(64);

// One valid row per table. Rows that a pruned table must keep use today's date or instant.
const ROW: Record<string, Record<string, V>> = {
  sentinel_poll_day: {
    market: "AU",
    source: "asx_announcements",
    d: TODAY,
    scheduled: 10,
    ok: 8,
    not_modified: 1,
    failed: 1,
    blocked: 0,
    max_gap_s: 300,
    last_ok_at: NOW,
  },
  sentinel_ingest: {
    id: "si:asx_announcements:" + HEX64,
    received_at: NOW,
    items_seen: 50,
    items_new: 45,
    assessed: 40,
    carried: 5,
    status: "partial",
    attempt: 1,
  },
  item_assessment: {
    source: "asx_announcements",
    ann_id: "A1",
    market: "AU",
    code: "ZZAA",
    materiality: 2,
    rule_version: "MATERIALITY_RULES_V1",
    polarity: 0,
    held: 0,
    watch: 1,
    candidate: 1,
    tracked: 1,
    assessed_at: NOW,
    materiality_llm: null,
    text_llm: null,
  },
  watch_list_owner: {
    id: "wl:AU:ZZAA:1",
    market: "AU",
    code: "ZZAA",
    added_by: 1,
    added_at: "2026-10-19T01:00:00.000Z",
    expires_d: "2026-11-18",
    removed_at: null,
  },
  alert: {
    alert_key: "ann:AU:asx_announcements:A1",
    market: "AU",
    code: "ZZAA",
    kind: "announcement",
    tier: "P0",
    execution_id: "E01",
    weight_ppm: 120_000,
    materiality: 3,
    published_at: AT,
    detected_at: NOW,
    facts_json: "{}",
    email_key: null,
    text_llm: null,
  },
  thesis_breaker_eval: {
    subject_id: "T1",
    breaker_id: "TB-NEG",
    d: "2026-10-12",
    phase: "nightly",
    seq: 1,
    subject_kind: "trade",
    card_id: "card1",
    market: "AU",
    code: "ZZAA",
    status: "green",
    value_text: "no negative announcement",
    trigger_text: "negative announcement",
    amber_text: null,
    trigger_ref: null,
    rule_version: "TB_RULES_V1",
  },
  preopen_run: {
    market: "AU",
    d: "2026-10-13",
    attempt: 1,
    started_at: "2026-10-12T22:54:00.000Z",
    finished_at: null,
    status: "error",
    checked: 0,
    cancelled: 0,
  },
  preopen_result: {
    order_id: "O1",
    market: "AU",
    d: "2026-10-13",
    outcome: "pass",
    reason: null,
    card_id: "card1",
  },
  evening_review: {
    d: "2026-10-12",
    version: 1,
    kind: "full",
    missing_json: "[]",
    facts_json: "{}",
    facts_sha: HEX64,
    html: "<p>x</p>",
    text: "x",
    markdown: "x",
    size_html: 8,
    narrative: "rules",
    created_at: AT,
  },
  review_read: { d: "2026-10-12", read_at: AT, via: "page" },
  email_message: {
    email_key: "review:2026-10-12",
    env: "test",
    kind: "review",
    d: "2026-10-12",
    slot: "reserved_review",
    status: "claimed",
    subject: "",
    size_html: 0,
    size_text: 0,
    provider_id: null,
    attempts: 0,
    recipient_sha: null,
    created_at: NOW,
    sent_at: null,
    ref_json: "{}",
  },
  email_attempt: {
    email_key: "review:2026-10-12",
    n: 1,
    at: NOW,
    outcome: "accepted",
    http_status: 200,
    provider_id: "mock-1",
  },
  health_snapshot: { d: TODAY, purpose: "reminder", components_json: "{}" },
  attention_snooze: {
    id: "sn1",
    component: "security",
    item_key: "turso_token",
    from_d: "2026-10-19",
    until_d: "2026-10-22",
    created_at: AT,
    created_by: 1,
  },
  credential_expiry: {
    name: "d_turso_main_tokens",
    expires_on: "2027-01-31",
    set_at: AT,
    set_by: 1,
  },
  credential_expiry_history: {
    name: "x",
    changed_at: AT,
    op: "insert",
    expires_on: "2027-01-31",
    set_by: 1,
  },
};

/** Rows the seeded tables depend on: an announcement, an E and a C1 execution, a card, orders. */
async function seedParents(db: Client) {
  await ins(db, "announcement", {
    market: "AU",
    code: "ZZAA",
    ann_id: "A1",
    published_at: AT,
    ingested_at: AT,
    type: "PS",
    price_sensitive: 1,
    title: "Trading halt",
    url: "https://www.asx.com.au/x",
    source: "asx_announcements",
  });
  await ins(db, "execution", {
    id: "E01",
    market: "AU",
    kind: "E",
    family: "F1",
    variant: "U",
    rule_version: "rv1",
    cost_profile: "P5",
  });
  await ins(db, "execution", {
    id: "C1",
    market: "AU",
    kind: "C1",
    family: null,
    variant: null,
    rule_version: "rv1",
    cost_profile: "P5",
  });
  await ins(db, "cohort", {
    id: "K1",
    execution_id: "E01",
    start_d: "2026-10-12",
    seed_micro: 600_000_000,
    rule_version: "rv1",
    params_json: "{}",
    cost_profile_version: 1,
    rng_seed: 42,
  });
  await ins(db, "arena_order", {
    id: "O1",
    cohort_id: "K1",
    decided_d: "2026-10-12",
    code: "ZZAA",
    side: "buy",
    kind: "entry",
    qty: 10,
  });
  await ins(db, "signal", {
    id: "sig1",
    market: "AU",
    d: "2026-10-12",
    family: "F1",
    rule_version: "rv1",
    variant: "F1",
    code: "ZZAA",
    regime: "RISK-ON",
    rank_score: "0.93",
    rules_json: "[]",
    evidence_json: "{}",
    classes: null,
    group_key: null,
    partial: 0,
    schema_version: 1,
    agent_version: "a1",
    inputs_ref: "run1",
    decided_at: AT,
  });
  await ins(db, "decision_card", {
    id: "card1",
    signal_id: "sig1",
    execution_id: "E01",
    cohort_id: null,
    taken: 0,
    not_taken_reason: "rank",
    order_id: null,
    card_json: "{}",
    card_sha: HEX64,
    schema_version: 1,
    decided_at: AT,
  });
}

// Insert order respects the cross-check guards (parents first).
const SEED_ORDER = [
  "sentinel_poll_day",
  "sentinel_ingest",
  "item_assessment",
  "watch_list_owner",
  "alert",
  "thesis_breaker_eval",
  "preopen_run",
  "preopen_result",
  "evening_review",
  "review_read",
  "email_message",
  "email_attempt",
  "health_snapshot",
  "attention_snooze",
  "credential_expiry",
] as const;

async function seeded(): Promise<Client> {
  const db = await freshDb("main");
  await seedParents(db);
  for (const t of SEED_ORDER) await ins(db, t, ROW[t]);
  return db;
}

const TABLES = Object.values(SENTINEL_TABLES);

describe("main migration 0009_sentinel_email: shape", () => {
  it("is the ninth main migration", async () => {
    const ms = await loadMigrations(MIGRATIONS("main"));
    expect(ms[8]).toMatchObject({ version: 9, name: "sentinel_email" });
  });

  it("creates exactly the 16 tables of schema.ts with the columns in order", async () => {
    const db = await freshDb("main");
    expect(TABLES).toHaveLength(16);
    expect(Object.keys(ROW).sort()).toEqual([...TABLES].sort());
    for (const t of TABLES) {
      const cols = (await q(db, `PRAGMA table_info(${t})`)).map((r) => r.name);
      expect(cols, t).toEqual([...SENTINEL_COLUMNS[t]]);
    }
  });

  it("every table is STRICT; columns are INTEGER or TEXT only (no REAL, no money columns)", async () => {
    const db = await freshDb("main");
    for (const t of TABLES) {
      expect((await q(db, `SELECT strict FROM pragma_table_list('${t}')`))[0].strict, t).toBe(1);
      for (const c of await q(db, `PRAGMA table_info(${t})`)) {
        expect(["INTEGER", "TEXT"], `${t}.${String(c.name)}`).toContain(c.type);
        expect(String(c.name).endsWith("_micro"), `${t}.${String(c.name)}`).toBe(false);
        if (String(c.name).endsWith("_ppm")) expect(c.type).toBe("INTEGER");
      }
    }
  });

  it("the table sets cover every table once (append-only + one-way; forever + pruned)", () => {
    const all = [...TABLES].sort();
    // credential_expiry_history is append-only too: both sets are disjoint and complete.
    expect([...SENTINEL_APPEND_ONLY_TABLES, ...SENTINEL_ONE_WAY_TABLES].sort()).toEqual(all);
    expect([...SENTINEL_FOREVER_TABLES, ...Object.keys(SENTINEL_PRUNED_TABLES)].sort()).toEqual(
      all,
    );
  });

  it("seeds nothing", async () => {
    const db = await freshDb("main");
    for (const t of TABLES) expect((await q(db, `SELECT COUNT(*) AS n FROM ${t}`))[0].n, t).toBe(0);
  });

  it("a valid row for every table inserts; the same insert twice is a UNIQUE error, not a replace", async () => {
    const db = await seeded();
    for (const t of TABLES) {
      // credential_expiry_history holds the one row its insert trigger wrote.
      expect((await q(db, `SELECT COUNT(*) AS n FROM ${t}`))[0].n, t).toBe(1);
    }
    for (const t of SEED_ORDER) {
      await expect(ins(db, t, ROW[t]), t).rejects.toThrow(/UNIQUE|PRIMARY KEY/);
    }
    await run(
      db,
      "INSERT INTO review_read (d, read_at, via) VALUES ('2026-10-12', 'later', 'email_link') ON CONFLICT DO NOTHING",
    );
    expect((await q(db, "SELECT via FROM review_read"))[0].via).toBe("page");
  });
});

describe("main migration 0009_sentinel_email: append-only, forever and prune-only", () => {
  // One harmless-looking UPDATE per append-only table that would change a single column.
  const UPDATES: Record<string, string> = {
    thesis_breaker_eval: "UPDATE thesis_breaker_eval SET status = 'red'",
    preopen_result: "UPDATE preopen_result SET outcome = 'not_rechecked'",
    evening_review: "UPDATE evening_review SET html = 'y'",
    review_read: "UPDATE review_read SET via = 'email_link'",
    email_attempt: "UPDATE email_attempt SET outcome = 'rejected', provider_id = NULL",
    health_snapshot: "UPDATE health_snapshot SET components_json = '[]'",
    attention_snooze: "UPDATE attention_snooze SET until_d = '2026-10-21'",
    credential_expiry_history: "UPDATE credential_expiry_history SET expires_on = '2030-01-01'",
  };
  for (const t of SENTINEL_APPEND_ONLY_TABLES) {
    it(`${t}: UPDATE aborts and the row is unchanged`, async () => {
      const db = await seeded();
      const before = await q(db, `SELECT * FROM ${t}`);
      await expect(run(db, UPDATES[t])).rejects.toThrow(/append-only/);
      expect(await q(db, `SELECT * FROM ${t}`)).toEqual(before);
    });
  }

  const DELETABLE = Object.keys(SENTINEL_PRUNED_TABLES);
  const forever = TABLES.filter((t) => !DELETABLE.includes(t));
  for (const t of forever) {
    it(`${t}: DELETE aborts (forever / append-only), the row stays`, async () => {
      const db = await seeded();
      await expect(run(db, `DELETE FROM ${t}`)).rejects.toThrow(/append-only|forever table/);
      expect((await q(db, `SELECT COUNT(*) AS n FROM ${t}`))[0].n).toBe(1);
    });
  }

  // For each pruned table: a second row with an old key/date is deletable, today's is not.
  const OLD_ROW: Record<string, Record<string, V>> = {
    sentinel_poll_day: { ...ROW.sentinel_poll_day, d: OLD_D },
    sentinel_ingest: {
      ...ROW.sentinel_ingest,
      id: "si:asx_announcements:old",
      received_at: OLD_AT,
    },
    item_assessment: { ...ROW.item_assessment, ann_id: "A0", assessed_at: OLD_AT },
    alert: { ...ROW.alert, alert_key: "ann:AU:asx_announcements:A0", detected_at: OLD_AT },
    email_message: {
      ...ROW.email_message,
      email_key: "test:0",
      kind: "test",
      slot: "pool",
      created_at: OLD_AT,
    },
    email_attempt: { ...ROW.email_attempt, at: OLD_AT, n: 2 },
    health_snapshot: { ...ROW.health_snapshot, d: OLD_D },
  };
  for (const t of DELETABLE) {
    it(`${t}: only rows beyond the retention floor can be deleted`, async () => {
      const db = await seeded();
      if (t === "item_assessment") {
        await ins(db, "announcement", {
          market: "AU",
          code: "ZZAA",
          ann_id: "A0",
          published_at: OLD_AT,
          ingested_at: OLD_AT,
          type: null,
          price_sensitive: 0,
          title: "x",
          url: null,
          source: "asx_announcements",
        });
      }
      if (t === "email_attempt") await ins(db, "email_message", OLD_ROW.email_message);
      await ins(db, t, OLD_ROW[t]);
      const before = (await q(db, `SELECT COUNT(*) AS n FROM ${t}`))[0].n as number;
      await expect(run(db, `DELETE FROM ${t}`)).rejects.toThrow(/delete only/);
      const col = SENTINEL_PRUNED_TABLES[t as keyof typeof SENTINEL_PRUNED_TABLES].column;
      await run(db, `DELETE FROM ${t} WHERE ${col} = ?`, [OLD_ROW[t][col]]);
      expect((await q(db, `SELECT COUNT(*) AS n FROM ${t}`))[0].n).toBe(before - 1);
      expect((await q(db, `SELECT ${col} AS v FROM ${t}`))[0].v).toBe(ROW[t][col]);
    });
  }
});

describe("main migration 0009_sentinel_email: sentinel_poll_day (counters only grow)", () => {
  it("the upsert writer increments; a decrease, a key change or a last_ok_at regression is refused", async () => {
    const db = await seeded();
    await run(
      db,
      `INSERT INTO sentinel_poll_day (market, source, d, scheduled, ok) VALUES ('AU','asx_announcements',?,1,1)
       ON CONFLICT (market, source, d) DO UPDATE SET scheduled = scheduled + 1, ok = ok + 1`,
      [TODAY],
    );
    expect(await q(db, "SELECT scheduled, ok FROM sentinel_poll_day")).toEqual([
      { scheduled: 11, ok: 9 },
    ]);
    for (const set of [
      "ok = ok - 1",
      "scheduled = 0",
      "not_modified = 0",
      "failed = 0",
      "blocked = -1",
      "max_gap_s = 1",
      "last_ok_at = '2000-01-01T00:00:00.000Z'",
      "last_ok_at = NULL",
      "source = 'x'",
      "market = 'US'",
      "d = '2020-01-01'",
    ]) {
      await expect(run(db, `UPDATE sentinel_poll_day SET ${set}`), set).rejects.toThrow(
        /counters only increase|CHECK/,
      );
    }
    await run(db, "UPDATE sentinel_poll_day SET max_gap_s = 600, failed = failed + 1");
  });

  it("last_ok_at may go NULL -> value, and a new day is a new row", async () => {
    const db = await freshDb("main");
    await ins(db, "sentinel_poll_day", { ...ROW.sentinel_poll_day, last_ok_at: null });
    await run(db, "UPDATE sentinel_poll_day SET last_ok_at = ?", [NOW]);
    await ins(db, "sentinel_poll_day", { ...ROW.sentinel_poll_day, d: "2026-10-12" });
    expect((await q(db, "SELECT COUNT(*) AS n FROM sentinel_poll_day"))[0].n).toBe(2);
  });

  it("CHECKs: negative counters and a bad date", async () => {
    const db = await freshDb("main");
    await expect(
      ins(db, "sentinel_poll_day", { ...ROW.sentinel_poll_day, ok: -1 }),
    ).rejects.toThrow(/CHECK/);
    await expect(
      ins(db, "sentinel_poll_day", { ...ROW.sentinel_poll_day, d: "2026-1-1" }),
    ).rejects.toThrow(/CHECK/);
    await expect(
      ins(db, "sentinel_poll_day", { ...ROW.sentinel_poll_day, source: "" }),
    ).rejects.toThrow(/CHECK/);
  });
});

describe("main migration 0009_sentinel_email: sentinel_ingest (retry, then ok is final)", () => {
  it("an error retries with a higher attempt and corrected counts, then ok; ok is final", async () => {
    const db = await freshDb("main");
    await ins(db, "sentinel_ingest", {
      ...ROW.sentinel_ingest,
      items_seen: 0,
      items_new: 0,
      assessed: 0,
      carried: 0,
      status: "timeout",
    });
    await run(
      db,
      "UPDATE sentinel_ingest SET attempt = 2, status = 'partial', items_seen = 50, items_new = 45, assessed = 40, carried = 5",
    );
    await run(db, "UPDATE sentinel_ingest SET assessed = 45, carried = 0, status = 'ok'");
    for (const set of ["status = 'error'", "assessed = 45", "attempt = 3"]) {
      await expect(run(db, `UPDATE sentinel_ingest SET ${set}`), set).rejects.toThrow(
        /ok is final/,
      );
    }
  });

  it("once partial, the seen/new counts, the attempt and the assessed count never go back", async () => {
    const db = await freshDb("main");
    await ins(db, "sentinel_ingest", { ...ROW.sentinel_ingest, attempt: 2 });
    await expect(run(db, "UPDATE sentinel_ingest SET items_new = 44")).rejects.toThrow(
      /ok is final/,
    );
    await expect(run(db, "UPDATE sentinel_ingest SET items_seen = 51")).rejects.toThrow(
      /ok is final/,
    );
    await expect(run(db, "UPDATE sentinel_ingest SET attempt = 1")).rejects.toThrow(/ok is final/);
    await expect(run(db, "UPDATE sentinel_ingest SET assessed = 39")).rejects.toThrow(
      /ok is final/,
    );
    await expect(run(db, "UPDATE sentinel_ingest SET received_at = ?", [OLD_AT])).rejects.toThrow(
      /ok is final/,
    );
    await run(db, "UPDATE sentinel_ingest SET assessed = 45, carried = 0");
  });

  it("CHECKs: id prefix, new <= seen, assessed <= new, attempt 1..3, status enum", async () => {
    const db = await freshDb("main");
    const r = ROW.sentinel_ingest;
    await expect(ins(db, "sentinel_ingest", { ...r, id: "x" })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "sentinel_ingest", { ...r, items_new: 51 })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "sentinel_ingest", { ...r, assessed: 46 })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "sentinel_ingest", { ...r, attempt: 4 })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "sentinel_ingest", { ...r, status: "done" })).rejects.toThrow(/CHECK/);
  });
});

describe("main migration 0009_sentinel_email: item_assessment (LLM fields NULL -> value once)", () => {
  it("needs its announcement", async () => {
    const db = await freshDb("main");
    await expect(ins(db, "item_assessment", ROW.item_assessment)).rejects.toThrow(
      /needs its announcement/,
    );
  });

  it("materiality_llm and text_llm go NULL to a value once; the same value again is fine; nothing else changes", async () => {
    const db = await seeded();
    await run(db, "UPDATE item_assessment SET materiality_llm = 3, text_llm = 'a note'");
    await run(db, "UPDATE item_assessment SET materiality_llm = 3");
    for (const set of [
      "materiality_llm = 1",
      "materiality_llm = NULL",
      "text_llm = 'other'",
      "materiality = 3",
      "polarity = 1",
      "held = 1",
      "watch = 0",
      "candidate = 0",
      "tracked = 0",
      "code = 'ZZBB'",
      "market = 'US'",
      "source = 'x'",
      "ann_id = 'A2'",
      "rule_version = 'v2'",
      "assessed_at = '2026-01-01T00:00:00.000Z'",
    ]) {
      await expect(run(db, `UPDATE item_assessment SET ${set}`), set).rejects.toThrow(
        /only materiality_llm and text_llm|CHECK/,
      );
    }
  });

  it("CHECKs: materiality 0..3, held implies tracked, watch implies candidate, LLM within +-1", async () => {
    const db = await seeded();
    await ins(db, "announcement", {
      market: "AU",
      code: "ZZBB",
      ann_id: "A2",
      published_at: AT,
      ingested_at: AT,
      type: null,
      price_sensitive: 0,
      title: "x",
      url: null,
      source: "asx_announcements",
    });
    const r = { ...ROW.item_assessment, ann_id: "A2" };
    await expect(ins(db, "item_assessment", { ...r, materiality: 4 })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "item_assessment", { ...r, polarity: 2 })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "item_assessment", { ...r, held: 1, tracked: 0 })).rejects.toThrow(
      /CHECK/,
    );
    await expect(ins(db, "item_assessment", { ...r, watch: 1, candidate: 0 })).rejects.toThrow(
      /CHECK/,
    );
    await expect(ins(db, "item_assessment", { ...r, materiality_llm: 0 })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "item_assessment", { ...r, text_llm: "" })).rejects.toThrow(/CHECK/);
    await ins(db, "item_assessment", { ...r, materiality_llm: 3, held: 1 });
  });
});

describe("main migration 0009_sentinel_email: watch_list_owner", () => {
  it("removed_at goes NULL to a value once; nothing else changes; rows are never deleted", async () => {
    const db = await seeded();
    await run(db, "UPDATE watch_list_owner SET removed_at = ?", [AT]);
    await run(db, "UPDATE watch_list_owner SET removed_at = ?", [AT]);
    for (const set of [
      "removed_at = '2030-01-01T00:00:00.000Z'",
      "removed_at = NULL",
      "expires_d = '2026-11-01'",
      "code = 'ZZBB'",
      "added_by = 2",
      "added_at = '2026-10-18T01:00:00.000Z'",
      "market = 'US'",
      "id = 'x'",
    ]) {
      await expect(run(db, `UPDATE watch_list_owner SET ${set}`), set).rejects.toThrow(
        /only removed_at/,
      );
    }
    await expect(run(db, "DELETE FROM watch_list_owner")).rejects.toThrow(/forever table/);
  });

  it("the expiry is at most 90 days (91 from the UTC date, one day of Melbourne slack) and not before the add", async () => {
    const db = await freshDb("main");
    const r = ROW.watch_list_owner;
    await ins(db, "watch_list_owner", { ...r, id: "a", expires_d: "2027-01-17" }); // 2026-10-19 + 90
    await ins(db, "watch_list_owner", { ...r, id: "b", expires_d: "2027-01-18" }); // + 91, slack
    await expect(
      ins(db, "watch_list_owner", { ...r, id: "c", expires_d: "2027-01-19" }),
    ).rejects.toThrow(/CHECK/);
    await expect(
      ins(db, "watch_list_owner", { ...r, id: "d", expires_d: "2026-10-18" }),
    ).rejects.toThrow(/CHECK/);
    await expect(ins(db, "watch_list_owner", { ...r, id: "e", added_by: 0 })).rejects.toThrow(
      /CHECK/,
    );
    await expect(ins(db, "watch_list_owner", { ...r, id: "f", code: "" })).rejects.toThrow(/CHECK/);
  });
});

describe("main migration 0009_sentinel_email: alert", () => {
  it("email_key and text_llm go NULL to a value once; every other column is frozen", async () => {
    const db = await seeded();
    await run(
      db,
      "UPDATE alert SET email_key = 'p0:ann:AU:asx_announcements:A1', text_llm = 'note'",
    );
    await run(db, "UPDATE alert SET email_key = 'p0:ann:AU:asx_announcements:A1'");
    for (const set of [
      "email_key = 'p0b:x'",
      "email_key = NULL",
      "text_llm = 'other'",
      "tier = 'P1'",
      "kind = 'halt'",
      "code = 'ZZBB'",
      "execution_id = NULL",
      "weight_ppm = 1",
      "materiality = 2",
      "published_at = NULL",
      "detected_at = '2026-01-01T00:00:00.000Z'",
      "facts_json = '[]'",
      "market = 'US'",
      "alert_key = 'x'",
    ]) {
      await expect(run(db, `UPDATE alert SET ${set}`), set).rejects.toThrow(
        /only email_key and text_llm/,
      );
    }
  });

  it("only a live execution E can raise an alert (never a control, never an unknown execution)", async () => {
    const db = await freshDb("main");
    await seedParents(db);
    const r = { ...ROW.alert };
    await expect(ins(db, "alert", { ...r, execution_id: "C1" })).rejects.toThrow(
      /only a live execution E/,
    );
    await expect(ins(db, "alert", { ...r, execution_id: "nope" })).rejects.toThrow(
      /only a live execution E/,
    );
    await ins(db, "alert", { ...r, execution_id: null });
    await ins(db, "alert", { ...r, alert_key: "k2", execution_id: "E01" });
  });

  it("CHECKs: tier and kind enums, materiality, weight, JSON, empty key/text", async () => {
    const db = await freshDb("main");
    await seedParents(db);
    const r = ROW.alert;
    await expect(ins(db, "alert", { ...r, tier: "P3" })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "alert", { ...r, kind: "news" })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "alert", { ...r, materiality: 4 })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "alert", { ...r, weight_ppm: -1 })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "alert", { ...r, facts_json: "{bad" })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "alert", { ...r, alert_key: "" })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "alert", { ...r, email_key: "" })).rejects.toThrow(/CHECK/);
    for (const kind of ALERT_KINDS) {
      await ins(db, "alert", {
        ...r,
        alert_key: `k:${kind}`,
        kind,
        code: null,
        execution_id: null,
      });
    }
  });
});

describe("main migration 0009_sentinel_email: thesis_breaker_eval", () => {
  it("needs its card; a second intraday evaluation of the same breaker and day is a new row (seq)", async () => {
    const db = await freshDb("main");
    await seedParents(db);
    await expect(
      ins(db, "thesis_breaker_eval", { ...ROW.thesis_breaker_eval, card_id: "nope" }),
    ).rejects.toThrow(/needs its decision card/);
    const r = { ...ROW.thesis_breaker_eval, phase: "intraday" };
    await ins(db, "thesis_breaker_eval", r);
    await expect(ins(db, "thesis_breaker_eval", r)).rejects.toThrow(/UNIQUE|PRIMARY KEY/);
    await ins(db, "thesis_breaker_eval", { ...r, seq: 2, status: "red", trigger_ref: "A1" });
    // The writer convention leaves the first row alone.
    await run(
      db,
      `INSERT INTO thesis_breaker_eval (subject_id, breaker_id, d, phase, seq, subject_kind, card_id,
         market, code, status, value_text, trigger_text, rule_version)
       VALUES ('T1','TB-NEG','2026-10-12','intraday',1,'trade','card1','AU','ZZAA','red','v','t','r')
       ON CONFLICT DO NOTHING`,
    );
    expect((await q(db, "SELECT status FROM thesis_breaker_eval WHERE seq = 1"))[0].status).toBe(
      "green",
    );
  });

  it("CHECKs: phase, status, subject kind, empty ids", async () => {
    const db = await freshDb("main");
    await seedParents(db);
    const r = ROW.thesis_breaker_eval;
    await expect(ins(db, "thesis_breaker_eval", { ...r, phase: "weekly" })).rejects.toThrow(
      /CHECK/,
    );
    await expect(ins(db, "thesis_breaker_eval", { ...r, status: "blue" })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "thesis_breaker_eval", { ...r, subject_kind: "cohort" })).rejects.toThrow(
      /CHECK/,
    );
    await expect(ins(db, "thesis_breaker_eval", { ...r, subject_id: "" })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "thesis_breaker_eval", { ...r, seq: 0 })).rejects.toThrow(/CHECK/);
    for (const phase of BREAKER_PHASES) {
      await ins(db, "thesis_breaker_eval", { ...r, phase });
    }
  });
});

describe("main migration 0009_sentinel_email: preopen_run", () => {
  it("attempt 1 error -> attempt 2 ok; ok, not_run and a second error are final", async () => {
    const db = await seeded();
    await run(
      db,
      "UPDATE preopen_run SET attempt = 2, started_at = '2026-10-12T22:58:00.000Z', status = 'ok', finished_at = '2026-10-12T22:58:09.000Z', checked = 3, cancelled = 1",
    );
    for (const set of ["status = 'error'", "attempt = 1", "checked = 9", "finished_at = NULL"]) {
      await expect(run(db, `UPDATE preopen_run SET ${set}`), set).rejects.toThrow(/one retry/);
    }
    await expect(run(db, "DELETE FROM preopen_run")).rejects.toThrow(/forever table/);
  });

  it("a second error is final; a not_run row never becomes ok", async () => {
    const db = await seeded();
    await run(db, "UPDATE preopen_run SET attempt = 2, status = 'error'");
    await expect(
      run(db, "UPDATE preopen_run SET status = 'ok', finished_at = ?", [AT]),
    ).rejects.toThrow(/one retry/);
    await ins(db, "preopen_run", {
      ...ROW.preopen_run,
      d: "2026-10-14",
      status: "not_run",
      attempt: 1,
    });
    await expect(
      run(
        db,
        "UPDATE preopen_run SET status = 'ok', attempt = 2, finished_at = ? WHERE d = '2026-10-14'",
        [AT],
      ),
    ).rejects.toThrow(/one retry/);
  });

  it("the finish time fills once when the status stays the same", async () => {
    const db = await freshDb("main");
    await ins(db, "preopen_run", { ...ROW.preopen_run, status: "not_run" });
    await run(db, "UPDATE preopen_run SET finished_at = ?", [AT]);
    await expect(
      run(db, "UPDATE preopen_run SET finished_at = ?", ["2026-10-13T00:00:00.000Z"]),
    ).rejects.toThrow(/one retry/);
  });

  it("CHECKs: ok needs a finish time, attempt 1 or 2, cancelled <= checked", async () => {
    const db = await freshDb("main");
    const r = ROW.preopen_run;
    await expect(ins(db, "preopen_run", { ...r, status: "ok" })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "preopen_run", { ...r, attempt: 3 })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "preopen_run", { ...r, checked: 1, cancelled: 2 })).rejects.toThrow(
      /CHECK/,
    );
    await expect(ins(db, "preopen_run", { ...r, status: "late" })).rejects.toThrow(/CHECK/);
  });
});

describe("main migration 0009_sentinel_email: preopen_result", () => {
  it("needs its order; a cancel needs the order cancelled first (one transaction in the route)", async () => {
    const db = await freshDb("main");
    await seedParents(db);
    await expect(
      ins(db, "preopen_result", { ...ROW.preopen_result, order_id: "nope" }),
    ).rejects.toThrow(/needs its order/);
    const cancel = { ...ROW.preopen_result, outcome: "cancel", reason: "halt" };
    await expect(ins(db, "preopen_result", cancel)).rejects.toThrow(
      /a cancel needs the order cancelled/,
    );
    await run(db, "UPDATE arena_order SET status = 'cancelled' WHERE id = 'O1'");
    await ins(db, "preopen_result", cancel);
  });

  it("the reason is required for a cancel and only for a cancel, from the known forms", async () => {
    const db = await freshDb("main");
    await seedParents(db);
    await run(db, "UPDATE arena_order SET status = 'cancelled' WHERE id = 'O1'");
    const r = ROW.preopen_result;
    await expect(ins(db, "preopen_result", { ...r, outcome: "cancel" })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "preopen_result", { ...r, reason: "halt" })).rejects.toThrow(/CHECK/);
    await expect(
      ins(db, "preopen_result", { ...r, outcome: "cancel", reason: "bad" }),
    ).rejects.toThrow(/CHECK/);
    await expect(
      ins(db, "preopen_result", { ...r, outcome: "cancel", reason: "filter:" }),
    ).rejects.toThrow(/CHECK/);
    await expect(ins(db, "preopen_result", { ...r, outcome: "maybe" })).rejects.toThrow(/CHECK/);
    const reasons = ["halt", "filter:ARN-011-asx-query", "tb:TB-HALT", "possible_halt_feed_off"];
    for (const [i, reason] of reasons.entries()) {
      await ins(db, "arena_order", {
        id: `OC${i}`,
        cohort_id: "K1",
        decided_d: "2026-10-12",
        code: `ZZC${i}`,
        side: "buy",
        kind: "entry",
        qty: 10,
      });
      await run(db, "UPDATE arena_order SET status = 'cancelled' WHERE id = ?", [`OC${i}`]);
      await ins(db, "preopen_result", { ...r, order_id: `OC${i}`, outcome: "cancel", reason });
    }
    expect((await q(db, "SELECT COUNT(*) AS n FROM preopen_result"))[0].n).toBe(4);
  });
});

describe("main migration 0009_sentinel_email: evening_review and review_read", () => {
  it("versions of one date coexist; a partial review must list what is missing", async () => {
    const db = await seeded();
    await ins(db, "evening_review", { ...ROW.evening_review, version: 2, kind: "minimal" });
    const r = ROW.evening_review;
    await expect(ins(db, "evening_review", { ...r, version: 3, kind: "partial" })).rejects.toThrow(
      /CHECK/,
    );
    await ins(db, "evening_review", {
      ...r,
      version: 3,
      kind: "partial",
      missing_json: '[{"n":2,"name":"Orders"}]',
    });
  });

  it("CHECKs: kind, narrative, sha, JSON, version, size", async () => {
    const db = await freshDb("main");
    const r = ROW.evening_review;
    await expect(ins(db, "evening_review", { ...r, kind: "short" })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "evening_review", { ...r, narrative: "gpt" })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "evening_review", { ...r, facts_sha: "xyz" })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "evening_review", { ...r, facts_sha: "A".repeat(64) })).rejects.toThrow(
      /CHECK/,
    );
    await expect(ins(db, "evening_review", { ...r, facts_json: "{bad" })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "evening_review", { ...r, missing_json: "nope" })).rejects.toThrow(
      /CHECK/,
    );
    await expect(ins(db, "evening_review", { ...r, version: 0 })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "evening_review", { ...r, size_html: -1 })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "evening_review", { ...r, d: "12/10/2026" })).rejects.toThrow(/CHECK/);
  });

  it("review_read: via enum and date format", async () => {
    const db = await freshDb("main");
    await expect(ins(db, "review_read", { ...ROW.review_read, via: "api" })).rejects.toThrow(
      /CHECK/,
    );
    await expect(ins(db, "review_read", { ...ROW.review_read, d: "x" })).rejects.toThrow(/CHECK/);
  });
});

describe("main migration 0009_sentinel_email: email_message and email_attempt", () => {
  it("a claimed row fills its details then moves once to a terminal status; terminal rows are frozen", async () => {
    const db = await seeded();
    await run(
      db,
      "UPDATE email_message SET subject = 'Praxis Evening Review', size_html = 100, size_text = 50, attempts = 1, recipient_sha = ?, ref_json = '{\"a\":1}'",
      [HEX64],
    );
    await run(db, "UPDATE email_message SET attempts = 2, provider_id = 'mock-1'");
    await run(db, "UPDATE email_message SET status = 'sent', sent_at = ?", [AT]);
    for (const set of [
      "status = 'failed'",
      "subject = 'again'",
      "attempts = 3",
      "sent_at = NULL",
      "provider_id = 'x'",
    ]) {
      await expect(run(db, `UPDATE email_message SET ${set}`), set).rejects.toThrow(
        /moves once to a terminal status/,
      );
    }
  });

  it("every terminal status is reachable from claimed and frozen after", async () => {
    const db = await freshDb("main");
    const terminal = [
      "failed",
      "suppressed_cap",
      "suppressed_off",
      "suppressed_paused",
      "no_recipient",
    ];
    for (const [i, status] of terminal.entries()) {
      await ins(db, "email_message", { ...ROW.email_message, email_key: `k${i}` });
      await run(db, "UPDATE email_message SET status = ? WHERE email_key = ?", [status, `k${i}`]);
      await expect(
        run(db, "UPDATE email_message SET status = 'claimed' WHERE email_key = ?", [`k${i}`]),
      ).rejects.toThrow(/moves once/);
    }
  });

  it("a claimed row keeps its key, env, kind, date, slot, creation time; attempts and recipient hash never go back", async () => {
    const db = await seeded();
    await run(db, "UPDATE email_message SET attempts = 2, recipient_sha = ?", [HEX64]);
    for (const set of [
      "email_key = 'x'",
      "env = 'staging'",
      "kind = 'test'",
      "d = '2026-10-13'",
      "slot = 'pool'",
      "created_at = '2020-01-01T00:00:00.000Z'",
      "attempts = 1",
      "recipient_sha = NULL",
    ]) {
      await expect(run(db, `UPDATE email_message SET ${set}`), set).rejects.toThrow(
        /moves once to a terminal status/,
      );
    }
  });

  it("CHECKs: sent needs sent_at; reserved slots belong to their kind; P0 uses only the p0 slot", async () => {
    const db = await freshDb("main");
    const r = ROW.email_message;
    await expect(ins(db, "email_message", { ...r, status: "sent" })).rejects.toThrow(/CHECK/);
    await ins(db, "email_message", { ...r, email_key: "s1", status: "sent", sent_at: AT });
    await expect(
      ins(db, "email_message", { ...r, email_key: "a", kind: "brief", slot: "reserved_review" }),
    ).rejects.toThrow(/CHECK/);
    await expect(
      ins(db, "email_message", { ...r, email_key: "b", kind: "review", slot: "reserved_reminder" }),
    ).rejects.toThrow(/CHECK/);
    await expect(
      ins(db, "email_message", { ...r, email_key: "c", kind: "tokens", slot: "reserved_incident" }),
    ).rejects.toThrow(/CHECK/);
    // P0 never uses a reserved slot and the p0 slot is only for P0 kinds.
    await expect(
      ins(db, "email_message", { ...r, email_key: "d", kind: "p0", slot: "reserved_review" }),
    ).rejects.toThrow(/CHECK/);
    await expect(
      ins(db, "email_message", { ...r, email_key: "e", kind: "p0", slot: "pool" }),
    ).rejects.toThrow(/CHECK/);
    await expect(
      ins(db, "email_message", { ...r, email_key: "f", kind: "test", slot: "p0" }),
    ).rejects.toThrow(/CHECK/);
    await ins(db, "email_message", { ...r, email_key: "g", kind: "p0", slot: "p0" });
    await ins(db, "email_message", { ...r, email_key: "h", kind: "p0_batch", slot: "p0" });
    await ins(db, "email_message", {
      ...r,
      email_key: "i",
      kind: "incident_s1",
      slot: "reserved_incident",
    });
    await ins(db, "email_message", {
      ...r,
      email_key: "j",
      kind: "reminder",
      slot: "reserved_reminder",
    });
    // The kinds and slots lists mirror the CHECKs: every listed value inserts in a valid pairing.
    expect(EMAIL_KINDS).toHaveLength(16);
    expect(EMAIL_SLOTS).toHaveLength(5);
  });

  it("CHECKs: env, status, attempts 0..3, recipient hash is 64 lower-case hex (never an address)", async () => {
    const db = await freshDb("main");
    const r = ROW.email_message;
    await expect(ins(db, "email_message", { ...r, env: "prod" })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "email_message", { ...r, status: "queued" })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "email_message", { ...r, attempts: 4 })).rejects.toThrow(/CHECK/);
    await expect(
      ins(db, "email_message", { ...r, recipient_sha: "owner@example.com" }),
    ).rejects.toThrow(/CHECK/);
    await expect(ins(db, "email_message", { ...r, ref_json: "{bad" })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "email_message", { ...r, email_key: "" })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "email_message", { ...r, size_html: -1 })).rejects.toThrow(/CHECK/);
  });

  it("the claim is a conditional insert: a second insert of the key adds nothing", async () => {
    const db = await seeded();
    const res = await run(
      db,
      `INSERT INTO email_message (email_key, env, kind, d, slot, status, created_at)
       VALUES ('review:2026-10-12','test','review','2026-10-12','reserved_review','claimed',?) ON CONFLICT DO NOTHING`,
      [AT],
    );
    expect(res.rowsAffected).toBe(0);
  });

  it("email_attempt needs its message; n is 1..3; a provider id only with accepted", async () => {
    const db = await freshDb("main");
    await expect(ins(db, "email_attempt", ROW.email_attempt)).rejects.toThrow(
      /needs its email_message/,
    );
    await ins(db, "email_message", ROW.email_message);
    const a = ROW.email_attempt;
    await expect(ins(db, "email_attempt", { ...a, n: 4 })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "email_attempt", { ...a, n: 2, outcome: "timeout" })).rejects.toThrow(
      /CHECK/,
    ); // provider_id set
    await expect(
      ins(db, "email_attempt", { ...a, n: 2, outcome: "bad", provider_id: null }),
    ).rejects.toThrow(/CHECK/);
    await expect(
      ins(db, "email_attempt", {
        ...a,
        n: 2,
        http_status: 99,
        provider_id: null,
        outcome: "retryable",
      }),
    ).rejects.toThrow(/CHECK/);
    await ins(db, "email_attempt", {
      ...a,
      n: 2,
      outcome: "retryable",
      http_status: 429,
      provider_id: null,
    });
    await ins(db, "email_attempt", {
      ...a,
      n: 3,
      outcome: "network",
      http_status: null,
      provider_id: null,
    });
  });
});

describe("main migration 0009_sentinel_email: health_snapshot, attention_snooze, credential_expiry", () => {
  it("health_snapshot: purpose enum and JSON", async () => {
    const db = await freshDb("main");
    await expect(
      ins(db, "health_snapshot", { ...ROW.health_snapshot, purpose: "x" }),
    ).rejects.toThrow(/CHECK/);
    await expect(
      ins(db, "health_snapshot", { ...ROW.health_snapshot, components_json: "{bad" }),
    ).rejects.toThrow(/CHECK/);
    await ins(db, "health_snapshot", { ...ROW.health_snapshot, purpose: "review" });
  });

  it("attention_snooze: nine components, until after from, at most 14 days, ids unique", async () => {
    const db = await freshDb("main");
    const r = ROW.attention_snooze;
    expect(HEALTH_COMPONENTS).toHaveLength(9);
    for (const [i, component] of HEALTH_COMPONENTS.entries()) {
      await ins(db, "attention_snooze", { ...r, id: `s${i}`, component });
    }
    await expect(
      ins(db, "attention_snooze", { ...r, id: "b1", component: "email" }),
    ).rejects.toThrow(/CHECK/);
    await expect(
      ins(db, "attention_snooze", { ...r, id: "b2", until_d: "2026-10-19" }),
    ).rejects.toThrow(/CHECK/);
    await expect(
      ins(db, "attention_snooze", { ...r, id: "b3", until_d: "2026-10-18" }),
    ).rejects.toThrow(/CHECK/);
    await ins(db, "attention_snooze", { ...r, id: "ok14", until_d: "2026-11-02" });
    await expect(
      ins(db, "attention_snooze", { ...r, id: "b4", until_d: "2026-11-03" }),
    ).rejects.toThrow(/CHECK/);
    await expect(ins(db, "attention_snooze", { ...r, id: "b5", created_by: 0 })).rejects.toThrow(
      /CHECK/,
    );
    await expect(ins(db, "attention_snooze", { ...r, id: "b6", item_key: "" })).rejects.toThrow(
      /CHECK/,
    );
  });

  it("credential_expiry: every insert and change is logged in the history; the name is fixed; set_at only moves forward", async () => {
    const db = await freshDb("main");
    await ins(db, "credential_expiry", ROW.credential_expiry);
    await run(
      db,
      "UPDATE credential_expiry SET expires_on = '2027-02-28', set_at = ?, set_by = 1",
      ["2026-10-20T00:00:00.000Z"],
    );
    expect(
      await q(
        db,
        "SELECT name, op, expires_on, changed_at FROM credential_expiry_history ORDER BY id",
      ),
    ).toEqual([
      { name: "d_turso_main_tokens", op: "insert", expires_on: "2027-01-31", changed_at: AT },
      {
        name: "d_turso_main_tokens",
        op: "update",
        expires_on: "2027-02-28",
        changed_at: "2026-10-20T00:00:00.000Z",
      },
    ]);
    await expect(run(db, "UPDATE credential_expiry SET name = 'x'")).rejects.toThrow(
      /name is fixed/,
    );
    await expect(run(db, "UPDATE credential_expiry SET set_at = ?", [AT])).rejects.toThrow(
      /name is fixed/,
    );
    await expect(run(db, "DELETE FROM credential_expiry")).rejects.toThrow(/forever table/);
    await expect(run(db, "DELETE FROM credential_expiry_history")).rejects.toThrow(/append-only/);
  });

  it("credential_expiry CHECKs: a name is lower-case ids only (never a value); the date format; every SEC-017 name fits", async () => {
    const db = await freshDb("main");
    const r = ROW.credential_expiry;
    await expect(ins(db, "credential_expiry", { ...r, name: "" })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "credential_expiry", { ...r, name: "Has-Upper" })).rejects.toThrow(
      /CHECK/,
    );
    await expect(ins(db, "credential_expiry", { ...r, name: "a b" })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "credential_expiry", { ...r, expires_on: "31/01/2027" })).rejects.toThrow(
      /CHECK/,
    );
    await expect(ins(db, "credential_expiry", { ...r, set_by: 0 })).rejects.toThrow(/CHECK/);
    for (const name of CREDENTIAL_NAME_LIST) await ins(db, "credential_expiry", { ...r, name });
    expect(CREDENTIAL_NAME_LIST).toHaveLength(17);
  });
});

describe("main migration 0009_sentinel_email: up / down / up and backup", () => {
  it("down removes every table, trigger and index of 0009 and touches nothing else; up restores an identical schema", async () => {
    const db = await freshDb("main");
    const ms = await loadMigrations(MIGRATIONS("main"));
    const full = await schemaOf(db);
    await migrateDown(db, ms, 11); // 0019, 0018 (m14), 0017 (first_ingested_at), 0016 (known_at), 0015 (vendor actions), 0014 (pick checks), 0013 (calendar history), 0012 (golive), 0011 (ui) and 0010 (learning) sit on top: take the schema as of 0009
    const before = await schemaOf(db);
    expect(await migrateDown(db, ms, 1)).toEqual({ rolledBack: 1, version: 8 });
    const mid = await schemaOf(db);
    for (const t of TABLES) {
      expect(
        mid.some((s) => s.startsWith(`table:${t}:`)),
        t,
      ).toBe(false);
    }
    const names = new Set<string>(TABLES);
    const rest = before.filter((s) => {
      const [type, name] = s.split(":");
      if (type === "table") return !names.has(name);
      return !/^(idx_(sentinel_ingest|item_assessment|watch_list_owner|alert|thesis_breaker_eval|preopen_result|email_message|attention_snooze|credential_expiry_history)|(sentinel_poll_day|sentinel_ingest|item_assessment|watch_list_owner|alert|thesis_breaker_eval|preopen_run|preopen_result|evening_review|review_read|email_message|email_attempt|health_snapshot|attention_snooze|credential_expiry|credential_expiry_history)_)/.test(
        name,
      );
    });
    expect(mid).toEqual(rest);
    expect(await migrateUp(db, ms)).toEqual({ applied: 12, version: 20 }); // 0009, then 0010
    expect(await schemaOf(db)).toEqual(full);
    expect(await migrateUp(db, ms)).toEqual({ applied: 0, version: 20 });
  });

  it("dump and restore round-trip rows, triggers and the history log (no double log)", async () => {
    const source = await seeded();
    const d = await dumpDatabase(source, { name: "main", createdAt: AT });
    const target = track(createClient({ url: tempDbUrl() }));
    await restoreDatabase(target, d.text);
    for (const t of TABLES) {
      expect(await q(target, `SELECT * FROM ${t}`), t).toEqual(
        await q(source, `SELECT * FROM ${t}`),
      );
    }
    expect(await schemaOf(target)).toEqual(await schemaOf(source));
    await expect(run(target, "UPDATE alert SET tier = 'P2'")).rejects.toThrow(/only email_key/);
    await expect(run(target, "UPDATE evening_review SET html = 'z'")).rejects.toThrow(
      /append-only/,
    );
    const ms = await loadMigrations(MIGRATIONS("main"));
    expect(await migrateUp(target, ms)).toEqual({ applied: 0, version: 20 });
  });

  it("the backup meta line lists the forever tables and not the pruned ones", async () => {
    const source = await seeded();
    const d = await dumpDatabase(source, { name: "main", createdAt: AT });
    const meta = JSON.parse(d.text.split("\n")[0]);
    for (const t of SENTINEL_FOREVER_TABLES) expect(meta.forever, t).toContain(t);
    for (const t of Object.keys(SENTINEL_PRUNED_TABLES)) expect(meta.forever, t).not.toContain(t);
  });
});
