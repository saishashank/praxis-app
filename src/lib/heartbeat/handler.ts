// GET /api/cron/heartbeat-morning and /heartbeat-evening handler (PLT-074). Opus reviews every line.
// Same shape as the watchdog route (src/lib/watchdog/handler.ts):
//   1. CRON_SECRET must be configured (>= 16 chars) or the answer is 503 before anything else;
//   2. the bearer is compared in constant time;
//   3. outside production it is a 200 no-op (staging never raises heartbeat incidents);
//   4. idempotent per Melbourne date: a finished check for `<job>:<date>` is not repeated;
//   5. runs the checks, writes a run record, and opens an S2 incident once per problem kind.
// Every failure body is generic: no secret, URL or upstream text is returned or logged.
import type { Client } from "@libsql/client";
import { finishRun, startRun } from "@/lib/runs/runRecord";
import { bearerMatches, isProduction, melbourneDate, type Env } from "@/lib/watchdog/handler";
import type { EmailProvider } from "@/lib/email/provider";
import {
  detectAsxTrip,
  detectDispatchAuth,
  detectDataQualityTwoNights,
  detectQuota,
  detectReviewMissing,
  type Detected,
} from "@/lib/incidents/detectors";
import { escalateIncidents } from "@/lib/incidents/escalate";
import { notifyIncident, type NotifyCtx } from "@/lib/incidents/notify";
import { sendTokensDue } from "@/lib/incidents/tokensDue";
import { runChecks, type CheckResult } from "./checks";
import { openS2Once } from "./incidents";
import { heartbeatJob, type HeartbeatKind } from "./state";

export type Deps = {
  env: Env;
  mainDb: () => Client;
  now: () => Date;
  /** Email provider and sleep for tests; production selects its own. */
  provider?: EmailProvider;
  sleep?: (ms: number) => Promise<void>;
};

const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

const has = (v: string | undefined): v is string => typeof v === "string" && v.trim() !== "";
const MIN_SECRET_LENGTH = 16;

async function alreadyDone(db: Client, key: string): Promise<boolean> {
  // "final" = the check completed and was acted on (ok, or problems with every incident written).
  // A failed lookup stays retryable by a manual call the same day.
  const res = await db.execute({
    sql: `SELECT 1 FROM run_record WHERE concurrency_key = ?
          AND json_extract(details_json, '$.final') = 1 LIMIT 1`,
    args: [key],
  });
  return res.rows.length > 0;
}

async function runExtras(
  kind: HeartbeatKind,
  db: Client,
  now: Date,
  deps: Deps,
  notify: Omit<NotifyCtx, "db" | "now">,
): Promise<string[]> {
  const found: Detected[] = [];
  const safe = async (f: () => Promise<Detected[]>) => {
    try {
      found.push(...(await f()));
    } catch {
      // a detector that cannot read stays silent; the checks above still ran
    }
  };
  await safe(() => detectAsxTrip(db));
  await safe(() => detectQuota(db, now, deps.env));
  await safe(() => detectDispatchAuth(db, now));
  if (kind === "evening") {
    await safe(() => detectDataQualityTwoNights(db));
    await safe(() => detectReviewMissing(db, now));
  }
  const opened: string[] = [];
  for (const f of found) {
    try {
      const r = await notifyIncident(
        { ...notify, db, now: () => now },
        f.kind,
        f.severity,
        f.facts,
      );
      if (r.opened) opened.push(f.kind);
    } catch {
      // incident row could not be written; the next run finds the same condition
    }
  }
  if (kind === "evening") {
    try {
      await escalateIncidents({ ...notify, db, now: () => now });
    } catch {
      // retried by the next evening run
    }
    try {
      await sendTokensDue({ ...notify, db, now: () => now });
    } catch {
      // the key is per day; a manual re-run the same day sends it
    }
  }
  return opened;
}

export function createHeartbeatHandler(kind: HeartbeatKind, deps: Deps) {
  const job = heartbeatJob(kind);
  return async function handle(req: Request): Promise<Response> {
    try {
      const secret = deps.env.CRON_SECRET;
      if (!has(secret) || secret.length < MIN_SECRET_LENGTH) {
        return json(503, { error: "unavailable" });
      }
      if (!bearerMatches(req.headers.get("authorization"), secret)) {
        return json(401, { error: "unauthorized" });
      }
      if (!isProduction(deps.env)) return json(200, { skipped: "not production" });

      const now = deps.now();
      const date = melbourneDate(now);
      const key = `${job}:${date}`;
      const db = deps.mainDb();
      if (await alreadyDone(db, key)) return json(200, { skipped: "already ran", date });

      const runId = await startRun(db, {
        job,
        market: "AU",
        concurrencyKey: key,
        scheduledFor: date,
        now: now.toISOString(),
      });

      let checks: CheckResult | null;
      try {
        checks = await runChecks(kind, db, now);
      } catch {
        checks = null;
      }
      if (checks === null) {
        await finishRun(db, runId, {
          status: "failed",
          itemsProcessed: 0,
          errorSummary: "Check could not read the database.",
          details: { check: kind, status: "unknown", final: false },
        });
        return json(200, { status: "unknown", date });
      }

      const opened: string[] = [];
      const notifyCtx: Omit<NotifyCtx, "db" | "now"> = {
        env: deps.env,
        provider: deps.provider,
        sleep: deps.sleep,
      };
      let writeFailed = false;
      for (const p of checks.problems) {
        try {
          if (await openS2Once(db, p.kind, p.detail, now.toISOString(), notifyCtx, p.text)) {
            opened.push(p.kind);
          }
        } catch {
          writeFailed = true;
        }
      }
      // Detectors without a writer of their own, then (evening) the review record, escalation and
      // tokens due. A failure in any of them never fails the heartbeat run (M5 T11).
      const extra = await runExtras(kind, db, now, deps, notifyCtx);
      opened.push(...extra);
      const ok = checks.problems.length === 0;
      await finishRun(db, runId, {
        status: ok ? "success" : "failed",
        itemsProcessed: 1,
        ...(ok ? {} : { errorSummary: checks.problems.map((p) => p.text).join(" ") }),
        details: {
          check: kind,
          status: ok ? "ok" : "problems",
          sydneyDate: checks.date,
          problems: checks.problems.map((p) => p.kind),
          opened,
          notes: checks.notes,
          ...(writeFailed ? { incidentWriteFailed: true } : {}),
          final: !writeFailed,
        },
      });
      return json(200, { status: ok ? "ok" : "problems", date });
    } catch {
      return json(503, { error: "unavailable" });
    }
  };
}
