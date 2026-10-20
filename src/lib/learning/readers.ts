// Read-only readers behind GET /api/learning/plan and GET /api/learning/documents (M7 T4, D-132
// draft; carried from D-125). Stored rows only, no computation: the plan and its next-night review
// (ARN-066, plan.ts) and the knowledge documents (KB, document table, append-only versions).
import type { Client } from "@libsql/client";

export const DOC_TYPES = [
  "family",
  "playbook",
  "lesson",
  "challenger",
  "review",
  "hypothesis",
  "source_register",
] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const DOC_LIST_DEFAULT = 100; // threshold-ok: page size of the document list
export const DOC_LIST_MAX = 500; // threshold-ok: hard cap of the document list

const text = (v: unknown): string => String(v);
const int = (v: unknown): number => Number(v); // money-float-ok: a rank, version or count read from SQL
const DATE = /^\d\d\d\d-\d\d-\d\d$/;

export const isDate = (s: string): boolean => DATE.test(s);
export const isDocType = (s: string): s is DocType => (DOC_TYPES as readonly string[]).includes(s);

function parse(json: unknown): unknown {
  try {
    return JSON.parse(text(json));
  } catch {
    return null;
  }
}

export type PlanView = {
  market: string;
  d: string | null;
  items: {
    rank: number;
    kind: string;
    reason: string;
    lesson_id: string | null;
    lane: string;
    measure: unknown;
  }[];
  reviews: {
    rank: number;
    reviewed_d: string;
    outcome: string;
    evidence: unknown;
  }[];
};

/** The plan of `d` (default: the latest) with its reviews; `d: null` when no plan exists. */
export async function readPlan(db: Client, market: string, d?: string): Promise<PlanView> {
  let planD = d ?? null;
  if (planD === null) {
    const latest = await db.execute({
      sql: "SELECT MAX(d) AS d FROM plan_item WHERE market = ?",
      args: [market],
    });
    const v = latest.rows[0]?.d;
    planD = v === null || v === undefined ? null : text(v);
  }
  if (planD === null) return { market, d: null, items: [], reviews: [] };
  const items = await db.execute({
    sql: `SELECT rank, kind, reason, lesson_id, lane, measure_json FROM plan_item
          WHERE market = ? AND d = ? ORDER BY rank`,
    args: [market, planD],
  });
  if (items.rows.length === 0) return { market, d: null, items: [], reviews: [] };
  const reviews = await db.execute({
    sql: `SELECT rank, reviewed_d, outcome, evidence_json FROM plan_review
          WHERE market = ? AND plan_d = ? ORDER BY rank`,
    args: [market, planD],
  });
  return {
    market,
    d: planD,
    items: items.rows.map((r) => ({
      rank: int(r.rank),
      kind: text(r.kind),
      reason: text(r.reason),
      lesson_id: r.lesson_id === null ? null : text(r.lesson_id),
      lane: text(r.lane),
      measure: parse(r.measure_json),
    })),
    reviews: reviews.rows.map((r) => ({
      rank: int(r.rank),
      reviewed_d: text(r.reviewed_d),
      outcome: text(r.outcome),
      evidence: parse(r.evidence_json),
    })),
  };
}

export type DocSummary = {
  path: string;
  version: number;
  doc_type: string;
  d: string;
  front: unknown;
};
export type DocFull = DocSummary & { body: string; body_sha: string; source_ids: unknown };

const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Latest version of each document (no bodies), by path; optional type and path-substring filters. */
export async function listDocuments(
  db: Client,
  o: { market: string; type?: DocType; q?: string; limit?: number },
): Promise<DocSummary[]> {
  const limit = Math.min(Math.max(1, o.limit ?? DOC_LIST_DEFAULT), DOC_LIST_MAX);
  const args: (string | number)[] = [o.market];
  let where = "d1.market = ?";
  if (o.type !== undefined) {
    where += " AND d1.doc_type = ?";
    args.push(o.type);
  }
  if (o.q !== undefined && o.q !== "") {
    where += " AND d1.path LIKE ? ESCAPE '\\'";
    args.push(`%${likeEscape(o.q)}%`);
  }
  args.push(limit);
  const rs = await db.execute({
    sql: `SELECT d1.path, d1.version, d1.doc_type, d1.d, d1.front_json FROM document d1
          WHERE ${where}
            AND d1.version = (SELECT MAX(d2.version) FROM document d2 WHERE d2.path = d1.path)
          ORDER BY d1.path LIMIT ?`,
    args,
  });
  return rs.rows.map((r) => ({
    path: text(r.path),
    version: int(r.version),
    doc_type: text(r.doc_type),
    d: text(r.d),
    front: parse(r.front_json),
  }));
}

/** One document with its body: the given version, else the latest; null when absent. */
export async function readDocument(
  db: Client,
  o: { market: string; path: string; version?: number },
): Promise<DocFull | null> {
  const rs = await db.execute({
    sql: `SELECT path, version, doc_type, d, front_json, body, body_sha, source_ids_json FROM document
          WHERE market = ? AND path = ? ${o.version === undefined ? "" : "AND version = ?"}
          ORDER BY version DESC LIMIT 1`,
    args: o.version === undefined ? [o.market, o.path] : [o.market, o.path, o.version],
  });
  const r = rs.rows[0];
  if (r === undefined) return null;
  return {
    path: text(r.path),
    version: int(r.version),
    doc_type: text(r.doc_type),
    d: text(r.d),
    front: parse(r.front_json),
    body: text(r.body),
    body_sha: text(r.body_sha),
    source_ids: parse(r.source_ids_json),
  };
}
