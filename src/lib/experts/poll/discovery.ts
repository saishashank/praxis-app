// Discovery of new experts (M22 E2; DAT-229, D-1433, D-1479). Runs on Sundays (Melbourne) from the experts job. The only input is
// what the tracked experts' own items say: an `@handle` that two different tracked experts' recent titles both name is a
// co-mention. A handle that is not already an expert (by handle or by name) becomes a `candidate` of tier `discovered`
// with its co-mention facts in `poll_json`; at most ten new ones a week and never past `expert_tracked_max` together with the
// tracked set. Platform search APIs stay blocked (no register row is enabled), so nothing is fetched here: no network at all.
// The red-flag check is not run by machine: the page says "manual check needed". A candidate becomes `tracked` only on the
// Owner's audited approval (candidates.ts); a dismissed one is `retired` and is never proposed again (the id is the handle's
// hash, so a repeat is a no-op).
import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import { getConfig } from "@/lib/config/store";
import { candidateExperts, knownExperts, buildPollJson, recordRun, runExists } from "./store";

export const MENTION_MIN_EXPERTS = 2; // threshold-ok: distinct tracked experts that must name a handle
export const MAX_NEW_PER_WEEK = 10; // threshold-ok: candidates added in one weekly run
export const LOOKBACK_DAYS = 30; // threshold-ok: titles read are from the last month
const TITLE_ROWS_MAX = 2000; // threshold-ok: guard on the titles read in one run
const HANDLE = /(?<![\w@])@([A-Za-z0-9][A-Za-z0-9_.-]{2,29})(?![\w@])/g;
const DAY_MS = 86_400_000; // threshold-ok: ms per day

export type Mention = { handle: string; experts: string[]; count: number };

/** Pure: the handles named by at least `min` distinct experts, most named first, then by handle. */
export function coMentions(
  rows: readonly { expertId: string; title: string }[],
  min = MENTION_MIN_EXPERTS,
): Mention[] {
  const by = new Map<string, { experts: Set<string>; count: number }>();
  for (const r of rows) {
    const seen = new Set<string>();
    for (const m of r.title.matchAll(HANDLE)) {
      const h = m[1]!.toLowerCase();
      if (seen.has(h)) continue;
      seen.add(h);
      const x = by.get(h) ?? { experts: new Set<string>(), count: 0 };
      x.experts.add(r.expertId);
      x.count += 1;
      by.set(h, x);
    }
  }
  return [...by.entries()]
    .filter(([, x]) => x.experts.size >= min)
    .map(([handle, x]) => ({ handle, experts: [...x.experts].sort(), count: x.count }))
    .sort(
      (a, b) =>
        b.experts.length - a.experts.length || b.count - a.count || (a.handle < b.handle ? -1 : 1),
    );
}

export const candidateId = (handle: string): string =>
  `D-${createHash("sha256").update(handle.toLowerCase()).digest("hex").slice(0, 12)}`;

export type DiscoveryReport = {
  skipped: "already_ran" | "full" | null;
  considered: number;
  added: number;
  known: number;
};

export type DiscoveryDeps = { now?: () => Date; day?: string };

export async function runDiscovery(db: Client, deps: DiscoveryDeps = {}): Promise<DiscoveryReport> {
  const now = deps.now ?? (() => new Date());
  const day = deps.day ?? now().toISOString().slice(0, 10);
  if (await runExists(db, "discovery", day))
    return { skipped: "already_ran", considered: 0, added: 0, known: 0 };
  const max = Number(await getConfig(db, "expert_tracked_max"));
  const experts = await knownExperts(db);
  const tracked = experts.filter((e) => e.status === "tracked");
  const open = (await candidateExperts(db)).length;
  const room = Math.max(0, max - tracked.length - open);
  const since = new Date(Date.parse(`${day}T00:00:00.000Z`) - LOOKBACK_DAYS * DAY_MS).toISOString();
  // rows-ok: at most 2000 rows (TITLE_ROWS_MAX); a weekly scan of source_item for titles that name a handle
  const r = await db.execute({
    sql: `SELECT i.expert_id AS expert_id, i.title AS title FROM source_item i
            JOIN expert e ON e.id = i.expert_id AND e.status = 'tracked'
           WHERE i.ingested_at >= ? AND i.title LIKE '%@%' LIMIT ?`,
    args: [since, TITLE_ROWS_MAX],
  });
  const mentions = coMentions(
    r.rows.map((x) => ({ expertId: String(x.expert_id), title: String(x.title) })),
  );
  const handles = new Set<string>();
  const names = new Set<string>();
  for (const e of experts) {
    for (const h of Object.values(e.handles)) handles.add(h.toLowerCase().replace(/^@/, ""));
    names.add(e.name.toLowerCase().replace(/^@/, ""));
  }
  const rep: DiscoveryReport = { skipped: null, considered: mentions.length, added: 0, known: 0 };
  const stamp = now().toISOString();
  for (const m of mentions) {
    if (handles.has(m.handle) || names.has(m.handle)) {
      rep.known += 1;
      continue;
    }
    if (rep.added >= MAX_NEW_PER_WEEK || rep.added >= room) {
      if (room === 0) rep.skipped = "full";
      break;
    }
    // rows-ok: one INSERT of one row; a handle seen before (candidate, tracked or dismissed) is a no-op by its id
    const ins = await db.execute({
      sql: `INSERT INTO expert (id, name, platforms_json, handles_json, home_urls_json, markets_json, focus_json,
              licence_status, status, tier, no_feed, poll_json, created_at, updated_at)
            VALUES (?, ?, '[]', '{}', '[]', '[]', '[]', 'unchecked', 'candidate', 'discovered', 0, ?, ?, ?)
            ON CONFLICT DO NOTHING`,
      args: [
        candidateId(m.handle),
        `@${m.handle}`,
        buildPollJson({ disc: { n: m.count, by: m.experts.slice(0, 5), d: day } }), // threshold-ok: names kept per candidate
        stamp,
        stamp,
      ],
    });
    if (ins.rowsAffected > 0) rep.added += 1;
  }
  await recordRun(
    db,
    "discovery",
    day,
    { considered: rep.considered, added: rep.added, known: rep.known },
    stamp,
  );
  return rep;
}
