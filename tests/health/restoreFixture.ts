// Test fixture: a recorded real-key restore drill plus its verify-removed run in a quarter (OPS-105,
// D-962). Without one, the health snapshot shows the Owner item "Quarterly restore drill due", so
// tests whose world is meant to be all green (the attention reminder, the morning route) record it.
import type { Client } from "@libsql/client";

export async function seedRestoreDrill(db: Client, at = "2026-10-01T00:00:00.000Z"): Promise<void> {
  for (const [mode, offset] of [
    ["drill", 0],
    ["verify-removed", 1000],
  ] as const) {
    const t = new Date(Date.parse(at) + offset).toISOString();
    await db.execute({
      sql: `INSERT INTO run_record (job, concurrency_key, started_at, status, details_json)
            VALUES ('restore-drill', ?, ?, 'success', ?)`,
      args: [
        `restore-drill:${t.slice(0, 10)}:${mode}:real`,
        t,
        JSON.stringify({ keyMode: "real", mode }),
      ],
    });
  }
}
