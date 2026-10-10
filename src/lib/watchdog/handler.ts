// GET /api/cron/watchdog handler (PLT-074, SEC-108 d, SEC-017). Opus reviews every line.
// Vercel Cron calls GET with `Authorization: Bearer ${CRON_SECRET}` (platform design). The route:
//   1. CRON_SECRET must be configured (>= 16 chars) or the answer is 503 before anything else;
//   2. the bearer is compared in constant time (both sides hashed first, so length leaks nothing);
//   3. outside production it is a 200 no-op (staging never raises heartbeat incidents);
//   4. idempotent per Melbourne date: a finished check for `watchdog:<date>` is not repeated;
//   5. runs the check, writes a run record, and on "mismatch" opens an S1 incident once.
// Every failure body is generic: no secret, SHA, URL or upstream text is returned or logged.
import { createHash, timingSafeEqual } from "node:crypto";
import type { Client } from "@libsql/client";
import { finishRun, startRun } from "@/lib/runs/runRecord";
import { CHECK_TIMEOUT_MS, CODE_REPO } from "@/lib/selfcheck/config";
import { checkApprovedCommit, type WatchdogResult } from "./approvedCommit";
import { KIND_UNAPPROVED_CODE, openS1Once } from "./incidents";
import { WATCHDOG_JOB } from "./state";

export type Env = Record<string, string | undefined>;

export type Deps = {
  env: Env;
  fetchImpl: typeof fetch;
  mainDb: () => Client;
  now: () => Date;
};

const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

const has = (v: string | undefined): v is string => typeof v === "string" && v.trim() !== "";

/** Production = BACKUP_PUBLIC_KEY present (only production holds it) and no TEST_IDENTITY_SECRET. */
export function isProduction(env: Env): boolean {
  return has(env.BACKUP_PUBLIC_KEY) && !has(env.TEST_IDENTITY_SECRET);
}

const MIN_SECRET_LENGTH = 16;
const FULL_SHA = /^[0-9a-fA-F]{40}$/;

export function bearerMatches(header: string | null, secret: string): boolean {
  const given = createHash("sha256")
    .update(header ?? "", "utf8")
    .digest();
  const expected = createHash("sha256").update(`Bearer ${secret}`, "utf8").digest();
  return timingSafeEqual(given, expected);
}

const dateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Australia/Melbourne",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
export function melbourneDate(d: Date): string {
  const p = Object.fromEntries(dateFmt.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

async function alreadyDone(db: Client, key: string): Promise<boolean> {
  // "final" = the check completed and was acted on (ok, awaiting, or mismatch with its incident
  // written). A failed lookup ("unknown") stays retryable by a manual call the same day.
  const res = await db.execute({
    sql: `SELECT 1 FROM run_record WHERE concurrency_key = ?
          AND json_extract(details_json, '$.final') = 1 LIMIT 1`,
    args: [key],
  });
  return res.rows.length > 0;
}

export function createWatchdogHandler(deps: Deps) {
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
      const key = `watchdog:${date}`;
      const db = deps.mainDb();
      if (await alreadyDone(db, key)) return json(200, { skipped: "already ran", date });

      const deployedCommit = deps.env.APP_COMMIT;
      const runId = await startRun(db, {
        job: WATCHDOG_JOB,
        concurrencyKey: key,
        scheduledFor: date,
        now: now.toISOString(),
        ...(has(deployedCommit) && FULL_SHA.test(deployedCommit.trim())
          ? { commitSha: deployedCommit.trim().toLowerCase() }
          : {}),
      });

      let result: WatchdogResult;
      try {
        result = await checkApprovedCommit({
          fetchImpl: (url, init) =>
            deps.fetchImpl(url, { ...init, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) }),
          token: deps.env.GITHUB_READ_TOKEN,
          repo: CODE_REPO,
          deployedCommit,
        });
      } catch {
        result = { status: "unknown", detail: "Check failed." };
      }

      let incident: "opened" | "already open" | "write failed" | undefined;
      if (result.status === "mismatch") {
        try {
          const opened = await openS1Once(
            db,
            KIND_UNAPPROVED_CODE,
            { approvedSha: result.approvedSha, deployedSha: result.deployedSha, date },
            now.toISOString(),
          );
          incident = opened ? "opened" : "already open";
        } catch {
          incident = "write failed";
        }
      }

      const final = result.status !== "unknown" && incident !== "write failed";
      const ok = result.status === "ok" || result.status === "awaiting_first_approval";
      await finishRun(db, runId, {
        status: ok ? "success" : "failed",
        itemsProcessed: 1,
        ...(ok ? {} : { errorSummary: result.detail }),
        details: {
          status: result.status,
          approvedSha: result.approvedSha ?? null,
          deployedSha: result.deployedSha ?? null,
          ...(incident ? { incident } : {}),
          final,
        },
      });
      return json(200, { status: result.status, date });
    } catch {
      return json(503, { error: "unavailable" });
    }
  };
}
