// Knowledge-area test world (M7 T18): the T8 loader world (synthetic ZZ codes) plus the seeded rule
// versions, a real F1 challenger, graded lessons with Critic checks, a change-ledger row, a hypothesis
// document and notes. Every free-text field mentions ZZUP so a masked view can be checked for leaks.
import { seedRuleVersions } from "@/lib/learning/ruleVersions";
import { addLineage, ownerChallenger } from "../learning/challengerFixtures";
import { D, fullWorld, type World } from "../loaders/world";

export type KnowledgeWorld = World & { challengerId: string; challengerVersion: string };

const run = (w: World, sql: string, args: Array<string | number | null> = []) =>
  w.main.execute({ sql, args });

export const CHECKS = JSON.stringify([
  { n: 1, name: "Enough cases for ZZUP", state: "pass", detail: "ZZUP had 120 cases", values: {} },
  { n: 2, name: "Holds in other years", state: "pending", detail: "Waiting for data", values: {} },
]);

export async function knowledgeWorld(): Promise<KnowledgeWorld> {
  const w = await fullWorld();
  await seedRuleVersions(w.main, { market: "AU", d: "2026-10-01" });
  await addLineage(w.main, "F1");
  await ownerChallenger(w.main, 0, "2026-10-05");
  const c = (await run(w, "SELECT id, rule_version_id FROM challenger LIMIT 1")).rows[0]!;
  // F1.v2 (the challenger's version) became live; F1.v1 was live before: a rollback target.
  await run(
    w,
    `INSERT INTO rule_version_status (rule_version_id, seq, status, d, reason)
     VALUES ('F1.v1', 3, 'shadow', '2026-10-10', 'replaced'), (?, 2, 'live', '2026-10-10', 'promoted')`,
    [String(c.rule_version_id)],
  );
  // Lessons: L-1 (from the loader world) gets L2, plus L-2 at L0 with no Critic result.
  await run(
    w,
    `INSERT INTO lesson_grade (lesson_id, seq, grade, split_version, window, n, blocks, estimate, lower,
       upper, B, state_text, run_id, d) VALUES ('L-1', 1, 'L2', 1, NULL, 120, 18, 0.5, 0.1, 0.9, 0,
       'Held up for ZZUP', 'run-1', ?)`,
    [D],
  );
  await run(
    w,
    `INSERT INTO lesson (id, market, scope, lineage_id, template_id, template_version, subject_json,
       rule_version, metric, direction, created_d, created_run)
     VALUES ('L-2', 'AU', 'market', NULL, 'mean_reversion', 1, '{}', 'F2.v1', 'net_ppm', -1, ?, 'run1')`,
    [D],
  );
  await run(
    w,
    `INSERT INTO lesson_grade (lesson_id, seq, grade, split_version, window, n, blocks, estimate, lower,
       upper, B, state_text, run_id, d) VALUES ('L-2', 1, 'L0', 1, NULL, 15, 2, NULL, NULL, NULL, 0, '',
       'run-1', ?)`,
    [D],
  );
  await run(
    w,
    `INSERT INTO critique (subject_kind, subject_id, run_id, checks_json, passed, d)
     VALUES ('lesson', 'L-1', 'crit-1', ?, 0, ?)`,
    [CHECKS, D],
  );
  await run(
    w,
    `INSERT INTO critique (subject_kind, subject_id, run_id, checks_json, passed, d)
     VALUES ('challenger', ?, 'crit-2', ?, 0, ?)`,
    [String(c.id), CHECKS, D],
  );
  await run(
    w,
    `INSERT INTO critique_note (subject_kind, subject_id, run_id, kind, text, fallback_depth)
     VALUES ('challenger', ?, 'crit-2', 'concerns', 'Looks fitted to ZZUP', '0')`,
    [String(c.id)],
  );
  await run(
    w,
    `INSERT INTO validation_result (id, run_id, lineage_id, rule_version, variant, split_version, test,
       level, B, n, blocks, stat, p, mde, lower, upper, L_used, m_used, outcome)
     VALUES ('v1', 'r1', 'lin', ?, 'F1', 1, 'holdout', 0.05, 0, 40, 4, 0.0123456, 0.2, NULL, -0.01, 0.03,
       1, 1, 'not confirmed')`,
    [String(c.rule_version_id)],
  );
  await run(
    w,
    `INSERT INTO change_ledger (market, kind, target, diff_text, effective_d, actor, created_at)
     VALUES ('AU', 'promotion', 'F1', 'trail 3 to 2.5 after ZZUP', ?, 'u1', ?)`,
    [D, `${D}T09:00:00.000Z`],
  );
  await run(
    w,
    `INSERT INTO document (path, version, market, doc_type, front_json, body, body_sha, d, created_at)
     VALUES ('knowledge/au/hypotheses/H-1.md', 1, 'AU', 'hypothesis', '{"title":"Is ZZUP a leader?"}',
       'Maybe ZZUP leads the sector.', ?, ?, ?)`,
    ["b".repeat(64), D, `${D}T09:00:00.000Z`],
  );
  const note = (kind: string, id: string, author: number, text: string) =>
    w.auth.execute({
      sql: `INSERT INTO annotation (subject_kind, subject_id, author_id, text, created_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [kind, id, author, text, `${D}T10:00:00.000Z`],
    });
  await note("lesson", "L-1", w.ids.owner, "Recheck ZZUP next week");
  await note("lesson", "L-1", w.ids.editor, "Agree");
  await note("hypothesis", "H-1", w.ids.editor, "Worth a look at ZZUP");
  return { ...w, challengerId: String(c.id), challengerVersion: String(c.rule_version_id) };
}
