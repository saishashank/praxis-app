// The single database write of the `intraday_stream_state` setting (VAL-118, D-391). The key is
// "fixed": no UI or API can set it (`setConfig` refuses it). The only caller is
// `src/lib/intraday/evaluator.ts`; a test greps for any other (tests/acceptance/v2/at63.test.ts).
import type { Client } from "@libsql/client";
import { getConfig } from "./store";
import { INTRADAY_STREAM_STATES } from "./keys";

export type StreamState = (typeof INTRADAY_STREAM_STATES)[number];

/** Appends a config_version row for the stream state unless it already holds `state`. */
export async function writeStreamState(
  db: Client,
  p: { state: StreamState; userId: number | null; reason: string; now: string },
): Promise<boolean> {
  const before = (await getConfig(db, "intraday_stream_state")) as StreamState;
  if (before === p.state) return false;
  await db.execute({
    sql: `INSERT INTO config_version (key, scope, value_json, previous_json, changed_by_user_id, changed_at, reason)
          VALUES ('intraday_stream_state', 'global', ?, ?, ?, ?, ?)`,
    args: [JSON.stringify(p.state), JSON.stringify(before), p.userId, p.now, p.reason],
  });
  return true;
}
