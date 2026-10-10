// Test double for the Turso HTTP pipeline API, backed by a real SQLite database (node:sqlite) that
// has the app migrations applied. Also a GitHub dispatch recorder. No network is touched.
import { DatabaseSync } from "node:sqlite";
import m1 from "../../db/migrations/main/0001_core.sql?raw";
import m2 from "../../db/migrations/main/0002_run_record_month.sql?raw";
import m3 from "../../db/migrations/main/0003_incident.sql?raw";
import m4 from "../../db/migrations/main/0004_au_data.sql?raw";
import m5 from "../../db/migrations/main/0005_au_calendar_seed.sql?raw";

export const TOKEN = "ghp_TOPSECRET_dispatch_value";
export const TURSO_TOKEN = "turso-TOPSECRET-token";
export const TURSO_URL = "libsql://praxis-main-secret-host.turso.io";

export function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const m of [m1, m2, m3, m4, m5]) {
    db.exec(m.split("-- +down")[0].replace("-- +up", ""));
  }
  return db;
}

export type Call = { url: string; method: string; headers: Record<string, string>; body: string };
export type Net = {
  f: typeof fetch;
  calls: Call[];
  pipelines: number;
  github: Call[];
  /** Status (or "throw") returned for each GitHub dispatch, consumed in order; then 204. */
  githubPlan: (number | "throw")[];
  /** Make the pipeline yield once so concurrent callers interleave. */
  interleave: boolean;
  failPipeline: boolean;
};

function wire(v: unknown): { type: string; value?: string } {
  if (v === null || v === undefined) return { type: "null" };
  if (typeof v === "number" || typeof v === "bigint") return { type: "integer", value: String(v) };
  return { type: "text", value: String(v) };
}

export function makeNet(db: DatabaseSync): Net {
  const net: Net = {
    calls: [],
    pipelines: 0,
    github: [],
    githubPlan: [],
    interleave: false,
    failPipeline: false,
    f: undefined as unknown as typeof fetch,
  };
  net.f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? ""),
    };
    net.calls.push(call);
    if (url.endsWith("/v2/pipeline")) {
      net.pipelines++;
      if (net.interleave) await Promise.resolve();
      if (net.failPipeline) return new Response("nope", { status: 500 });
      const reqs = JSON.parse(call.body).requests as {
        type: string;
        stmt?: { sql: string; args?: { type: string; value?: string }[] };
      }[];
      const results: unknown[] = [];
      for (const r of reqs) {
        if (r.type !== "execute" || !r.stmt) {
          results.push({ type: "ok" });
          continue;
        }
        const args = (r.stmt.args ?? []).map((a) =>
          a.type === "null" ? null : a.type === "integer" ? Number(a.value) : a.value,
        );
        const st = db.prepare(r.stmt.sql);
        if (/^\s*select/i.test(r.stmt.sql)) {
          const rows = st.all(...args).map((o) => Object.values(o).map(wire));
          results.push({ type: "ok", response: { type: "execute", result: { rows } } });
        } else {
          const info = st.run(...args);
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
    if (url.startsWith("https://api.github.com/")) {
      net.github.push(call);
      const plan = net.githubPlan.shift();
      if (plan === "throw") throw new Error(`boom ${TOKEN}`);
      return new Response(null, { status: plan ?? 204 });
    }
    throw new Error(`unexpected url ${url}`);
  }) as typeof fetch;
  return net;
}

export const rows = (db: DatabaseSync, sql: string, ...args: unknown[]) =>
  db.prepare(sql).all(...args);
