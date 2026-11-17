// What the Sources page shows (M22 E2; UXN-296, KB-082, D-1480): per expert the state of each source in words, the last time
// it was read, how many items we hold, and how many wait for a model; and the discovery candidates with their co-mention facts.
// Read only. Every statement names its cap (`rows-ok:`); the scans are over source_item by design and run only when the
// Owner opens the page. No page text exists to show: an item is a link and a title.
import type { Client } from "@libsql/client";
import { sourcesOf, type LicenceSource } from "@/lib/experts/licence/engine.mjs";
import { licenceWords, type LicenceFacts } from "@/lib/experts/licence/policy";
import { feedUrlOf } from "./job";
import { candidateExperts, lastRun, trackedExperts } from "./store";

type Exec = Pick<Client, "execute">;

export type SourceLine = { label: string; words: string; reading: boolean };
export type ExpertSources = {
  id: string;
  name: string;
  sources: SourceLine[];
  /** Day the expert was last read (YYYY-MM-DD) or null. */
  lastRead: string | null;
  items: number;
  waiting: number;
};
export type CandidateLine = {
  id: string;
  name: string;
  mentions: number;
  namedBy: number;
  seenD: string | null;
  /** Hidden until this day, or null when it is up for a decision. */
  snoozedUntil: string | null;
};
export type SourcesView = {
  experts: ExpertSources[];
  candidates: CandidateLine[];
  waitingTotal: number;
  lastPollDay: string | null;
  lastDiscoveryDay: string | null;
};

const LICENCE_MAX = 3000; // threshold-ok: ten sources for each of 300 experts, the most the keys allow

/** The label shown for a source: the platform name with its handle, or the site's host. */
export function labelOf(s: LicenceSource): string {
  if (s.kind === "site") {
    try {
      return new URL(s.key).hostname;
    } catch {
      return "a website";
    }
  }
  const i = s.key.indexOf(":");
  const platform = s.key.slice(0, i);
  return `${platform.charAt(0).toUpperCase()}${platform.slice(1)} ${s.key.slice(i + 1)}`;
}

async function latestLicences(db: Exec): Promise<Map<string, LicenceFacts>> {
  // rows-ok: at most 3000 rows (LICENCE_MAX): the newest row of every source, by the primary key
  const r = await db.execute({
    sql: `SELECT expert_id, source_key, robots, summarisation, status
            FROM expert_source_licence l
           WHERE l.checked_at = (SELECT MAX(m.checked_at) FROM expert_source_licence m
                                  WHERE m.expert_id = l.expert_id AND m.source_key = l.source_key)
           LIMIT ?`,
    args: [LICENCE_MAX],
  });
  const out = new Map<string, LicenceFacts>();
  for (const x of r.rows) {
    out.set(`${String(x.expert_id)}\u0000${String(x.source_key)}`, {
      status: String(x.status) as LicenceFacts["status"],
      robots: String(x.robots) as LicenceFacts["robots"],
      summarisation: String(x.summarisation) as LicenceFacts["summarisation"],
    });
  }
  return out;
}

export async function loadSourcesView(db: Exec, today: string): Promise<SourcesView> {
  const experts = await trackedExperts(db as Client);
  const licences = await latestLicences(db);
  // rows-ok: one row per expert with items, at most 1000; counts by the expert index (a scan of source_item, Owner page only)
  const counts = await db.execute(
    "SELECT expert_id, COUNT(*) AS n FROM source_item GROUP BY expert_id LIMIT 1000", // threshold-ok: guard
  );
  const items = new Map(counts.rows.map((x) => [String(x.expert_id), Number(x.n)]));
  // rows-ok: one row per expert with items after its watermark, at most 1000
  const wait = await db.execute(
    `SELECT i.expert_id AS expert_id, COUNT(*) AS n FROM source_item i JOIN expert e ON e.id = i.expert_id
      WHERE e.status = 'tracked' AND i.extraction_status = 'pending'
        AND i.ingested_at > COALESCE(json_extract(e.poll_json, '$.tri'), '')
      GROUP BY i.expert_id LIMIT 1000`, // threshold-ok: guard
  );
  const waiting = new Map(wait.rows.map((x) => [String(x.expert_id), Number(x.n)]));
  const rows: ExpertSources[] = experts.map((e) => ({
    id: e.id,
    name: e.name,
    sources: sourcesOf(e).map((s) => {
      const lic = licences.get(`${e.id}\u0000${s.key}`) ?? null;
      const fetchable = feedUrlOf(s) !== null;
      return {
        label: labelOf(s),
        words: licenceWords(lic, s.manual, fetchable),
        reading:
          fetchable &&
          lic !== null &&
          (lic.status === "enabled" || lic.status === "owner-accepted-risk"),
      };
    }),
    lastRead: e.poll.p === undefined ? null : e.poll.p.slice(0, 10),
    items: items.get(e.id) ?? 0,
    waiting: waiting.get(e.id) ?? 0,
  }));
  const cands = await candidateExperts(db as Client);
  const candidates: CandidateLine[] = cands.map((c) => ({
    id: c.id,
    name: c.name,
    mentions: c.poll.disc?.n ?? 0,
    namedBy: c.poll.disc?.by.length ?? 0,
    seenD: c.poll.disc?.d ?? null,
    snoozedUntil: c.poll.snz !== undefined && c.poll.snz > today ? c.poll.snz : null,
  }));
  return {
    experts: rows,
    candidates,
    waitingTotal: rows.reduce((a, r) => a + r.waiting, 0),
    lastPollDay: (await lastRun(db, "poll"))?.d ?? null,
    lastDiscoveryDay: (await lastRun(db, "discovery"))?.d ?? null,
  };
}
