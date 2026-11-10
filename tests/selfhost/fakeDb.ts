// Test double of the main database for the clock tests (INFRA T3): a real SQLite database (node:sqlite) with
// the app migrations applied, behind a fetch that speaks the Turso/sqld hrana pipeline (`/v2/pipeline`), the
// wire format worker/src/db.ts uses. Nothing touches a network. Mirrors worker/test/fakeTurso.ts, which lives
// in the Worker package and cannot be imported from here (its `?raw` imports are not typed in the root).
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const MIGRATIONS = path.resolve(import.meta.dirname, "../../db/migrations/main");
/** The tables the clock and its runners touch: core, calendar, run_now, job_run (no Sentinel, no Cortex). */
const NEEDED = [1, 2, 3, 4, 5, 6, 26, 29];

export function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    if (!NEEDED.includes(Number(f.slice(0, 4)))) continue;
    const sql = readFileSync(path.join(MIGRATIONS, f), "utf8");
    db.exec(sql.split("-- +down")[0]!.replace("-- +up", ""));
  }
  return db;
}

type Wire = { type: string; value?: string };
const wire = (v: unknown): Wire =>
  v === null || v === undefined
    ? { type: "null" }
    : typeof v === "number" || typeof v === "bigint"
      ? { type: "integer", value: String(v) }
      : { type: "text", value: String(v) };

/** Answers a hrana pipeline request against `db`. */
export function pipelineResponse(db: DatabaseSync, body: string): Response {
  const reqs = (
    JSON.parse(body) as {
      requests: {
        type: string;
        stmt?: { sql: string; args?: { type: string; value?: string }[] };
      }[];
    }
  ).requests;
  const results: unknown[] = [];
  for (const r of reqs) {
    if (r.type !== "execute" || !r.stmt) {
      results.push({ type: "ok" });
      continue;
    }
    const args = (r.stmt.args ?? []).map((a) =>
      a.type === "null" ? null : a.type === "integer" ? Number(a.value) : (a.value ?? null),
    );
    const st = db.prepare(r.stmt.sql);
    if (/^\s*select/i.test(r.stmt.sql)) {
      const rows = st.all(...(args as never[])).map((o) => Object.values(o).map(wire));
      results.push({ type: "ok", response: { type: "execute", result: { rows } } });
    } else {
      const info = st.run(...(args as never[]));
      results.push({
        type: "ok",
        response: {
          type: "execute",
          result: { rows: [], affected_row_count: Number(info.changes) },
        },
      });
    }
  }
  return Response.json({ results });
}

export const rows = (db: DatabaseSync, sql: string, ...args: unknown[]) =>
  db.prepare(sql).all(...(args as never[]));

export function setState(db: DatabaseSync, key: string, valueJson: string): void {
  db.prepare(
    "INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, ?, 'x') " +
      "ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json",
  ).run(key, valueJson);
}
