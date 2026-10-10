// @vitest-environment node
// BLD-024 / D-058 by inspection: the pipeline source can only write the market-data tables and its
// own run record, and every data insert is ON CONFLICT DO NOTHING. A behavioural check of the same
// rule (table counts before and after a run) is in batch1.test.ts.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../db/helpers";

const src = (f: string) => readFileSync(path.join(ROOT, f), "utf8");
const core = src("src/lib/data/pipeline/batch1-core.mjs");
const DATA_TABLES = [
  "price_bar",
  "universe_snapshot",
  "bar_refetch",
  "completion_marker",
  "ingest_cursor",
];

describe("pipeline write surface", () => {
  it("insertRows is only called for the market-data tables", () => {
    const tables = [...core.matchAll(/insertRows\(\s*db,\s*"(\w+)"/g)].map((m) => m[1]);
    expect(tables.length).toBeGreaterThanOrEqual(DATA_TABLES.length);
    expect(new Set(tables)).toEqual(new Set(DATA_TABLES));
  });

  it("the only other writes are the run record's own INSERT and UPDATE", () => {
    const writes = [...core.matchAll(/\b(INSERT INTO|UPDATE|DELETE FROM)\s+([a-z_${}.]+)/g)].map(
      (m) => `${m[1]} ${m[2]}`,
    );
    expect(new Set(writes)).toEqual(
      new Set(["INSERT INTO run_record", "UPDATE run_record", "INSERT INTO ${table}"]),
    );
    expect(core).not.toMatch(/\bDELETE\b|\bDROP\b|\bALTER\b|\bPRAGMA\b|\bREPLACE\b/i);
  });

  it("data inserts are ON CONFLICT DO NOTHING (never DO UPDATE)", () => {
    expect(core).toContain("ON CONFLICT DO NOTHING");
    expect(core).not.toMatch(/DO UPDATE/i);
  });

  it("the CLI and the core never print rows, URLs or tokens", () => {
    const cli = src("scripts/ingest/batch1.mjs");
    expect(core).not.toMatch(/console\./);
    for (const m of cli.matchAll(/out\(\s*`([^`]*)`/g)) {
      expect(m[1]).not.toMatch(/URL|TOKEN|url|token/);
    }
  });
});
