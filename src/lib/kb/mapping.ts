// Mapping completeness (AT-24, design 2.10): every record of a day maps to exactly the documents
// that render it. `listRecordIds` enumerates the records of the KB writers (one SQL per table, ids in
// the `<kind>:<key>` form the renderers put in `sourceIds`); `mappingCompleteness` reports the ids
// that no rendered document carries. `UNMAPPED_TABLES` names every other learning table with the
// reason, and a test fails when a table is in neither list, so a new writer must choose.
import type { Client } from "@libsql/client";
import { LEARNING_TABLES } from "@/lib/learning/schema";
import { buildMarketDocuments, REVIEW_MARKET } from "./documents";

type Source = {
  readonly table: string;
  /** SQL selecting `id` (the `<kind>:<key>` text) and `d`, with `?` = market. */
  readonly sql: string;
  readonly reviewOnly?: true;
};

export const RECORD_SOURCES: readonly Source[] = [
  {
    table: LEARNING_TABLES.ruleVersion,
    sql: "SELECT 'rule_version:' || id AS id, registered_d AS d FROM rule_version WHERE market = ?",
  },
  {
    table: LEARNING_TABLES.ruleVersionStatus,
    sql: `SELECT 'rule_version_status:' || s.rule_version_id || ':' || s.seq AS id, s.d AS d
            FROM rule_version_status s JOIN rule_version v ON v.id = s.rule_version_id WHERE v.market = ?`,
  },
  {
    table: LEARNING_TABLES.lesson,
    sql: "SELECT 'lesson:' || id AS id, created_d AS d FROM lesson WHERE market = ?",
  },
  {
    table: LEARNING_TABLES.lessonGrade,
    sql: `SELECT 'lesson_grade:' || g.lesson_id || ':' || g.seq AS id, g.d AS d
            FROM lesson_grade g JOIN lesson l ON l.id = g.lesson_id WHERE l.market = ?`,
  },
  {
    table: LEARNING_TABLES.critique,
    sql: `SELECT 'critique:lesson:' || c.subject_id || ':' || c.run_id AS id, c.d AS d
            FROM critique c JOIN lesson l ON l.id = c.subject_id
           WHERE c.subject_kind = 'lesson' AND l.market = ?
          UNION ALL
          SELECT 'critique:challenger:' || c.subject_id || ':' || c.run_id AS id, c.d AS d
            FROM critique c JOIN challenger h ON h.id = c.subject_id
            JOIN rule_version v ON v.id = h.rule_version_id
           WHERE c.subject_kind = 'challenger' AND v.market = ?`,
  },
  {
    table: LEARNING_TABLES.challenger,
    sql: `SELECT 'challenger:' || c.id AS id, c.state_d AS d FROM challenger c
            JOIN rule_version v ON v.id = c.rule_version_id WHERE v.market = ?`,
  },
  {
    table: LEARNING_TABLES.challengerEvent,
    sql: `SELECT 'challenger_event:' || e.challenger_id || ':' || e.seq AS id, e.d AS d
            FROM challenger_event e JOIN challenger c ON c.id = e.challenger_id
            JOIN rule_version v ON v.id = c.rule_version_id WHERE v.market = ?`,
  },
  {
    table: LEARNING_TABLES.changeLedger,
    sql: "SELECT 'change_ledger:' || id AS id, effective_d AS d FROM change_ledger WHERE market = ?",
  },
  {
    table: LEARNING_TABLES.playbookVersion,
    sql: `SELECT 'playbook_version:' || agent || ':' || n AS id, effective_d AS d
            FROM playbook_version WHERE market = ?`,
  },
  {
    table: LEARNING_TABLES.planItem,
    sql: "SELECT 'plan_item:' || market || ':' || d || ':' || rank AS id, d FROM plan_item WHERE market = ?",
  },
  {
    table: LEARNING_TABLES.planReview,
    sql: `SELECT 'plan_review:' || market || ':' || plan_d || ':' || rank AS id, reviewed_d AS d
            FROM plan_review WHERE market = ?`,
  },
  {
    table: "evening_review",
    sql: "SELECT 'evening_review:' || d || ':' || version AS id, d FROM evening_review",
    reviewOnly: true,
  },
];

/** Learning tables that no document renders, each with the reason (checked by a test). */
export const UNMAPPED_TABLES: Readonly<Record<string, string>> = {
  [LEARNING_TABLES.lessonWindow]: "split bookkeeping, not a statement about the market",
  [LEARNING_TABLES.alphaWealth]: "statistical ledger; the lesson grade rows carry the outcome",
  [LEARNING_TABLES.attribution]: "per-trade statistics input of the lessons",
  [LEARNING_TABLES.blockedTrade]: "statistics input of the lessons",
  [LEARNING_TABLES.comparisonResult]: "descriptive comparison statistics, shown in the review",
  [LEARNING_TABLES.comparisonFinding]: "descriptive comparison statistics, shown in the review",
  [LEARNING_TABLES.critiqueNote]: "LLM-worded critic text; never copied into the KB (KB-061)",
  [LEARNING_TABLES.promotion]: "applied through the change ledger and the challenger state",
  [LEARNING_TABLES.document]: "the documents themselves",
  [LEARNING_TABLES.kbArchiveRun]: "operations record of the archive",
  [LEARNING_TABLES.factorBucketStat]: "ch.16 statistics, not KB documents in M6",
  [LEARNING_TABLES.pick]: "ch.16 picks, not KB documents in M6",
  [LEARNING_TABLES.pickOutcome]: "ch.16 picks, not KB documents in M6",
  [LEARNING_TABLES.bakeoffResult]: "bake-off report is committed by the Owner (LLM-042)",
};

/** Ids of every mapped record of a market, optionally of one Melbourne date. */
export async function listRecordIds(db: Client, market: string, d?: string): Promise<string[]> {
  const ids: string[] = [];
  for (const s of RECORD_SOURCES) {
    if (s.reviewOnly === true && market !== REVIEW_MARKET) continue;
    const args = Array<string>(s.sql.split("?").length - 1).fill(market);
    const rows = (await db.execute({ sql: s.sql, args })).rows;
    for (const r of rows) {
      if (d === undefined || String(r.d) === d) ids.push(String(r.id));
    }
  }
  return ids.sort();
}

export type CompletenessResult = {
  readonly records: number;
  readonly documents: number;
  readonly missing: readonly string[];
};

/** Records (of the market, of date `d` when given) that no regenerated document carries. */
export async function mappingCompleteness(
  db: Client,
  market: string,
  d?: string,
): Promise<CompletenessResult> {
  const docs = await buildMarketDocuments(db, market);
  const carried = new Set(docs.flatMap((x) => x.sourceIds));
  const ids = await listRecordIds(db, market, d);
  return {
    records: ids.length,
    documents: docs.length,
    missing: ids.filter((id) => !carried.has(id)),
  };
}
