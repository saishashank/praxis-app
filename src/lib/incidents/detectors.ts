// Read-only detectors for the incident kinds that have no writer of their own (M5 T11, design 4.8,
// OPS-011): ASX trip (decision 8), data-quality gate failing two consecutive nights (DAT-210,
// D-063), quota at 90 percent or more and degrade mode (PLT-051), and the evening-heartbeat email
// record check (Evening Review sent). They return facts; the heartbeat handler passes them to
// notifyIncident. The LLM provider's daily quota (rules-only mode) is not a quota incident: it is
// section 9 only (EML-021), so the LLM meter is left out.
import type { Client } from "@libsql/client";
import { getConfig } from "@/lib/config/store";
import { ASX_SOURCE_ID } from "@/lib/data/controls";
import { melbourneDate, emailKeys } from "@/lib/email/keys";
import { readEmailSwitch, reviewCheckForced } from "@/lib/email/switch";
import { getMeters, usageEnvironment, type Meter } from "@/lib/usage/meters";
import type { IncidentFacts } from "./notify";

export type Detected = { kind: string; severity: "S1" | "S2"; facts: IncidentFacts };

export async function detectAsxTrip(db: Client): Promise<Detected[]> {
  const r = await db.execute({
    sql: "SELECT mode, since FROM source_status WHERE source = ?",
    args: [ASX_SOURCE_ID],
  });
  if (r.rows[0]?.mode !== "tripped") return [];
  return [
    {
      kind: "asx_trip",
      severity: "S2",
      facts: {
        summary: "The ASX source tripped on errors and is off until reset",
        detail: { since: String(r.rows[0].since) },
      },
    },
  ];
}

/** The last two U1 quality scores both failed the gate (nights are the stored trading dates). */
export async function detectDataQualityTwoNights(db: Client, market = "AU"): Promise<Detected[]> {
  const r = await db.execute({
    sql: "SELECT d, gate_pass FROM quality_score WHERE market = ? AND tier = 'U1' ORDER BY d DESC LIMIT 2",
    args: [market],
  });
  if (r.rows.length < 2 || r.rows.some((x) => Number(x.gate_pass) !== 0)) return [];
  const [a, b] = [String(r.rows[0].d), String(r.rows[1].d)];
  return [
    {
      kind: "data_quality_two_nights",
      severity: "S2",
      facts: {
        summary: `The U1 data-quality gate failed on ${b} and ${a}`,
        detail: { market, nights: [b, a] },
      },
    },
  ];
}

const QUOTA_METER_SKIP = new Set(["llm-tokens"]);

export async function detectQuota(
  db: Client,
  now: Date,
  env: Record<string, string | undefined>,
): Promise<Detected[]> {
  const meters: Meter[] = (await getMeters(db, now, usageEnvironment(env))).filter(
    (m) => !QUOTA_METER_SKIP.has(m.id),
  );
  const out: Detected[] = [];
  const high = meters.filter((m) => m.level === "alert" || m.level === "degrade");
  if (high.length > 0) {
    out.push({
      kind: "quota_high",
      severity: "S2",
      facts: {
        summary: `Quota at ${Math.round(Math.max(...high.map((m) => m.ratio ?? 0)) * 100)} percent: ${high.map((m) => m.label).join(", ")}`,
        detail: { meters: high.map((m) => m.id) },
      },
    });
  }
  const deg = meters.filter((m) => m.level === "degrade");
  if (deg.length > 0) {
    out.push({
      kind: "degrade_mode",
      severity: "S2",
      facts: {
        summary: `Degrade mode: ${deg.map((m) => m.label).join(", ")}`,
        detail: { meters: deg.map((m) => m.id) },
      },
    });
  }
  return out;
}

/**
 * Evening heartbeat (design 4.8): no `review:<d>` email with status `sent` -> S2 `review_missing`.
 * Checked only when a review is expected: `email_mode` full with no data-only market, or the
 * one-off forced review date = d. A paused review is not missing. A late send counts as sent
 * (decision 33).
 */
export async function detectReviewMissing(db: Client, now: Date): Promise<Detected[]> {
  const d = melbourneDate(now);
  const sw = await readEmailSwitch(db, d);
  let expected = reviewCheckForced(sw, d);
  if (!expected && sw.mode === "full") {
    const dm = await db.execute("SELECT COUNT(*) AS n FROM market WHERE mode = 'data_only'");
    expected = Number(dm.rows[0].n) === 0;
  }
  if (!expected) return [];
  if ((await getConfig(db, "evening_review_paused")) === "on") return [];
  const r = await db.execute({
    sql: "SELECT 1 FROM email_message WHERE email_key = ? AND status = 'sent' LIMIT 1",
    args: [emailKeys.review(d)],
  });
  if (r.rows.length > 0) return [];
  return [
    {
      kind: "review_missing",
      severity: "S2",
      facts: { summary: `No Evening Review email was sent for ${d}`, detail: { d } },
    },
  ];
}

/**
 * GL-06: a `dispatch-failed` run record of the last 24 hours whose HTTP status is 401 or 403 (the
 * Worker's GitHub dispatch token was refused) is a credential problem: S2 the same night, from the
 * next heartbeat. One incident while open (notifyIncident); other statuses stay with the
 * heartbeat checks. Reads the structured `status` the Worker records; details hold no secrets.
 */
export async function detectDispatchAuth(db: Client, now: Date): Promise<Detected[]> {
  const since = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const r = await db.execute({
    sql: `SELECT concurrency_key, json_extract(details_json, '$.slot') AS slot,
                 json_extract(details_json, '$.status') AS status
          FROM run_record
          WHERE status = 'failed' AND concurrency_key LIKE 'dispatch-failed:%' AND started_at >= ?
            AND json_extract(details_json, '$.status') IN (401, 403)
          ORDER BY started_at DESC LIMIT 20`,
    args: [since],
  });
  if (r.rows.length === 0) return [];
  const slots = [...new Set(r.rows.map((x) => String(x.slot)))].sort();
  return [
    {
      kind: "dispatch_auth",
      severity: "S2",
      facts: {
        summary: `The Worker's GitHub dispatch was refused (HTTP ${Number(r.rows[0].status)}) for ${slots.join(", ")}`,
        detail: { slots, status: Number(r.rows[0].status), key: String(r.rows[0].concurrency_key) },
      },
    },
  ];
}
