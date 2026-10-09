// DB-backed fixed-window rate limit (SEC-014). Throws on DB error: callers answer 503, never allow.
import type { Client } from "@libsql/client";

export async function rateLimit(
  db: Client,
  bucket: string,
  limit: number,
  windowSec: number,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<{ allowed: boolean; count: number }> {
  const windowStart = nowSec - (nowSec % windowSec);
  const res = await db.execute({
    sql: `INSERT INTO rate_limit (bucket, window_start, count) VALUES (?, ?, 1)
          ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1
          RETURNING count`,
    args: [bucket, windowStart],
  });
  const count = Number(res.rows[0].count);
  if (count === 1) {
    // Housekeeping: drop buckets older than an hour (cheap, runs once per new window).
    await db.execute({
      sql: "DELETE FROM rate_limit WHERE window_start < ?",
      args: [nowSec - 3600],
    });
  }
  return { allowed: count <= limit, count };
}
