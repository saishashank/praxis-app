// M13-lite WP6 e2e seed: two synthetic experts (ZZ names, example.test hosts), one red flag with its source,
// one proposed cluster and three claims waiting in the queue. Plain SQL against the throwaway main file
// (real migrations already applied). Idempotent: it checks for its own expert row. No real name (SEC-110).
import { createClient } from "@libsql/client";

const AT = "2026-10-16T09:00:00.000Z";
export const EXPERT_A = "X-E2E1";
export const EXPERT_B = "X-E2E2";
export const NAME_A = "ZZ Quiet Author";
export const NAME_B = "ZZ Loud Author";
export const FLAG_TEXT = "ZZ fixture caveat: results are the author's own sample.";
export const CLAIM_A = "C-E2E-1";

export async function ensureExperts(): Promise<void> {
  const m = createClient({ url: process.env.TURSO_MAIN_URL! });
  try {
    const have = await m.execute({ sql: "SELECT 1 FROM expert WHERE id = ?", args: [EXPERT_A] });
    if (have.rows.length > 0) return;
    const stmts: { sql: string; args: (string | number | null)[] }[] = [];
    const ex = (id: string, name: string, audience: number | null) =>
      stmts.push({
        sql: `INSERT INTO expert (id, name, platforms_json, markets_json, focus_json, status, tier, audience_size,
                audience_d, created_at, updated_at)
              VALUES (?, ?, '["own_site"]', '["AU"]', '["momentum"]', 'tracked', 'core', ?, ?, ?, ?)`,
        args: [id, name, audience, audience === null ? null : "2026-09-30", AT, AT],
      });
    ex(EXPERT_A, NAME_A, 100);
    ex(EXPERT_B, NAME_B, 9_000_000);
    stmts.push({
      sql: `INSERT INTO expert_red_flag (id, expert_id, text, source_url, noted_d, created_at)
            VALUES (?, ?, ?, 'https://zz-e2e.example.test/caveat', '2026-10-01', ?)`,
      args: [`${EXPERT_A}:rf1`, EXPERT_A, FLAG_TEXT, AT],
    });
    stmts.push({
      sql: `INSERT INTO cluster (id, name, category, statement, canonical_text, testability, external_grade,
              closest_family, created_at)
            VALUES ('K-E2E1', 'ZZ breakout group', 'trend_momentum', 'ZZ fixture statement of a breakout method.',
              'ZZ fixture rule.', 'testable_eod', 'not_searched', 'new', ?)`,
      args: [AT],
    });
    stmts.push({
      sql: "INSERT INTO cluster_state (cluster_id, seq, state, actor, at) VALUES ('K-E2E1', 1, 'proposed', 'seed', ?)",
      args: [AT],
    });
    for (const [i, who] of [
      [1, EXPERT_A],
      [2, EXPERT_A],
      [3, EXPERT_B],
    ] as const) {
      const id = `C-E2E-${i}`;
      stmts.push({
        sql: `INSERT INTO claim (id, type, testability, cluster_id, created_at)
              VALUES (?, 'method', 'testable_eod', 'K-E2E1', ?)`,
        args: [id, AT],
      });
      stmts.push({
        sql: `INSERT INTO claim_revision (claim_id, seq, statement, claimed_edge_text, actor, at)
              VALUES (?, 1, ?, 'ZZ claimed result', 'seed', ?)`,
        args: [id, `ZZ fixture claim number ${i}.`, AT],
      });
      stmts.push({
        sql: "INSERT INTO claim_status (claim_id, seq, status, actor, at) VALUES (?, 1, 'extracted', 'seed', ?)",
        args: [id, AT],
      });
      stmts.push({
        sql: "INSERT INTO claim_expert (claim_id, expert_id) VALUES (?, ?)",
        args: [id, who],
      });
      stmts.push({
        sql: "INSERT INTO claim_cluster (claim_id, cluster_id, role) VALUES (?, 'K-E2E1', 'supports')",
        args: [id],
      });
    }
    await m.batch(stmts, "write");
  } finally {
    m.close();
  }
}
