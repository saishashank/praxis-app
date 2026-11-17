// Licence store (M22 E1; KB-083, D-1430). `expert_source_licence` is append-only (0042): a check or an acceptance
// adds a row, and the LATEST row per (expert, source) is the status. Every statement names its cap; no OFFSET.
import type { Client } from "@libsql/client";
import { sourcesOf, type LicenceSource } from "./engine.mjs";
import {
  LICENCE_ACTORS,
  LICENCE_STATUSES,
  type LicenceActor,
  type LicenceStatus,
  type Robots,
  type Summarisation,
} from "./policy";

type Exec = Pick<Client, "execute">;

export type LicenceRow = {
  expertId: string;
  sourceKey: string;
  checkedAt: string;
  termsUrl: string | null;
  robots: Robots;
  summarisation: Summarisation;
  status: LicenceStatus;
  actor: LicenceActor;
  note: string | null;
};

const NOTE_MAX = 200; // threshold-ok: expert_source_licence.note cap (0042)
const COLS =
  "expert_id, source_key, checked_at, terms_url, robots, summarisation, status, actor, note";

const asRow = (r: Record<string, unknown>): LicenceRow => ({
  expertId: String(r.expert_id),
  sourceKey: String(r.source_key),
  checkedAt: String(r.checked_at),
  termsUrl: r.terms_url === null ? null : String(r.terms_url),
  robots: String(r.robots) as Robots,
  summarisation: String(r.summarisation) as Summarisation,
  status: String(r.status) as LicenceStatus,
  actor: String(r.actor) as LicenceActor,
  note: r.note === null ? null : String(r.note),
});

/** Appends one row. Never updates: a later row replaces an earlier one as "latest". Throws on a bad value. */
export async function appendLicence(db: Exec, row: LicenceRow): Promise<void> {
  if (!(LICENCE_STATUSES as readonly string[]).includes(row.status)) throw new Error("status");
  if (!(LICENCE_ACTORS as readonly string[]).includes(row.actor)) throw new Error("actor");
  if (row.note !== null && row.note.length > NOTE_MAX) throw new Error("note");
  // rows-ok: one INSERT of one row
  await db.execute({
    sql: `INSERT INTO expert_source_licence (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      row.expertId,
      row.sourceKey,
      row.checkedAt,
      row.termsUrl,
      row.robots,
      row.summarisation,
      row.status,
      row.actor,
      row.note,
    ],
  });
}

/** The latest row of one source (the E2 poll reads this: only `enabled` or `owner-accepted-risk` is fetched). */
export async function latestLicence(
  db: Exec,
  source: { expertId: string; sourceKey: string },
): Promise<LicenceRow | null> {
  // rows-ok: at most 1 row, by the primary key prefix, newest first
  const r = await db.execute({
    sql: `SELECT ${COLS} FROM expert_source_licence WHERE expert_id = ? AND source_key = ? ORDER BY checked_at DESC LIMIT 1`,
    args: [source.expertId, source.sourceKey],
  });
  return r.rows.length === 0 ? null : asRow(r.rows[0] as Record<string, unknown>);
}

/** The latest row of every source of one expert, by source key. */
export async function latestLicenceOf(
  db: Exec,
  expertId: string,
): Promise<Map<string, LicenceRow>> {
  // rows-ok: at most ten rows (the per-expert source cap) (one per source) plus a few retired keys, by the primary key prefix
  const r = await db.execute({
    sql: `SELECT ${COLS} FROM expert_source_licence l WHERE l.expert_id = ?
          AND l.checked_at = (SELECT MAX(m.checked_at) FROM expert_source_licence m
                              WHERE m.expert_id = l.expert_id AND m.source_key = l.source_key)
          LIMIT 50`, // threshold-ok: five times the source cap, a guard against retired keys
    args: [expertId],
  });
  return new Map(r.rows.map((x) => [String(x.source_key), asRow(x as Record<string, unknown>)]));
}

export type LicenceExpert = {
  id: string;
  platforms: string[];
  handles: Record<string, string>;
  homeUrls: string[];
  noFeed: boolean;
};

const parse = <T>(text: unknown, fallback: T): T => {
  try {
    return JSON.parse(String(text)) as T;
  } catch {
    return fallback;
  }
};
const asExpert = (r: Record<string, unknown>): LicenceExpert => {
  const handles = parse<Record<string, unknown>>(r.handles_json, {});
  return {
    id: String(r.id),
    platforms: parse<unknown[]>(r.platforms_json, []).map(String),
    handles: Object.fromEntries(
      Object.entries(handles).filter(([, v]) => typeof v === "string") as [string, string][],
    ),
    homeUrls: parse<unknown[]>(r.home_urls_json, []).map(String),
    noFeed: Number(r.no_feed) === 1,
  };
};
const EXPERT_COLS = "id, platforms_json, handles_json, home_urls_json, no_feed";

/** Experts whose sources the monthly check reads: candidates and tracked, not paused or retired. */
export async function licenceExperts(db: Exec): Promise<LicenceExpert[]> {
  // rows-ok: the tracked set is capped at 150 (expert_tracked_max) plus candidates; read once a month
  const r = await db.execute(
    `SELECT ${EXPERT_COLS} FROM expert WHERE status IN ('candidate','tracked') ORDER BY id LIMIT 1000`, // threshold-ok: far above the tracked cap
  );
  return r.rows.map((x) => asExpert(x as Record<string, unknown>));
}

export async function licenceExpert(db: Exec, id: string): Promise<LicenceExpert | null> {
  // rows-ok: at most 1 row, by primary key
  const r = await db.execute({ sql: `SELECT ${EXPERT_COLS} FROM expert WHERE id = ?`, args: [id] });
  return r.rows.length === 0 ? null : asExpert(r.rows[0] as Record<string, unknown>);
}

export type SourceLicenceView = { source: LicenceSource; latest: LicenceRow | null };

/** Each source of one expert with its latest licence row (the expert page). Null when the expert is unknown. */
export async function licenceView(db: Exec, expertId: string): Promise<SourceLicenceView[] | null> {
  const e = await licenceExpert(db, expertId);
  if (e === null) return null;
  const latest = await latestLicenceOf(db, e.id);
  return sourcesOf(e).map((source) => ({ source, latest: latest.get(source.key) ?? null }));
}

/** True when a licence job already ran in the month of `d` (YYYY-MM-DD): the monthly mode runs once a month. */
export async function licenceRunInMonth(db: Exec, d: string): Promise<boolean> {
  const month = d.slice(0, 7);
  // rows-ok: at most 1 row (LIMIT 1), by the primary key (kind, d)
  const r = await db.execute({
    sql: "SELECT 1 FROM expert_poll_run WHERE kind = 'licence' AND d >= ? AND d <= ? LIMIT 1",
    args: [`${month}-01`, `${month}-31`],
  });
  return r.rows.length > 0;
}

/** One row per kind and day (insert-or-ignore: a second run on the same day keeps the first). */
export async function recordLicenceRun(
  db: Exec,
  d: string,
  counts: Record<string, number>,
  createdAt: string,
): Promise<void> {
  // rows-ok: one INSERT of one row
  await db.execute({
    sql: "INSERT OR IGNORE INTO expert_poll_run (kind, d, counts_json, created_at) VALUES ('licence', ?, ?, ?)",
    args: [d, JSON.stringify(counts), createdAt],
  });
}
