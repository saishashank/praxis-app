// Statements of the expert polling job and the Sources page (M22 E2; KB-082, D-1432…D-1434). Every statement names its
// cap in a `rows-ok:` comment and none uses OFFSET. `expert.poll_json` (an updatable column, at most 1000 characters) holds
// the job's small state per expert: validators per source (`v`), the time of the last poll (`p`), the extraction
// watermark (`tri`: items ingested at or before it were looked at), and for a discovery candidate the co-mention facts
// (`disc`) and the snooze date (`snz`). No page text is ever stored: an item is a link, a title, a time, and (only where the
// terms permit summaries) one short line of our own.
import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import type { Validators } from "@/lib/kb/fetchRules";
import type { PollFacts } from "./priority";

export type Exec = Pick<Client, "execute">;

export const POLL_JSON_MAX = 1000; // threshold-ok: expert.poll_json length cap (0022)
const ETAG_MAX = 80; // threshold-ok: longest validator kept
const MODIFIED_MAX = 40; // threshold-ok: longest Last-Modified value kept
const TITLE_MAX = 200; // threshold-ok: source_item.title cap (0022)
const SUMMARY_MAX = 160; // threshold-ok: EXTRACTION_RULES.maxSummaryChars

export type PollState = {
  /** Validators by source key. */
  v?: Record<string, { e?: string; l?: string }>;
  /** ISO time of the last poll that read the expert. */
  p?: string;
  /** Extraction watermark: items ingested at or before this time were looked at. */
  tri?: string;
  /** Discovery facts of a candidate: mentions, distinct mentioning experts, day last seen. */
  disc?: { n: number; by: string[]; d: string };
  /** Snoozed until this day (YYYY-MM-DD). */
  snz?: string;
};

export function parsePollJson(text: unknown): PollState {
  if (typeof text !== "string") return {};
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as PollState) : {};
  } catch {
    return {};
  }
}

/** The JSON to store: validators are dropped, last first, until it fits the column (they only save bandwidth). */
export function buildPollJson(s: PollState): string {
  const state: PollState = { ...s };
  if (state.v !== undefined) state.v = { ...state.v };
  let text = JSON.stringify(state);
  if (text.length > POLL_JSON_MAX && state.v !== undefined) {
    const keys = Object.keys(state.v);
    while (text.length > POLL_JSON_MAX && keys.length > 0) {
      delete state.v[keys.pop()!];
      text = JSON.stringify(state);
    }
    if (Object.keys(state.v).length === 0) delete state.v;
    text = JSON.stringify(state);
  }
  if (text.length > POLL_JSON_MAX && state.disc !== undefined) {
    state.disc = { ...state.disc, by: state.disc.by.slice(0, 3) }; // threshold-ok: names kept when the column is full
    text = JSON.stringify(state);
  }
  return text.length > POLL_JSON_MAX ? JSON.stringify({ p: state.p, tri: state.tri }) : text;
}

export const validatorsOf = (s: PollState, key: string): Validators | undefined => {
  const x = s.v?.[key];
  if (x === undefined) return undefined;
  const out: Validators = {};
  if (typeof x.e === "string") out.etag = x.e;
  if (typeof x.l === "string") out.lastModified = x.l;
  return out;
};

export const withValidators = (s: PollState, key: string, v: Validators | undefined): PollState => {
  const next: PollState = { ...s, v: { ...(s.v ?? {}) } };
  const e: { e?: string; l?: string } = {};
  if (v?.etag !== undefined && v.etag.length <= ETAG_MAX) e.e = v.etag;
  if (v?.lastModified !== undefined && v.lastModified.length <= MODIFIED_MAX) e.l = v.lastModified;
  if (e.e !== undefined || e.l !== undefined) next.v![key] = e;
  else delete next.v![key];
  if (Object.keys(next.v!).length === 0) delete next.v;
  return next;
};

// ---- experts and the facts of the priority function ---------------------------------------------------------

export type PollExpert = {
  id: string;
  name: string;
  status: PollFacts["status"];
  platforms: string[];
  handles: Record<string, string>;
  homeUrls: string[];
  noFeed: boolean;
  poll: PollState;
};

const json = <T>(text: unknown, fallback: T): T => {
  try {
    return JSON.parse(String(text)) as T;
  } catch {
    return fallback;
  }
};

const asExpert = (r: Record<string, unknown>): PollExpert => {
  const handles = json<Record<string, unknown>>(r.handles_json, {});
  return {
    id: String(r.id),
    name: String(r.name),
    status: String(r.status) as PollExpert["status"],
    platforms: json<unknown[]>(r.platforms_json, []).map(String),
    handles: Object.fromEntries(
      Object.entries(handles).filter(([, v]) => typeof v === "string") as [string, string][],
    ),
    homeUrls: json<unknown[]>(r.home_urls_json, []).map(String),
    noFeed: Number(r.no_feed) === 1,
    poll: parsePollJson(r.poll_json),
  };
};

const COLS = "id, name, status, platforms_json, handles_json, home_urls_json, no_feed, poll_json";

/** Tracked experts (the ones the job reads). */
export async function trackedExperts(db: Exec): Promise<PollExpert[]> {
  // rows-ok: the tracked set is capped at expert_tracked_max (150, bounds to 300); LIMIT 1000 is a guard
  const r = await db.execute(
    `SELECT ${COLS} FROM expert WHERE status = 'tracked' ORDER BY id LIMIT 1000`, // threshold-ok: far above the tracked cap
  );
  return r.rows.map((x) => asExpert(x as Record<string, unknown>));
}

export async function expertById(db: Exec, id: string): Promise<PollExpert | null> {
  // rows-ok: at most 1 row, by primary key
  const r = await db.execute({ sql: `SELECT ${COLS} FROM expert WHERE id = ?`, args: [id] });
  return r.rows.length === 0 ? null : asExpert(r.rows[0] as Record<string, unknown>);
}

/** Candidates, whatever their tier (the Sources page and discovery). */
export async function candidateExperts(db: Exec): Promise<PollExpert[]> {
  // rows-ok: candidates are few (discovery adds at most 10 a week and the Owner clears them); LIMIT 500 is a guard
  const r = await db.execute(
    `SELECT ${COLS} FROM expert WHERE status = 'candidate' ORDER BY id LIMIT 500`, // threshold-ok: guard
  );
  return r.rows.map((x) => asExpert(x as Record<string, unknown>));
}

/** Every expert, so discovery can tell a known person from a new one. */
export async function knownExperts(db: Exec): Promise<PollExpert[]> {
  // rows-ok: all experts, at most a few hundred (tracked cap 300 plus candidates and retired); read weekly
  const r = await db.execute(`SELECT ${COLS} FROM expert ORDER BY id LIMIT 2000`); // threshold-ok: guard
  return r.rows.map((x) => asExpert(x as Record<string, unknown>));
}

/** Screened-claim, rejected-claim and settled-call counts per expert (one grouped pass each). */
export async function pollFactsOf(db: Exec, experts: readonly PollExpert[]): Promise<PollFacts[]> {
  const claimsOf = new Map<string, { screened: number; rejected: number }>();
  // rows-ok: one row per expert with claims, at most 1000 (the guard of trackedExperts)
  const claims = await db.execute(
    `SELECT ce.expert_id AS id,
            SUM(CASE WHEN cs.status IN ('screened','challenger','promoted') THEN 1 ELSE 0 END) AS screened,
            SUM(CASE WHEN cs.status = 'rejected' THEN 1 ELSE 0 END) AS rejected
       FROM claim_expert ce
       JOIN claim_status cs ON cs.claim_id = ce.claim_id
        AND cs.seq = (SELECT MAX(m.seq) FROM claim_status m WHERE m.claim_id = ce.claim_id)
      GROUP BY ce.expert_id LIMIT 1000`, // threshold-ok: one row per expert
  );
  for (const r of claims.rows)
    claimsOf.set(String(r.id), { screened: Number(r.screened), rejected: Number(r.rejected) });
  const callsOf = new Map<string, { positive: number; settled: number }>();
  // rows-ok: one row per expert with settled calls, at most 1000
  const outcomes = await db.execute(
    `SELECT ce.expert_id AS id,
            SUM(CASE WHEN o.vs_market_ppm > 0 THEN 1 ELSE 0 END) AS positive, COUNT(*) AS settled
       FROM expert_call_outcome o JOIN claim_expert ce ON ce.claim_id = o.claim_id
      WHERE o.state <> 'no_bars' GROUP BY ce.expert_id LIMIT 1000`, // threshold-ok: one row per expert
  );
  for (const r of outcomes.rows)
    callsOf.set(String(r.id), { positive: Number(r.positive), settled: Number(r.settled) });
  return experts.map((e) => ({
    id: e.id,
    status: e.status,
    screened: claimsOf.get(e.id)?.screened ?? 0,
    rejected: claimsOf.get(e.id)?.rejected ?? 0,
    callsPositive: callsOf.get(e.id)?.positive ?? 0,
    callsSettled: callsOf.get(e.id)?.settled ?? 0,
    lastPolledAt: e.poll.p ?? null,
  }));
}

/** Writes the job's state back (the only columns the guard allows: poll_json and updated_at). */
export async function savePollState(db: Exec, id: string, s: PollState, at: string): Promise<void> {
  // rows-ok: one UPDATE of one row, by primary key
  await db.execute({
    sql: "UPDATE expert SET poll_json = ?, updated_at = ? WHERE id = ?",
    args: [buildPollJson(s), at, id],
  });
}

// ---- items ----------------------------------------------------------------------------------------------

/** source_item.id (0022): lower-case 64-hex sha256 of url + '|' + (content_hash ?? ''). */
export const itemId = (url: string): string => createHash("sha256").update(`${url}|`).digest("hex");

const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f]", "g");
const clean = (s: string, max: number): string =>
  s.replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, max);

export type NewItem = {
  expertId: string;
  url: string;
  platform: string;
  title: string;
  publishedAt: string | null;
  summary: string | null;
  ingestedAt: string;
};

/** Our own short line: the title and the host, never the post's text. */
export const ownSummary = (title: string, url: string): string => {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    host = "";
  }
  return clean(`${title}${host ? ` (${host})` : ""}`, SUMMARY_MAX);
};

/** One item, insert-or-ignore on its id. Returns true when it is new. A URL the column refuses (too long) is skipped. */
export async function insertItem(db: Exec, it: NewItem): Promise<boolean> {
  if (it.url.length < 8 || it.url.length > 500) return false; // threshold-ok: source_item.url cap (0022)
  // rows-ok: one INSERT of one row; a repeat of the same link is a no-op
  const r = await db.execute({
    sql: `INSERT INTO source_item (id, expert_id, url, platform, title, published_at, ingested_at, content_hash,
            summary, quote, kind, extraction_status)
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, 'other', 'pending') ON CONFLICT DO NOTHING`,
    args: [
      itemId(it.url),
      it.expertId,
      it.url,
      it.platform.slice(0, 40), // threshold-ok: source_item.platform cap (0022)
      clean(it.title, TITLE_MAX) || null,
      it.publishedAt,
      it.ingestedAt,
      it.summary === null ? null : clean(it.summary, SUMMARY_MAX),
    ],
  });
  return r.rowsAffected > 0;
}

export type PendingItem = { id: string; title: string; url: string; ingestedAt: string };

/** Items of one expert ingested after the watermark, oldest first. */
export async function itemsAfter(
  db: Exec,
  expertId: string,
  watermark: string,
  limit: number,
): Promise<PendingItem[]> {
  // rows-ok: at most `limit` rows (the day's extraction cap, at most 60), by the expert index
  const r = await db.execute({
    sql: `SELECT id, title, url, ingested_at FROM source_item
           WHERE expert_id = ? AND extraction_status = 'pending' AND ingested_at > ?
           ORDER BY ingested_at, id LIMIT ?`,
    args: [expertId, watermark, limit],
  });
  return r.rows.map((x) => ({
    id: String(x.id),
    title: x.title === null ? "" : String(x.title),
    url: String(x.url),
    ingestedAt: String(x.ingested_at),
  }));
}

// ---- job runs ---------------------------------------------------------------------------------------------

export async function runExists(db: Exec, kind: "poll" | "discovery", d: string): Promise<boolean> {
  // rows-ok: at most 1 row (LIMIT 1), by the primary key (kind, d)
  const r = await db.execute({
    sql: "SELECT 1 FROM expert_poll_run WHERE kind = ? AND d = ? LIMIT 1",
    args: [kind, d],
  });
  return r.rows.length > 0;
}

export async function recordRun(
  db: Exec,
  kind: "poll" | "discovery",
  d: string,
  counts: Record<string, number>,
  createdAt: string,
): Promise<void> {
  // rows-ok: one INSERT of one row (a second run on the same day keeps the first)
  await db.execute({
    sql: "INSERT OR IGNORE INTO expert_poll_run (kind, d, counts_json, created_at) VALUES (?, ?, ?, ?)",
    args: [kind, d, JSON.stringify(counts), createdAt],
  });
}

export async function lastRun(
  db: Exec,
  kind: "poll" | "discovery" | "licence",
): Promise<{ d: string; counts: Record<string, number> } | null> {
  // rows-ok: at most 1 row (LIMIT 1), newest day first by the primary key
  const r = await db.execute({
    sql: "SELECT d, counts_json FROM expert_poll_run WHERE kind = ? ORDER BY d DESC LIMIT 1",
    args: [kind],
  });
  const x = r.rows[0];
  if (x === undefined) return null;
  return { d: String(x.d), counts: json<Record<string, number>>(x.counts_json, {}) };
}
