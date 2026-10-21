// @vitest-environment node
// TST-110 / AGT-130 (M4 T17): every entity of DAT-150 (spec/06) and every table of migration 0008
// is either a row of the coverage matrix in spec/07 section 7.7, "stored, not used", or not market
// information (an output, a setting or an operations record). The spec text is parsed, so a new
// DAT-150 entity or a new 0008 table fails this test until it is classified here and the matrix is
// kept in sync. Pure file reads, no database.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

/** The matrix rows of spec/07 section 7.7 (first column). */
function matrixRows(): string[] {
  const text = read("spec/07_agents.md");
  const start = text.indexOf("## 7.7 Coverage matrix");
  const end = text.indexOf("- **AGT-130**", start);
  return text
    .slice(start, end)
    .split("\n")
    .filter((l) => l.startsWith("| ") && !l.startsWith("| Data /") && !l.startsWith("|---"))
    .map((l) => l.split("|")[1]!.trim());
}

/** The entity names of the DAT-150 line of spec/06. */
function dat150Entities(): string[] {
  const line = read("spec/06_data_layer.md")
    .split("\n")
    .find((l) => l.includes("**DAT-150"))!;
  let s = line.slice(line.indexOf("applicable)") + "applicable)".length);
  let prev: string;
  do {
    prev = s;
    s = s.replace(/\([^()]*\)/g, "");
  } while (s !== prev);
  s = s.replace(/\*\*[^*]*\*\*/g, "");
  return s
    .split(/,|;| and /)
    .map((x) =>
      x
        .trim()
        .replace(/^[:\s]+/, "")
        .replace(/\.$/, ""),
    )
    .filter((x) => /^[a-z_]+$/.test(x));
}

/** Tables created by migration 0008. */
function tables0008(): string[] {
  return [...read("db/migrations/main/0008_agents.sql").matchAll(/CREATE TABLE ([a-z0-9_]+)/g)].map(
    (m) => m[1]!,
  );
}

type Cls =
  | { readonly row: string } // a matrix row (substring of exactly one first-column label)
  | "stored, not used"
  | "output" // a result of the agents or of the arena (not market information)
  | "setting" // configuration or reference data
  | "ops"; // operations, users, email, audit

const R = (row: string): Cls => ({ row });

// DAT-150 entities (spec/06).
const DAT150: Readonly<Record<string, Cls>> = {
  pick: "output",
  pick_outcome: "output",
  factor_bucket_stat: "output",
  watchlist: "ops",
  watch_list: "ops",
  security: R("Universe and tiers"),
  universe_snapshot: R("Universe and tiers"),
  price_bar: R("EOD prices"),
  adjustment_factor: R("Corporate actions"),
  corporate_action: R("Corporate actions"),
  dividend_receivable: R("Corporate actions"),
  trading_calendar: "setting",
  announcement: R("Events"),
  macro_series: R("Macro calendar"),
  fx_rate: R("Macro calendar"),
  short_interest: R("Short interest"),
  insider_notice: R("Director trades"),
  fundamentals_snapshot: R("Fundamentals"),
  market_profile: "setting",
  cost_profile: "setting",
  execution: "output",
  rule_version: "output",
  cohort: "output",
  order: "output",
  fill: "output",
  position: "output",
  cash_ledger: "output",
  sleeve_state: "output",
  sleeve_trade: "output",
  control_portfolio: R("Controls C1"),
  signal: "output",
  decision_card: "output",
  blocked_trade: "output",
  alert: "output",
  lesson: "output",
  critique: "output",
  challenger: "output",
  trial_counter: "output",
  change_ledger: "ops",
  config_version: "setting",
  calibration_report: "output",
  bakeoff_result: "output",
  llm_call: "ops",
  llm_cache: "ops",
  run_record: "ops",
  completion_marker: "ops",
  incident: "ops",
  ops_task: "ops",
  usage_meter: "ops",
  email_delivery: "ops",
  document: "ops",
  annotation: "ops",
  data_quality_check: "ops",
  source_register: "setting",
  rate_token: "ops",
  user: "ops",
  user_preference: "ops",
  audit_event: "ops",
};

// Tables that migration 0008 adds. The market-information ones are the matrix rows the DAT-150
// "indicative" list leaves out (benchmark index, events, regime, indicators, insider/flow score).
const T0008: Readonly<Record<string, Cls>> = {
  index_bar: R("Regime"),
  short_interest: R("Short interest"),
  insider_notice: R("Director trades"),
  indicator_daily: R("Indicators"),
  pattern_daily: R("Validated candle patterns"),
  regime_daily: R("Regime"),
  event: R("Events"),
  insider_flow_score: R("Director trades"),
  signal: "output",
  decision_card: "output",
  card_note: "output",
  stop_level: "output",
  c2_selection: R("Controls C1"),
  lineage: "output",
  lineage_split: "output",
  trial_ledger: "output",
  ledger_row: "output",
  ledger_control: R("Controls C1"),
  replay_run: "output",
  validation_result: "output",
  label: "output",
  replay_stat: "output",
  killswitch_look: "output",
  llm_cache: "ops",
  llm_call: "ops",
};

function rowOf(cls: Cls, rows: readonly string[]): string | null {
  if (typeof cls === "string") return null;
  const hits = rows.filter((r) => r.includes(cls.row));
  return hits.length === 1 ? hits[0]! : `AMBIGUOUS:${hits.length}`;
}

describe("TST-110: AGT-130 coverage matrix against DAT-150 and migration 0008", () => {
  const rows = matrixRows();

  it("parses the matrix (12 rows incl. the stored-not-used headline row) and DAT-150 (>= 50 entities)", () => {
    expect(rows.length).toBeGreaterThanOrEqual(12);
    expect(rows).toContain("Headline sentiment (LLM)");
    expect(dat150Entities().length).toBeGreaterThanOrEqual(50);
  });

  it("every DAT-150 entity is classified, and no classification is stale", () => {
    const parsed = dat150Entities().sort();
    expect(Object.keys(DAT150).sort()).toEqual(parsed);
  });

  it("every table of migration 0008 is classified, and no classification is stale", () => {
    const tables = tables0008().sort();
    expect(tables.length).toBe(25);
    expect(Object.keys(T0008).sort()).toEqual(tables);
  });

  it("each matrix reference names exactly one row of spec/07 section 7.7", () => {
    for (const [name, cls] of [...Object.entries(DAT150), ...Object.entries(T0008)]) {
      const r = rowOf(cls, rows);
      if (r !== null)
        expect(r.startsWith("AMBIGUOUS"), `${name} -> ${JSON.stringify(cls)}`).toBe(false);
      if (r !== null) expect(rows, name).toContain(r);
    }
  });

  it("every matrix row that M4 produces is backed by at least one stored table", () => {
    const backed = new Set<string>();
    for (const cls of [...Object.values(DAT150), ...Object.values(T0008)]) {
      const r = rowOf(cls, rows);
      if (r !== null) backed.add(r);
    }
    // Rows with no table of their own: the LLM headline sentiment is stored in announcement text
    // fields and used nowhere in the rules ("stored, not used"); halts, capital raisings and the
    // ARN-011 inputs are read from `announcement` rows by category.
    const derivedFromAnnouncements = [
      "Halts, suspensions, queries",
      "Capital raisings, placements",
      "Headline sentiment (LLM)",
    ];
    for (const r of rows) {
      if (derivedFromAnnouncements.includes(r)) continue;
      expect(backed.has(r), `matrix row without a stored table: ${r}`).toBe(true);
    }
    expect(derivedFromAnnouncements.every((r) => rows.includes(r))).toBe(true);
  });

  it("the stored-not-used list is explicit: the headline sentiment is the only such row", () => {
    const notUsed = rows.filter((r) => /sentiment/i.test(r));
    expect(notUsed).toEqual(["Headline sentiment (LLM)"]);
    const line = read("spec/07_agents.md")
      .split("\n")
      .find((l) => l.startsWith("| Headline sentiment"))!;
    expect(line).toContain("stored, not used in rules");
  });
});
