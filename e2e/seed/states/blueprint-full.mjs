// State `blueprint-full` (TST-135 (a), AT-59): the Blueprint's live-status layer has something to read for
// every view - one successful run record for each of the nightly jobs the model draws - so all eight views show
// a status rather than "no data". The diagram itself comes from the committed model (docs/architecture), not
// the database. Synthetic: the records are fixed-key `e2e-state:` runs, idempotent on their concurrency key.
export const JOBS = [
  "batch1",
  "arena-signals",
  "arena-close",
  "arena-review",
  "arena-learn",
  "sentinel-ingest",
  "evening-review",
  "backup",
];

/** @param {import("@libsql/client").Client} client @param {string} nowIso */
export async function apply(client, nowIso) {
  const d = nowIso.slice(0, 10);
  await client.batch(
    JOBS.map((job) => ({
      sql: `INSERT OR IGNORE INTO run_record (job, market, concurrency_key, started_at, ended_at, status, items_processed)
            VALUES (?, 'AU', ?, ?, ?, 'success', 1)`,
      args: [job, `e2e-state:blueprint-full:${job}:${d}`, nowIso, nowIso],
    })),
    "write",
  );
}
