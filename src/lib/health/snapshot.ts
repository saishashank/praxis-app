// Health facts, daily snapshot and snooze filter (M5 T13, design 4.7, decisions 28 and D-097).
//
// gatherHealthFacts reads what PLT-061 lists (never throws: a failed read becomes a fact such as
// dbReadable=false). writeReminderSnapshot stores the nine components once per Melbourne date
// (`health_snapshot` purpose `reminder`, append-only, INSERT OR IGNORE) in exactly the JSON shape
// src/lib/health/attention.ts parses, plus `reason`, `since_d`, `fix` and `fix_path` per item, which
// Evening Review section 9 reads. openItems applies the snooze rules.
import type { Client } from "@libsql/client";
import { getConfig } from "@/lib/config/store";
import { readEmailSwitch } from "@/lib/email/switch";
import { CREDENTIAL_NAMES } from "@/lib/sentinel/schema";
import { getMeters, usageEnvironment, worstMeter } from "@/lib/usage/meters";
import {
  daysUntil,
  type ComponentResult,
  type HealthFacts,
  type HealthItem,
  type JobFact,
  type LevelFact,
} from "./components";
import { getHealthSummary } from "./summary";

type Db = Pick<Client, "execute">;
export const SNOOZE_DEADLINE_GUARD_DAYS = 2; // mirrors controls.ts (EML-023)

export async function gatherHealthFacts(
  db: Client,
  now: Date,
  today: string,
  env: Record<string, string | undefined>,
): Promise<HealthFacts> {
  const f: HealthFacts = {
    today,
    nowMs: now.getTime(),
    marketActive: false,
    sentinelLastOkAt: null,
    jobs: {},
    quality: null,
    llmLevel: "no data",
    emailMode: "off",
    lastReview: null,
    dbReadable: true,
    storageLevel: "no data",
    watchdog: "no data",
    failedSecrets: [],
    credentials: [],
    quotaLevel: "no data",
  };
  try {
    const m = await db.execute({ sql: "SELECT mode FROM market WHERE code = 'AU'", args: [] });
    f.marketActive = m.rows.length > 0 && String(m.rows[0]!.mode) === "full";
    const s = await db.execute({
      sql: "SELECT MAX(last_ok_at) AS t FROM sentinel_poll_day WHERE market = 'AU'",
      args: [],
    });
    f.sentinelLastOkAt = s.rows[0]?.t ? String(s.rows[0].t) : null;
    f.emailMode = (await readEmailSwitch(db, today)).mode;
    const r = await db.execute({
      sql:
        "SELECT d, status FROM email_message WHERE kind = 'review' " +
        "AND status IN ('sent','failed','claimed') ORDER BY d DESC LIMIT 1",
      args: [],
    });
    f.lastReview = r.rows.length
      ? { d: String(r.rows[0]!.d), status: String(r.rows[0]!.status) }
      : null;
    const cr = await db.execute({
      sql: "SELECT name, expires_on FROM credential_expiry",
      args: [],
    });
    f.credentials = cr.rows.map((x) => ({
      name: String(x.name),
      label: (CREDENTIAL_NAMES as Record<string, string>)[String(x.name)] ?? String(x.name),
      expiresOn: String(x.expires_on),
    }));
  } catch {
    f.dbReadable = false;
  }
  try {
    const sum = await getHealthSummary(db, now, "owner", env);
    for (const j of sum.jobs) f.jobs[j.job] = j.state as JobFact;
    f.watchdog = sum.watchdog.status;
    const q = sum.quality;
    f.quality = q
      ? {
          gateFails: q.tiers.filter((t) => !t.gatePass).length,
          blockingFlags: q.rules.filter((x) => x.blocksEntries).reduce((n, x) => n + x.count, 0),
        }
      : null;
    for (const set of [sum.secrets, sum.workerSecrets]) {
      for (const x of set?.results ?? []) if (!x.ok && !x.pending) f.failedSecrets.push(x.name);
    }
  } catch {
    f.dbReadable = false;
  }
  try {
    const meters = await getMeters(db, now, usageEnvironment(env));
    const lvl = (id: string): LevelFact => meters.find((x) => x.id === id)?.level ?? "no data";
    f.llmLevel = lvl("llm-tokens");
    f.storageLevel = lvl("turso-storage");
    f.quotaLevel = worstMeter(meters).level;
  } catch {
    // meters unreadable: levels stay "no data"
  }
  return f;
}

export interface SnapshotItem extends HealthItem {
  since_d: string;
}
export interface SnapshotComponent {
  id: ComponentResult["id"];
  state: ComponentResult["state"];
  reason: string;
  items: SnapshotItem[];
}
export interface Snapshot {
  components: SnapshotComponent[];
}

/** The newest `reminder` snapshot before `d`, or null. Unreadable = null. */
export async function loadPreviousSnapshot(db: Db, d: string): Promise<Snapshot | null> {
  try {
    const r = await db.execute({
      sql: "SELECT components_json FROM health_snapshot WHERE purpose = 'reminder' AND d < ? ORDER BY d DESC LIMIT 1",
      args: [d],
    });
    if (!r.rows.length) return null;
    const p = JSON.parse(String(r.rows[0]!.components_json)) as Snapshot;
    return Array.isArray(p.components) ? p : null;
  } catch {
    return null;
  }
}

/** Adds `since_d`: the previous snapshot's value while the item stays open, else today. */
export function buildSnapshot(
  results: ComponentResult[],
  prev: Snapshot | null,
  today: string,
): Snapshot {
  const since = new Map<string, string>();
  for (const c of prev?.components ?? []) {
    for (const it of c.items ?? []) {
      if (typeof it.since_d === "string") since.set(`${c.id}:${it.key}`, it.since_d);
    }
  }
  return {
    components: results.map((c) => ({
      id: c.id,
      state: c.state,
      reason: c.reason,
      items: c.items.map((it) => ({ ...it, since_d: since.get(`${c.id}:${it.key}`) ?? today })),
    })),
  };
}

/** Stores today's snapshot once (append-only). Returns what is stored for the date. */
export async function writeReminderSnapshot(db: Db, d: string, snap: Snapshot): Promise<Snapshot> {
  await db.execute({
    sql: "INSERT OR IGNORE INTO health_snapshot (d, purpose, components_json) VALUES (?, 'reminder', ?)",
    args: [d, JSON.stringify(snap)],
  });
  const r = await db.execute({
    sql: "SELECT components_json FROM health_snapshot WHERE d = ? AND purpose = 'reminder'",
    args: [d],
  });
  return r.rows.length ? (JSON.parse(String(r.rows[0]!.components_json)) as Snapshot) : snap;
}

export interface OpenItem extends SnapshotItem {
  component: ComponentResult["id"];
  daysOpen: number;
}

/** Amber items cannot stay snoozed once red or within the deadline guard (snooze "ends on change"). */
export function snoozeApplies(
  it: Pick<HealthItem, "state" | "deadline_d">,
  today: string,
): boolean {
  if (it.state !== "attention") return false;
  return it.deadline_d === null || daysUntil(today, it.deadline_d) > SNOOZE_DEADLINE_GUARD_DAYS;
}

/** Snapshot items that are amber or red and not covered by an active snooze, worst first. */
export async function openItems(db: Db, snap: Snapshot, today: string): Promise<OpenItem[]> {
  const sn = await db.execute({
    sql: "SELECT component, item_key FROM attention_snooze WHERE from_d <= ? AND until_d >= ?",
    args: [today, today],
  });
  const snoozed = new Set(sn.rows.map((r) => `${r.component}:${r.item_key}`));
  const out: OpenItem[] = [];
  for (const c of snap.components) {
    for (const it of c.items) {
      if (snoozed.has(`${c.id}:${it.key}`) && snoozeApplies(it, today)) continue;
      const days = Math.max(1, Math.round(daysUntil(it.since_d, today)) + 1);
      out.push({ ...it, component: c.id, daysOpen: days });
    }
  }
  return out.sort(
    (a, b) =>
      Number(b.state === "down") - Number(a.state === "down") ||
      b.daysOpen - a.daysOpen ||
      a.key.localeCompare(b.key),
  );
}

/** Labels of items in the previous snapshot that are no longer open (all items, snoozed or not). */
export function resolvedSince(prev: Snapshot | null, snap: Snapshot): string[] {
  const now = new Set(snap.components.flatMap((c) => c.items.map((i) => `${c.id}:${i.key}`)));
  return (prev?.components ?? [])
    .flatMap((c) => (c.items ?? []).map((i) => ({ k: `${c.id}:${i.key}`, label: i.label })))
    .filter((x) => !now.has(x.k))
    .map((x) => x.label);
}

export async function reminderEnabled(db: Client): Promise<boolean> {
  return (await getConfig(db, "attention_reminder_enabled")) !== "off";
}
