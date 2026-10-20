// Applies a scenario to the throwaway main libSQL file (real migrations already applied).
// Later page tasks extend buildScenario with their own tables; this file only inserts.
import { MARKET, buildScenario } from "./data.mjs";

export async function applyScenario(client, scenario, nowIso = new Date().toISOString()) {
  const s = buildScenario(scenario, nowIso);
  const stmts = [];
  for (const i of s.instruments) {
    stmts.push({
      sql: `INSERT OR IGNORE INTO instrument (market, code, name, listed_on, last_price, last_price_d)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [MARKET, i.code, i.name, i.listed_on, i.last_price, i.last_price_d],
    });
  }
  for (const b of s.bars) {
    stmts.push({
      sql: `INSERT OR IGNORE INTO price_bar
              (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'e2e-synthetic', ?, ?)`,
      args: [MARKET, b.code, b.d, b.o, b.h, b.l, b.c, b.volume, nowIso, nowIso],
    });
  }
  for (const r of s.runs) {
    stmts.push({
      sql: `INSERT INTO run_record
              (job, market, concurrency_key, started_at, ended_at, status, items_processed)
            VALUES (?, ?, ?, ?, ?, 'success', ?)`,
      args: [r.job, MARKET, r.key, r.started_at, r.ended_at, r.items_processed],
    });
  }
  for (const m of s.markers) {
    stmts.push({
      sql: `INSERT OR IGNORE INTO completion_marker (market, d, kind, at, outcome)
            VALUES (?, ?, 'data', ?, 'complete')`,
      args: [MARKET, m.d, m.at],
    });
  }
  if (stmts.length > 0) await client.batch(stmts, "write");
  return { scenario, instruments: s.instruments.length, bars: s.bars.length, runs: s.runs.length };
}
