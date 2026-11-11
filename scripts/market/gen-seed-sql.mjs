// Generates db/migrations/main/0034_m19_market_profile.sql from the seed modules (M19 A1; D-992).
// The seed modules in src/lib/market/seed/ are the single definition of every market fact; the migration is a
// checked projection of them. Usage:
//   node scripts/market/gen-seed-sql.mjs           writes the file
//   node scripts/market/gen-seed-sql.mjs --check   exits 1 when the committed file differs from the seed
// A migration that has been applied in production is never regenerated: a later seed change is a new migration
// (or a profile-writer change), and tests/db/0034_m19_market_profile.test.ts then compares the SEED to the
// migrated rows only for the values this migration wrote.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PROFILE_FIELDS } from "../../src/lib/market/fields.mjs";
import { encodeValue, slotsJson } from "../../src/lib/market/profileCore.mjs";
import { SEEDS } from "../../src/lib/market/seed/index.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const MIGRATION_PATH = join(root, "db", "migrations", "main", "0034_m19_market_profile.sql");

const q = (v) => (v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);

/** Plain-profile view of a seed (what profileFromRows would compute from the stored rows). */
function plain(seed) {
  const v = (n) => seed.fields[n].value;
  return {
    sessionOpen: v("session_open"),
    sessionClose: v("session_close"),
    decisionCutoff: v("decision_cutoff").time,
    batchSchedule: v("batch_schedule"),
    preopenRecheckMin: v("preopen_recheck_min"),
  };
}

export function renderMigration() {
  const codes = Object.keys(SEEDS).sort();
  const out = [];
  out.push(`-- +up
-- M19 A1 (docs/M19_design.md stream A1; D-992, D-994, D-998, D-999). GENERATED from src/lib/market/seed/*.mjs
-- by scripts/market/gen-seed-sql.mjs; tests/db/0034_m19_market_profile.test.ts asserts every seeded row equals
-- the seed modules. Do not edit by hand: change the seed and regenerate (before the first production apply).
--
-- 1. market_profile: one row per market, the stored MKT-106/MKT-114 work status, its dates and the profile
--    version (DAT-241). Configuration, never deleted.
-- 2. market_profile_field: one row per field of the ch. 20 profile table: the value as JSON ("<n>n" is a
--    bigint), the [VERIFY] flag, the date and evidence of its verification (DAT-242). 'null' = set at M20.
-- 3. market_profile_change: the append-only change ledger of profile edits (NFR-023), with the counted-trial
--    flag for a cost, tick, slippage, settlement or parcel change (VAL-112).
-- 4. market gains \`enabled\` (the markets_enabled set, production AU only, D-994) and \`slots_json\` (the Worker's
--    projection of the profile's batch, cut-off, pre-open and quote anchors, D-996). A market that is not
--    enabled must be mode 'off' (two triggers: SQLite cannot add a row CHECK that refers to another column
--    to a table that already has rows). AU is enabled; IN and US are inserted enabled 0, mode 'off'.

CREATE TABLE market_profile (
  code TEXT PRIMARY KEY REFERENCES market (code),
  work_status TEXT NOT NULL CHECK (work_status IN
    ('not_started','in_build','testing','built','active','paused')),
  status_changed_at TEXT,
  built_at TEXT,
  evidence_recorded_at TEXT,
  profile_version INTEGER NOT NULL DEFAULT 1 CHECK (profile_version >= 1),
  updated_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;
CREATE TRIGGER market_profile_no_delete BEFORE DELETE ON market_profile
BEGIN
  SELECT RAISE(ABORT, 'market profile rows are never deleted');
END;

CREATE TABLE market_profile_field (
  code TEXT NOT NULL REFERENCES market_profile (code),
  field TEXT NOT NULL CHECK (length(field) BETWEEN 1 AND 48),
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  verify INTEGER NOT NULL CHECK (verify IN (0,1)),
  verified_at TEXT,
  evidence_ref TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (code, field)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER market_profile_field_no_delete BEFORE DELETE ON market_profile_field
BEGIN
  SELECT RAISE(ABORT, 'market profile fields are never deleted');
END;

CREATE TABLE market_profile_change (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL,
  field TEXT NOT NULL,
  old_json TEXT,
  new_json TEXT,
  changed_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  counted_trial INTEGER NOT NULL DEFAULT 0 CHECK (counted_trial IN (0,1)),
  trial_ref TEXT
) STRICT;
CREATE INDEX idx_market_profile_change_code ON market_profile_change (code, id DESC);
CREATE TRIGGER market_profile_change_no_update BEFORE UPDATE ON market_profile_change
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER market_profile_change_no_delete BEFORE DELETE ON market_profile_change
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

ALTER TABLE market ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1));
ALTER TABLE market ADD COLUMN slots_json TEXT CHECK (slots_json IS NULL OR json_valid(slots_json));
CREATE TRIGGER market_enabled_mode_ins BEFORE INSERT ON market
WHEN NEW.enabled = 0 AND NEW.mode <> 'off'
BEGIN
  SELECT RAISE(ABORT, 'a market that is not enabled must be off');
END;
CREATE TRIGGER market_enabled_mode_upd BEFORE UPDATE ON market
WHEN NEW.enabled = 0 AND NEW.mode <> 'off'
BEGIN
  SELECT RAISE(ABORT, 'a market that is not enabled must be off');
END;
`);
  out.push(
    "-- 5. The seed. AU is already a market row (0004): it becomes enabled with its projection. IN and US are new.",
  );
  for (const code of codes) {
    const s = SEEDS[code];
    const v = (n) => s.fields[n].value;
    const slots = slotsJson(plain(s));
    if (code === "AU") {
      out.push(
        `UPDATE market SET enabled = ${s.enabled}, slots_json = ${q(slots)} WHERE code = ${q(code)};`,
      );
    } else {
      out.push(
        `INSERT INTO market (code, tz, open_time, close_time, cutoff_time, currency, mode, enabled, slots_json)\n` +
          `VALUES (${q(code)}, ${q(v("tz"))}, ${q(v("session_open"))}, ${q(v("session_close"))}, ${q(v("decision_cutoff").time)}, ${q(v("currency"))}, ${q(s.mode)}, ${s.enabled}, ${q(slots)});`,
      );
    }
  }
  out.push("");
  for (const code of codes) {
    const s = SEEDS[code];
    out.push(
      `INSERT INTO market_profile (code, work_status, status_changed_at, built_at, evidence_recorded_at, profile_version, updated_at)\n` +
        `VALUES (${q(code)}, ${q(s.workStatus)}, ${q(s.statusChangedAt)}, ${q(s.builtAt)}, ${q(s.evidenceRecordedAt)}, ${s.profileVersion}, ${q(s.updatedAt)});`,
    );
  }
  out.push("");
  for (const code of codes) {
    const s = SEEDS[code];
    out.push(`-- ${code} fields`);
    out.push(
      "INSERT INTO market_profile_field (code, field, value_json, verify, verified_at, evidence_ref, updated_at) VALUES",
    );
    const rows = PROFILE_FIELDS.map((name) => {
      const f = s.fields[name];
      if (f === undefined) throw new Error(`${code} seed lacks field ${name}`);
      return `  (${q(code)}, ${q(name)}, ${q(encodeValue(f.value))}, ${f.verify}, ${q(f.verifiedAt)}, ${q(f.evidenceRef)}, ${q(s.updatedAt)})`;
    });
    out.push(rows.join(",\n") + ";");
    out.push("");
  }
  out.push(`-- +down
-- The new tables go first (they reference market), then the IN and US rows: market_no_delete is lifted for that
-- one statement and restored exactly as 0004 defines it. The two enabled/mode triggers go before the columns
-- (DROP COLUMN refuses a referenced column).
DROP TABLE market_profile_change;
DROP TABLE market_profile_field;
DROP TABLE market_profile;
DROP TRIGGER market_enabled_mode_ins;
DROP TRIGGER market_enabled_mode_upd;
DROP TRIGGER market_no_delete;
DELETE FROM market WHERE code <> 'AU';
CREATE TRIGGER market_no_delete BEFORE DELETE ON market
BEGIN
  SELECT RAISE(ABORT, 'market rows are never deleted');
END;
ALTER TABLE market DROP COLUMN slots_json;
ALTER TABLE market DROP COLUMN enabled;
`);
  return out.join("\n");
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invoked) {
  const text = renderMigration();
  if (process.argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(MIGRATION_PATH, "utf8");
    } catch {
      /* missing file: differs */
    }
    if (current !== text) {
      console.error(
        "0034_m19_market_profile.sql differs from the seed: run node scripts/market/gen-seed-sql.mjs",
      );
      process.exit(1);
    }
    console.log("0034_m19_market_profile.sql matches the seed");
  } else {
    writeFileSync(MIGRATION_PATH, text);
    console.log(`wrote ${MIGRATION_PATH}`);
  }
}
