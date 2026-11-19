// State `experts-sources` (M22 A1, D-1444, D-1430, D-1435; AT-79): two synthetic experts, one tracked with an `enabled`
// licence row and one discovery candidate with an `unchecked` one, and two call proposals of two claims of type call, one
// `complete` and one `incomplete`, so the sources and call-confirmation views (M22) render from stored rows. Leaves the
// configuration at its defaults (part of `all`). ZZ names, example.test hosts, fixed ids, idempotent: it checks for its own
// expert row. No real name (SEC-110).
export const AT = "2026-10-16T09:00:00.000Z";
export const EXPERT_TRACKED = "X-SRC1";
export const EXPERT_CANDIDATE = "X-SRC2";
export const NAME_TRACKED = "ZZ Source Author";
export const NAME_CANDIDATE = "ZZ Candidate Author";
export const SOURCE_KEY = "expert_own_site";
export const CLAIM_COMPLETE = "C-SRC-1";
export const CLAIM_INCOMPLETE = "C-SRC-2";
export const PROPOSAL_COMPLETE = "c".repeat(64);
export const PROPOSAL_INCOMPLETE = "d".repeat(64);
export const CODE = "ZZSC";

/** @param {import("@libsql/client").Client} m */
export async function apply(m) {
  const have = await m.execute({
    sql: "SELECT 1 FROM expert WHERE id = ?",
    args: [EXPERT_TRACKED],
  });
  if (have.rows.length > 0) return;
  /** @type {{ sql: string, args: (string | number | null)[] }[]} */
  const stmts = [];
  /** @param {string} id @param {string} name @param {string} status @param {string} tier */
  const ex = (id, name, status, tier) =>
    stmts.push({
      sql: `INSERT INTO expert (id, name, platforms_json, handles_json, home_urls_json, markets_json, focus_json, status, tier,
              created_at, updated_at)
            VALUES (?, ?, '["own_site"]', '{}', '["https://zz-src.example.test/"]', '["AU"]', '["momentum"]', ?, ?, ?, ?)`,
      args: [id, name, status, tier, AT, AT],
    });
  ex(EXPERT_TRACKED, NAME_TRACKED, "tracked", "core");
  ex(EXPERT_CANDIDATE, NAME_CANDIDATE, "candidate", "discovered");
  /** @param {string} id @param {string} status @param {string} note */
  const licence = (id, status, note) =>
    stmts.push({
      sql: `INSERT INTO expert_source_licence (expert_id, source_key, checked_at, terms_url, robots, summarisation, status, actor, note)
            VALUES (?, ?, ?, 'https://zz-src.example.test/terms', ?, ?, ?, 'import', ?)`,
      args: [
        id,
        SOURCE_KEY,
        AT,
        status === "enabled" ? "allows" : "absent",
        status === "enabled" ? "yes" : "unknown",
        status,
        note,
      ],
    });
  licence(EXPERT_TRACKED, "enabled", "ZZ fixture: robots allow, summaries permitted");
  licence(EXPERT_CANDIDATE, "unchecked", "ZZ fixture: not checked yet");
  for (const [i, id] of [
    [1, CLAIM_COMPLETE],
    [2, CLAIM_INCOMPLETE],
  ]) {
    stmts.push({
      sql: `INSERT INTO claim (id, type, testability, created_at) VALUES (?, 'call', 'testable_eod', ?)`,
      args: [id, AT],
    });
    stmts.push({
      sql: `INSERT INTO claim_revision (claim_id, seq, statement, claimed_edge_text, actor, at)
            VALUES (?, 1, ?, 'ZZ claimed result', 'seed', ?)`,
      args: [id, `ZZ fixture call number ${i}.`, AT],
    });
    stmts.push({
      sql: "INSERT INTO claim_status (claim_id, seq, status, actor, at) VALUES (?, 1, 'extracted', 'seed', ?)",
      args: [id, AT],
    });
    stmts.push({
      sql: "INSERT INTO claim_expert (claim_id, expert_id) VALUES (?, ?)",
      args: [id, EXPERT_TRACKED],
    });
  }
  stmts.push({
    sql: `INSERT INTO expert_call_proposal (proposal_id, claim_id, market, code, direction, call_d, horizon_sessions,
            price_basis, state, reason, source, created_at)
          VALUES (?, ?, 'AU', ?, 'long', '2026-10-15', 10, 'close', 'complete', 'ZZ fixture: all fields found', 'rules', ?)`,
    args: [PROPOSAL_COMPLETE, CLAIM_COMPLETE, CODE, AT],
  });
  stmts.push({
    sql: `INSERT INTO expert_call_proposal (proposal_id, claim_id, market, code, direction, call_d, horizon_sessions,
            price_basis, state, reason, source, created_at)
          VALUES (?, ?, 'AU', ?, NULL, NULL, NULL, 'unspecified', 'incomplete', 'ZZ fixture: no horizon or date stated', 'rules', ?)`,
    args: [PROPOSAL_INCOMPLETE, CLAIM_INCOMPLETE, CODE, AT],
  });
  await m.batch(stmts, "write");
}
