// Synthetic KB records for the M6 T13 tests. Test support only: invented ZZ identifiers, dates in
// Oct 2026, real migrations. Nothing here resembles a real company or a real result.
import type { Client } from "@libsql/client";
import { seedRuleVersions } from "@/lib/learning/ruleVersions";
import { freshDb } from "../db/helpers";

export const MARKET = "AU";
export const LESSON = "L-AU-ZZ_TEMPLATE-aaaa1111-F1.v1";
export const CHALLENGER = "C-AU-F1-1";
type V = string | number | null;

export async function exec(db: Client, sql: string, args: V[] = []) {
  return db.execute({ sql, args });
}

export async function kbWorld(): Promise<Client> {
  const db = await freshDb("main");
  await seedRuleVersions(db, { market: MARKET, d: "2026-10-01" });

  // A challenger version: F1.v1 with one parameter changed.
  const v1 = (await exec(db, "SELECT params_json, spec_json FROM rule_version WHERE id = 'F1.v1'"))
    .rows[0]!;
  const params = JSON.parse(String(v1.params_json)) as Record<string, unknown>;
  const key = Object.keys(params).sort()[0]!;
  params[key] = typeof params[key] === "number" ? (params[key] as number) + 1 : params[key];
  await exec(
    db,
    `INSERT INTO rule_version (id, market, family, n, parent, origin, params_json, params_sha, spec_json,
       schema_version, registered_d, created_by)
     VALUES ('F1.v2', ?, 'F1', 2, 'F1.v1', 'challenger', ?, ?, ?, 1, '2026-10-12', 'A6')`,
    [MARKET, JSON.stringify(params), "b".repeat(64), String(v1.spec_json)],
  );
  await exec(
    db,
    "INSERT INTO rule_version_status (rule_version_id, seq, status, d, reason) VALUES ('F1.v2', 1, 'registered', '2026-10-12', 'challenger')",
  );

  await exec(
    db,
    `INSERT INTO lesson (id, market, scope, lineage_id, template_id, template_version, subject_json,
       rule_version, metric, direction, param_hint, created_d, created_run)
     VALUES (?, ?, 'lineage', 'AU-F1-ZZ', 'ZZ_TEMPLATE', 1, ?, 'F1.v1', 'expectancy', 1, NULL, '2026-10-10', 'run-1')`,
    [LESSON, MARKET, JSON.stringify({ sector: "ZZ Materials", bucket: 3 })],
  );
  for (const [seq, grade, d] of [
    [1, "L0", "2026-10-10"],
    [2, "L1", "2026-10-14"],
  ] as const) {
    await exec(
      db,
      `INSERT INTO lesson_grade (lesson_id, seq, grade, split_version, window, n, blocks, estimate, lower, upper, p,
         alpha_j, B, state_text, run_id, d)
       VALUES (?, ?, ?, 1, 'l1', 40, 8, 0.0125, 0.002, 0.021, NULL, NULL, 1000, '', ?, ?)`,
      [LESSON, seq, grade, `run-${seq}`, d],
    );
  }
  await exec(
    db,
    `INSERT INTO critique (subject_kind, subject_id, run_id, checks_json, passed, d)
     VALUES ('lesson', ?, 'run-2', '[]', 1, '2026-10-14')`,
    [LESSON],
  );

  await exec(
    db,
    `INSERT INTO challenger (id, lineage_id, rule_version_id, incumbent_version_id, origin, lesson_ids_json,
       state, state_d, trial_id) VALUES (?, 'AU-F1-ZZ', 'F1.v2', 'F1.v1', 'generator', ?, 'proposed', '2026-10-12', 'trial-1')`,
    [CHALLENGER, JSON.stringify([LESSON])],
  );
  await exec(
    db,
    `INSERT INTO challenger_event (challenger_id, seq, from_state, to_state, d, actor, reason)
     VALUES (?, 1, NULL, 'proposed', '2026-10-12', 'A6', 'generated from a lesson')`,
    [CHALLENGER],
  );
  await exec(db, "UPDATE challenger SET state = 'replay', state_d = '2026-10-13' WHERE id = ?", [
    CHALLENGER,
  ]);
  await exec(
    db,
    `INSERT INTO challenger_event (challenger_id, seq, from_state, to_state, d, actor, reason)
     VALUES (?, 2, 'proposed', 'replay', '2026-10-13', 'A6', 'queued for replay')`,
    [CHALLENGER],
  );
  await exec(
    db,
    `INSERT INTO critique (subject_kind, subject_id, run_id, checks_json, passed, d)
     VALUES ('challenger', ?, 'run-3', '[]', 0, '2026-10-13')`,
    [CHALLENGER],
  );

  // Change ledger: a playbook change naming the lesson (id 1), a challenger change (2), an Owner
  // version of a family (3) and a freeze that names only the family (4).
  for (const [kind, target, lessons, ch, d] of [
    ["lane_a_playbook", "A1", [LESSON], null, "2026-10-14"],
    ["force_apply", "F1.v2", [], CHALLENGER, "2026-10-15"],
    ["owner_version", "F2.v1", [], null, "2026-10-15"],
    ["kill_freeze", "F3", [], null, "2026-10-16"],
  ] as const) {
    await exec(
      db,
      `INSERT INTO change_ledger (market, kind, target, lesson_ids_json, challenger_id, effective_d, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'A6', '2026-10-14T10:00:00.000Z')`,
      [MARKET, kind, target, JSON.stringify(lessons), ch, d],
    );
  }
  await exec(
    db,
    `INSERT INTO playbook_version (market, agent, n, content, content_sha, tokens_est, change_id, effective_d)
     VALUES (?, 'A1', 1, ?, ?, 12, 1, '2026-10-14')`,
    [MARKET, "Guidance\n- ZZ Materials bucket 3 may hold (L1).\n", "c".repeat(64)],
  );

  await exec(
    db,
    `INSERT INTO plan_item (market, d, rank, kind, reason, lesson_id, lane, measure_json)
     VALUES (?, '2026-10-14', 1, 'review_lesson', 'grade moved', ?, 'A', '{}')`,
    [MARKET, LESSON],
  );
  await exec(
    db,
    `INSERT INTO plan_item (market, d, rank, kind, reason, lesson_id, lane, measure_json)
     VALUES (?, '2026-10-14', 2, 'ops_check', 'no-lesson: nothing new', NULL, 'ops', '{}')`,
    [MARKET],
  );
  await exec(
    db,
    `INSERT INTO plan_review (market, plan_d, rank, reviewed_d, outcome, evidence_json)
     VALUES (?, '2026-10-14', 2, '2026-10-15', 'done', '{}')`,
    [MARKET],
  );

  for (const [d, version, md] of [
    ["2026-10-13", 1, "# Evening Review 2026-10-13\n\nZZ Materials quiet.\n"],
    ["2026-10-14", 1, "# Evening Review 2026-10-14 (v1)\n"],
    ["2026-10-14", 2, "# Evening Review 2026-10-14 (v2)\n\nRevised.\n"],
  ] as const) {
    await exec(
      db,
      `INSERT INTO evening_review (d, version, kind, facts_json, facts_sha, html, text, markdown, size_html, narrative, created_at)
       VALUES (?, ?, 'full', '{}', ?, '', '', ?, 0, 'rules', ?)`,
      [d, version, String(version).repeat(64), md, `${d}T09:00:00.000Z`],
    );
  }

  await exec(
    db,
    `INSERT INTO replay_run (id, kind, market, snapshot_sha, commit_sha, params_sha, seed, node_version, files_json, minutes)
     VALUES ('rr-1', 'full', ?, ?, ?, ?, 1, 'v24', '[]', 1)`,
    [MARKET, "d".repeat(64), "e".repeat(40), "f".repeat(64)],
  );
  const leg = (lev: number, trades: number) => ({
    leverage: lev,
    sleeveTrades: trades,
    shadowTrades: 3,
    closeouts: 1,
    locks: 0,
    netPlMicro: "-1500",
  });
  await exec(
    db,
    `INSERT INTO replay_stat (run_id, scope, metric, d, value_json)
     VALUES ('rr-1', 'sleeve:F1', 'sleeve_leverage', '2026-10-16', ?)`,
    [
      JSON.stringify({
        family: "F1",
        label: "hypothetical leverage",
        unlevered: null,
        levered: leg(10, 12),
        reality: leg(5, 9),
      }),
    ],
  );

  await exec(
    db,
    `INSERT INTO source_register (source, terms_url, permitted_use, rate_limits, last_checked, risk, status, owner_ref, summarisation_permitted)
     VALUES ('zz_source', 'https://example.test/terms', 'display', '1/s', '2026-10-05', 'low', 'enabled', 'secret-owner-ref', 0)`,
  );
  return db;
}
