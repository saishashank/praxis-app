// Signed handler of `POST /api/internal/morning` (M5 T13; D-067 pattern, D-029 wire format, SEC-017
// c2). Body { purpose: "morning", env, d } from the Worker slot `morning` (08:00 Melbourne). The
// verification, date and environment checks are the alert routes' (`signed`). One call runs the
// attention reminder (every day) and the Morning Brief (trading days of an active market, when
// enabled); each is independent, and each sends at most one email per date key, so a retry or a
// second call is harmless. Any unexpected failure answers 503 (the Worker retries).
import { signed, type MachineDeps } from "@/lib/alerts/machine";
import { runBrief } from "@/lib/email/brief";
import { runReminder } from "@/lib/email/reminder";

import type { Client } from "@libsql/client";
import { emailKeys } from "@/lib/email/keys";

export const MORNING_PURPOSE = "morning";

const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

async function stillClaimed(db: Pick<Client, "execute">, keys: string[]): Promise<boolean> {
  const r = await db.execute({
    sql: `SELECT 1 FROM email_message WHERE status = 'claimed' AND email_key IN (${keys.map(() => "?").join(", ")}) LIMIT 1`,
    args: keys,
  });
  return r.rows.length > 0;
}

export function createMorningHandler(deps: MachineDeps) {
  return signed(MORNING_PURPOSE, deps, async (body, nowSec) => {
    const ctx = { ...deps.ctx(), now: () => new Date(nowSec * 1000) };
    const d = body.d as string;
    try {
      const reminder = await runReminder(ctx, d);
      const brief = await runBrief(ctx, d);
      // V1-S8 (D-691): a send left `pending` (two retryable provider outcomes) is not a success.
      // Answer 503 so the Worker re-dispatches (max 3); the email key makes the retry idempotent.
      // A pending send leaves its row `claimed` (a retry inside the 60 s RETRY_GAP even answers
      // "duplicate"), so the row state is the signal.
      if (await stillClaimed(ctx.db, [emailKeys.reminder(d), emailKeys.brief(d)])) {
        return json(503, { error: "send_pending", reminder: reminder.status, brief: brief.status });
      }
      return json(200, {
        reminder: reminder.status,
        brief: brief.status,
        reminder_items: "items" in reminder ? reminder.items : 0,
      });
    } catch {
      return json(503, { error: "unavailable" });
    }
  });
}
