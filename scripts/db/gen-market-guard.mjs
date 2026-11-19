// Generates db/migrations/main/0038_m19_market_guard.sql (M19 A2; D-1810). The write guard is two triggers on
// every table that has a `market` column: a row of a market that is not enabled is refused with the text
// `MarketNotEnabled <table>` (src/lib/market/guard.mjs maps it to the typed error).
// The table list is derived by applying migrations 0001..0037 to a scratch database and reading the schema
// (the same derivation as src/lib/maintenance/rowsByMarket.ts), never kept by hand. Usage:
//   node scripts/db/gen-market-guard.mjs           writes the file
//   node scripts/db/gen-market-guard.mjs --check   exits 1 when the committed file differs from the schema
// A migration that has been applied in production is never regenerated. A later migration that adds a table with
// a `market` column adds its own two triggers (tests/db/0038_m19_market_guard.test.ts fails until it does).
import { createClient } from "@libsql/client";
import { writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMigrations, migrateUp } from "../../src/lib/db/migrate-core.mjs";
import { applyRegion } from "./regions.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIR = join(root, "db", "migrations", "main");
export const MIGRATION_PATH = join(DIR, "0038_m19_market_guard.sql");
/** M20 (D-1122): the guard triggers of the tables 0039 creates sit in a generated region of that migration. */
export const M20_MIGRATION_PATH = join(DIR, "0039_m20_markets_data.sql");
export const M20_REGION = "guard triggers";
/**
 * The market-keyed tables migration 0039 creates, each with its two guard triggers (D-1810, D-1820). The list is
 * written here (the migration's own table list) and verified against the live schema: `m20Tables()` derives the
 * tables with a `market` column that exist after 0039 and not after 0038, and `--check` fails on any difference.
 */
export const M20_TABLES = [
  "announcement_category",
  "bar_latency_sample",
  "fundamental_fact",
  "holdout_look",
  "label_item",
  "market_switch",
  "price_band",
  "surveillance_list",
  "trading_halt",
];
/** M21 (D-1236): the guard triggers of the tables 0041 creates sit in a generated region of that migration. */
export const M21_MIGRATION_PATH = join(DIR, "0041_m21_owner_tools.sql");
export const M21_REGION = "guard triggers";
/**
 * The market-keyed tables migration 0041 creates (owner_trade_void has no market column and is not guarded).
 * Verified against the live schema by `m21Tables()`; `--check` fails on any difference.
 */
export const M21_TABLES = [
  "golden_label",
  "owner_holding",
  "owner_trade",
  "short_shadow_decision",
  "short_shadow_outcome",
];
/** M22 (D-1444): the guard triggers of the tables 0042 creates sit in a generated region of that migration. */
export const M22_MIGRATION_PATH = join(DIR, "0042_m22_llm_experts.sql");
export const M22_REGION = "guard triggers";
/**
 * The market-keyed tables migration 0042 creates (the other five of its thirteen have no market column: the
 * licence, poll, confirm, cluster-expression and alt-input tables are global or point at a guarded row).
 * Verified against the live schema by `m22Tables()`; `--check` fails on any difference.
 */
export const M22_TABLES = [
  "committee_call",
  "committee_prereg",
  "committee_rating",
  "committee_trial_result",
  "expert_call_proposal",
  "minilm_shadow",
  "opinion_promotion_request",
  "regime_alt_reading",
];
/** M23 (D-1611): the guard triggers of the tables 0043 creates sit in a generated region of that migration. */
export const M23_MIGRATION_PATH = join(DIR, "0043_m23_research.sql");
export const M23_REGION = "guard triggers";
/** The market-keyed tables migration 0043 creates (all eight). Verified against the live schema by `m23Tables()`. */
export const M23_TABLES = [
  "angle_proposal",
  "holdout_look_refusal",
  "research_meter",
  "research_prereg",
  "research_result",
  "residual_monitor",
  "sector_index",
  "shock_stop_outcome",
];
/** The schema the guard is generated against: everything up to the profile migration. */
export const GUARD_BASE_VERSION = 37;
/** The invariant's own table must be able to record a planted row (D-1810); it is never guarded. */
export const UNGUARDED = ["market_row_count"];
/**
 * Tables whose `market` column also holds a scope that is not a market: `document.market` is "common" for the
 * source register and the expert mirror (src/lib/kb/render.ts, src/lib/experts/kbDocs.ts), which belong to no market.
 * The guard lets that value through and the nightly invariant does not count it (D-1822).
 */
export const COMMON_SCOPE = { document: "common" };
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Every table with a `market` column in the schema after `GUARD_BASE_VERSION`, minus UNGUARDED, sorted. */
export async function guardedTables() {
  const db = createClient({ url: ":memory:" });
  try {
    const all = await loadMigrations(DIR);
    await migrateUp(
      db,
      all.filter((m) => m.version <= GUARD_BASE_VERSION),
    );
    const r = await db.execute(
      `SELECT m.name AS tbl
       FROM sqlite_master m JOIN pragma_table_info(m.name) c ON c.name = 'market'
       WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name`,
    );
    const names = r.rows.map((x) => String(x.tbl)).filter((n) => !UNGUARDED.includes(n));
    for (const n of names) if (!IDENT.test(n)) throw new Error(`table name not allowed: ${n}`);
    return names;
  } finally {
    db.close();
  }
}

/** Tables with a `market` column after migration 0039 that were not there after 0038 (derived, sorted). */
export async function m20Tables() {
  const db = createClient({ url: ":memory:" });
  try {
    const all = await loadMigrations(DIR);
    const q = `SELECT m.name AS tbl FROM sqlite_master m JOIN pragma_table_info(m.name) c ON c.name = 'market'
       WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name`;
    await migrateUp(
      db,
      all.filter((m) => m.version <= 38),
    );
    const before = new Set((await db.execute(q)).rows.map((x) => String(x.tbl)));
    await migrateUp(
      db,
      all.filter((m) => m.version <= 39),
    );
    return (await db.execute(q)).rows.map((x) => String(x.tbl)).filter((n) => !before.has(n));
  } finally {
    db.close();
  }
}

/** Tables with a `market` column after migration 0041 that were not there after 0040 (derived, sorted). */
export async function m21Tables() {
  const db = createClient({ url: ":memory:" });
  try {
    const all = await loadMigrations(DIR);
    const q = `SELECT m.name AS tbl FROM sqlite_master m JOIN pragma_table_info(m.name) c ON c.name = 'market'
       WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name`;
    await migrateUp(
      db,
      all.filter((m) => m.version <= 40),
    );
    const before = new Set((await db.execute(q)).rows.map((x) => String(x.tbl)));
    await migrateUp(
      db,
      all.filter((m) => m.version <= 41),
    );
    return (await db.execute(q)).rows.map((x) => String(x.tbl)).filter((n) => !before.has(n));
  } finally {
    db.close();
  }
}

/** Tables with a `market` column after migration 0042 that were not there after 0041 (derived, sorted). */
export async function m22Tables() {
  const db = createClient({ url: ":memory:" });
  try {
    const all = await loadMigrations(DIR);
    const q = `SELECT m.name AS tbl FROM sqlite_master m JOIN pragma_table_info(m.name) c ON c.name = 'market'
       WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name`;
    await migrateUp(
      db,
      all.filter((m) => m.version <= 41),
    );
    const before = new Set((await db.execute(q)).rows.map((x) => String(x.tbl)));
    await migrateUp(
      db,
      all.filter((m) => m.version <= 42),
    );
    return (await db.execute(q)).rows.map((x) => String(x.tbl)).filter((n) => !before.has(n));
  } finally {
    db.close();
  }
}

/** Tables with a `market` column after migration 0043 that were not there after 0042 (derived, sorted). */
export async function m23Tables() {
  const db = createClient({ url: ":memory:" });
  try {
    const all = await loadMigrations(DIR);
    const q = `SELECT m.name AS tbl FROM sqlite_master m JOIN pragma_table_info(m.name) c ON c.name = 'market'
       WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name`;
    await migrateUp(
      db,
      all.filter((m) => m.version <= 42),
    );
    const before = new Set((await db.execute(q)).rows.map((x) => String(x.tbl)));
    await migrateUp(
      db,
      all.filter((m) => m.version <= 43),
    );
    return (await db.execute(q)).rows.map((x) => String(x.tbl)).filter((n) => !before.has(n));
  } finally {
    db.close();
  }
}

// The insert trigger: a NULL market belongs to no market (run_record, a run without a market) and passes; the
// NOT NULL columns refuse a NULL by their own constraint. The probe is one primary-key read of `market` (3 rows).
const common = (t) =>
  COMMON_SCOPE[t]
    ? `
  AND NEW.market <> '${COMMON_SCOPE[t]}'`
    : "";
const insBody = (t) => `CREATE TRIGGER ${t}_market_guard_ins BEFORE INSERT ON ${t}
WHEN NEW.market IS NOT NULL${common(t)}
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled ${t}');
END;`;
// The update trigger fires only when the market column is assigned a different value: rewriting the same value
// creates no row of another market.
const updBody = (t) => `CREATE TRIGGER ${t}_market_guard_upd BEFORE UPDATE OF market ON ${t}
WHEN NEW.market IS NOT NULL AND NEW.market IS NOT OLD.market${common(t)}
  AND NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)
BEGIN
  SELECT RAISE(ABORT, 'MarketNotEnabled ${t}');
END;`;

export async function renderMigration() {
  const tables = await guardedTables();
  const out = [];
  out.push(`-- +up
-- M19 A2 (docs/M19_design.md stream A2; D-1810, D-1017 to D-1019, D-1818 to D-1822). GENERATED by scripts/db/gen-market-guard.mjs from the
-- schema after migration ${String(GUARD_BASE_VERSION).padStart(4, "0")}; tests/db/0038_m19_market_guard.test.ts asserts the trigger set equals the tables
-- that have a \`market\` column. Do not edit by hand (before the first production apply: regenerate).
--
-- The write guard: no row of a market that is not enabled (market.enabled = 1) can be inserted into, or moved by
-- an UPDATE of the market column to, any of the ${tables.length} tables below. Two triggers per table, one primary-key probe of the
-- 3-row \`market\` table per inserted row. Not guarded: market_row_count (the nightly invariant must be able to record
-- a planted row), and the configuration tables keyed by \`code\` (market, market_profile*), which have no market column.
-- The refusal text is \`MarketNotEnabled <table>\`; the app maps it to the typed error (src/lib/market/guard.mjs).
`);
  for (const t of tables) out.push(`-- ${t}\n${insBody(t)}\n${updBody(t)}\n`);
  out.push("-- +down");
  for (const t of tables) {
    out.push(`DROP TRIGGER ${t}_market_guard_ins;`);
    out.push(`DROP TRIGGER ${t}_market_guard_upd;`);
  }
  out.push("");
  return out.join("\n");
}

/** The body of the generated region of 0039: the two triggers of each M20 table. */
export function renderM20Region(tables = M20_TABLES) {
  return tables.map((t) => `-- ${t}\n${insBody(t)}\n${updBody(t)}\n`).join("\n") + "\n";
}

/** The body of the generated region of 0041: the two triggers of each M21 table. */
export function renderM21Region(tables = M21_TABLES) {
  return renderM20Region(tables);
}

/** The body of the generated region of 0042: the two triggers of each M22 table. */
export function renderM22Region(tables = M22_TABLES) {
  return renderM20Region(tables);
}

/** The body of the generated region of 0043: the two triggers of each M23 table. */
export function renderM23Region(tables = M23_TABLES) {
  return renderM20Region(tables);
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invoked) {
  const text = await renderMigration();
  if (process.argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(MIGRATION_PATH, "utf8");
    } catch {
      /* missing file: differs */
    }
    if (current !== text) {
      console.error(
        "0038_m19_market_guard.sql differs from the schema: run node scripts/db/gen-market-guard.mjs",
      );
      process.exit(1);
    }
    console.log("0038_m19_market_guard.sql matches the schema");
    const derived = await m20Tables();
    if (JSON.stringify(derived) !== JSON.stringify([...M20_TABLES].sort())) {
      console.error(
        `0039 creates market-keyed tables ${derived.join(",")} but M20_TABLES lists ${M20_TABLES.join(",")}`,
      );
      process.exit(1);
    }
    if (!applyRegion(M20_MIGRATION_PATH, M20_REGION, renderM20Region(), true)) {
      console.error(
        "0039_m20_markets_data.sql guard region differs: run node scripts/db/gen-market-guard.mjs",
      );
      process.exit(1);
    }
    console.log("0039_m20_markets_data.sql guard region matches the table list and the schema");
    const derived21 = await m21Tables();
    if (JSON.stringify(derived21) !== JSON.stringify([...M21_TABLES].sort())) {
      console.error(
        `0041 creates market-keyed tables ${derived21.join(",")} but M21_TABLES lists ${M21_TABLES.join(",")}`,
      );
      process.exit(1);
    }
    if (!applyRegion(M21_MIGRATION_PATH, M21_REGION, renderM21Region(), true)) {
      console.error(
        "0041_m21_owner_tools.sql guard region differs: run node scripts/db/gen-market-guard.mjs",
      );
      process.exit(1);
    }
    console.log("0041_m21_owner_tools.sql guard region matches the table list and the schema");
    const derived22 = await m22Tables();
    if (JSON.stringify(derived22) !== JSON.stringify([...M22_TABLES].sort())) {
      console.error(
        `0042 creates market-keyed tables ${derived22.join(",")} but M22_TABLES lists ${M22_TABLES.join(",")}`,
      );
      process.exit(1);
    }
    if (!applyRegion(M22_MIGRATION_PATH, M22_REGION, renderM22Region(), true)) {
      console.error(
        "0042_m22_llm_experts.sql guard region differs: run node scripts/db/gen-market-guard.mjs",
      );
      process.exit(1);
    }
    console.log("0042_m22_llm_experts.sql guard region matches the table list and the schema");
    const derived23 = await m23Tables();
    if (JSON.stringify(derived23) !== JSON.stringify([...M23_TABLES].sort())) {
      console.error(
        `0043 creates market-keyed tables ${derived23.join(",")} but M23_TABLES lists ${M23_TABLES.join(",")}`,
      );
      process.exit(1);
    }
    if (!applyRegion(M23_MIGRATION_PATH, M23_REGION, renderM23Region(), true)) {
      console.error(
        "0043_m23_research.sql guard region differs: run node scripts/db/gen-market-guard.mjs",
      );
      process.exit(1);
    }
    console.log("0043_m23_research.sql guard region matches the table list and the schema");
  } else {
    writeFileSync(MIGRATION_PATH, text);
    console.log(`wrote ${MIGRATION_PATH} (${text.split("\n").length} lines)`);
    applyRegion(M20_MIGRATION_PATH, M20_REGION, renderM20Region(), false);
    applyRegion(M21_MIGRATION_PATH, M21_REGION, renderM21Region(), false);
    applyRegion(M22_MIGRATION_PATH, M22_REGION, renderM22Region(), false);
    applyRegion(M23_MIGRATION_PATH, M23_REGION, renderM23Region(), false);
  }
}
