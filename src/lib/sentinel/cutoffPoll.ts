// GL-05 (D-207 item 5): the "first completed announcement poll after the 18:10 cut-off" marker
// and the ingest bound a decision on session D uses for announcements.
//
// Marker: one `worker_state` row per session, `cutoff_poll:<market>:<d>`, value = JSON ISO instant of
// the completion of the first poll that STARTED at or after the cut-off and whose items are stored.
// Insert-once (ON CONFLICT DO NOTHING), so a later poll never moves it. Written by the ASX store
// step (src/lib/data/asxIngest.ts) and by the Worker's own poll (worker/src/asx/slots.ts).
//
// Bound: an announcement ingested for the first time after `ingestBound` did not exist for the
// decision. The bound is the marker time when the marker landed inside the 4-minute window after the
// cut-off, otherwise cut-off + 4 minutes (marker missing or late). Batch 2b waits for the marker at
// most until that same instant, so a live run and a replay see the same set (no look-ahead).
import type { Client } from "@libsql/client";

type Reader = Pick<Client, "execute">;

/** The most batch 2b waits for the marker, counted from the cut-off (GL-05, "narrowed" window). */
export const CUTOFF_POLL_WINDOW_MS = 4 * 60_000;

export const cutoffPollKey = (market: string, d: string): string => `cutoff_poll:${market}:${d}`;

/** The insert-once marker statement (shared SQL text with the Worker's copy). */
export function cutoffPollStatement(
  market: string,
  d: string,
  completedAtIso: string,
): { sql: string; args: string[] } {
  return {
    sql:
      "INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT (key) DO NOTHING",
    args: [cutoffPollKey(market, d), JSON.stringify(completedAtIso), completedAtIso],
  };
}

/** The instant the wait and the ingest bound end: cut-off + 4 minutes, as ISO UTC text. */
export function cutoffWindowEnd(cutoffIso: string): string {
  return new Date(Date.parse(cutoffIso) + CUTOFF_POLL_WINDOW_MS).toISOString();
}

/** The stored marker instant, or null when absent or unreadable. */
export async function readCutoffPoll(
  db: Reader,
  market: string,
  d: string,
): Promise<string | null> {
  try {
    const rs = await db.execute({
      sql: "SELECT value_json FROM worker_state WHERE key = ?",
      args: [cutoffPollKey(market, d)],
    });
    if (rs.rows.length === 0) return null;
    const v: unknown = JSON.parse(String(rs.rows[0].value_json));
    return typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null;
  } catch {
    return null;
  }
}

/**
 * The marker usable for the decision: present and completed inside [cut-off, cut-off + 4 min].
 * A marker from before the cut-off is impossible by construction and treated as absent.
 */
export function validCutoffPoll(markerIso: string | null, cutoffIso: string): string | null {
  if (markerIso === null) return null;
  const t = Date.parse(markerIso);
  const c = Date.parse(cutoffIso);
  return t >= c && t <= c + CUTOFF_POLL_WINDOW_MS ? markerIso : null;
}

/** The ingest bound for announcements of the decision: the valid marker, else cut-off + 4 min. */
export function announcementIngestBound(markerIso: string | null, cutoffIso: string): string {
  return validCutoffPoll(markerIso, cutoffIso) ?? cutoffWindowEnd(cutoffIso);
}

/** Reads the marker and returns the bound plus whether the marker was missing (late counts as missing). */
export async function loadIngestBound(
  db: Reader,
  market: string,
  d: string,
  cutoffIso: string,
): Promise<{ bound: string; missing: boolean }> {
  const marker = validCutoffPoll(await readCutoffPoll(db, market, d), cutoffIso);
  return { bound: marker ?? cutoffWindowEnd(cutoffIso), missing: marker === null };
}

/**
 * Batch 2b's bounded wait. Returns as soon as a valid marker exists, or when `nowMs()` reaches the end
 * of the window: cut-off + 4 minutes (absolute: a run that starts late waits less, or not at all) and
 * never more than 4 minutes from the call. The loop also has an iteration cap, so a stopped clock
 * cannot stall the chain. Never throws. Returns true when the marker was found.
 */
export async function waitForCutoffPoll(
  db: Reader,
  o: {
    readonly market: string;
    readonly d: string;
    readonly cutoffIso: string;
    readonly nowMs: () => number;
    readonly sleep: (ms: number) => Promise<void>;
    readonly pollMs?: number;
  },
): Promise<boolean> {
  const end = Math.min(Date.parse(o.cutoffIso), o.nowMs()) + CUTOFF_POLL_WINDOW_MS;
  const step = o.pollMs ?? 15_000;
  const maxLoops = Math.ceil(CUTOFF_POLL_WINDOW_MS / step) + 1;
  for (let i = 0; i <= maxLoops; i++) {
    if (validCutoffPoll(await readCutoffPoll(db, o.market, o.d), o.cutoffIso) !== null) return true;
    const left = end - o.nowMs();
    if (left <= 0) return false;
    await o.sleep(Math.min(step, left));
  }
  return false;
}
