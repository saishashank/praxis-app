// INFRA T5 (B4 + S5 redesign): an INCREMENTAL, non-destructive copy of one self-hosted database (sqld,
// the source) into the Turso copy (the target). Used only by turso-refresh.mjs, after its owner guards.
//
// Why not "wipe + restore" any more: wiping dropped worker_state (so the cloud gates, which fail open,
// stopped seeing clock_owner=selfhost) and rewrote every row every night (Turso FREE plan: 10 M rows
// written and 500 M rows read per month; the Owner's rule is <= 20 % of it, no OFFSET paging).
//
// What it does instead (stateless: nothing is remembered between runs except the usage meter in sqld):
//   1. schema: a table that is missing or whose CREATE sql differs in Turso is rebuilt (dropped and recreated,
//      plus every table that references it); everything else is kept. worker_state is NEVER dropped: if its
//      schema differs the run refuses (exit 1) instead. Indexes and views are created/replaced; triggers are
//      dropped for the tables being written and re-created from the source at the end (a trigger like
//      "append-only" would otherwise reject the replication), also when the run fails half way.
//   2. data: per table, in foreign-key order, the source is read in primary-key pages (keyset, never OFFSET)
//      and for each page the SAME key range is read from the target; rows are compared by value and only
//      new / changed rows are written (INSERT .. ON CONFLICT DO UPDATE, never REPLACE: no cascade deletes).
//      Rows that only the target has are deleted in a second pass, children first, except in worker_state and
//      replay's seven result tables (replay writes them in Turso; replay-sync pulls them back; never lose them).
//   3. worker_state keys `clock_owner` and `turso_refresh_usage` are excluded from the diff: the owner row in
//      Turso is never written or deleted by this job, so the cloud gates read "selfhost" the whole time.
// Reads: the source is local and free. Turso reads = one pass over every copied table (+ the schema listing).
// Writes: only the changed rows. A usage meter (worker_state key `turso_refresh_usage` in the SOURCE, 30 daily
// buckets) refuses to start, or stops, once the rolling 30-day total would pass 20 % of the free plan.
//
// Output rules: counts and table names only. Never a URL, token or row content.
import { decodeValue, encodeValue, foreignKeyOrder, EPHEMERAL_TABLES } from "../backup/core.mjs";
import { SqldError } from "./sqld.mjs";

/** Turso FREE plan, monthly (https://turso.tech/pricing, read 2026-11-10). */
export const FREE_PLAN = Object.freeze({ rowsRead: 500_000_000, rowsWritten: 10_000_000 });
/** The Owner's share for this job (rule 2026-11-09: stay within the free plan, <= 20 % budget). */
export const BUDGET_SHARE = 0.2;
export const BUDGET = Object.freeze({
  rowsRead: FREE_PLAN.rowsRead * BUDGET_SHARE, // 100 M per rolling 30 days
  rowsWritten: FREE_PLAN.rowsWritten * BUDGET_SHARE, // 2 M per rolling 30 days
});
/** No single run writes more than this, however much budget is left (a runaway diff stops early). */
export const RUN_MAX_WRITES = 300_000;
export const PAGE = 5000;
export const BATCH = 500;
export const USAGE_KEY = "turso_refresh_usage";
export const OWNER_KEY = "clock_owner";
/** worker_state keys this job never reads, writes or deletes in the target. */
export const PROTECTED_KEYS = Object.freeze([OWNER_KEY, USAGE_KEY]);
/** Rows only the target has are kept in these tables (replay's results, and the state table). */
export const NO_DELETE_TABLES = Object.freeze([
  "worker_state",
  "lineage",
  "lineage_split",
  "trial_ledger",
  "replay_run",
  "validation_result",
  "label",
  "replay_stat",
]);

export class BudgetError extends SqldError {}

const q = (n) => `"${String(n).replaceAll('"', '""')}"`;
const norm = (s) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
const isInternal = (n) => /^(sqlite_|libsql_|_litestream|_restore_checkpoint)/.test(n);

// ---------------------------------------------------------------------------------------------
// Usage meter

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Rolling 30-day usage meter, persisted in the SOURCE worker_state. */
export class Meter {
  /** @param {import("@libsql/client").Client} sourceMain @param {() => number} now */
  constructor(sourceMain, now) {
    this.db = sourceMain;
    this.now = now;
    this.days = {};
    this.reads = 0; // this run
    this.writes = 0; // this run
    this.flushedReads = 0;
    this.flushedWrites = 0;
  }
  async load() {
    try {
      const r = await this.db.execute({
        sql: "SELECT value_json FROM worker_state WHERE key = ?",
        args: [USAGE_KEY],
      });
      const v = r.rows.length ? JSON.parse(String(r.rows[0].value_json)) : {};
      this.days = v && typeof v === "object" && v.days && typeof v.days === "object" ? v.days : {};
    } catch {
      this.days = {};
    }
    // keep 31 daily buckets
    const cutoff = dayOf(this.now() - 31 * 86_400_000);
    for (const d of Object.keys(this.days)) if (d < cutoff) delete this.days[d];
  }
  /** Usage in the window, this run included. */
  total() {
    const from = dayOf(this.now() - 29 * 86_400_000);
    let reads = 0;
    let writes = 0;
    for (const [d, u] of Object.entries(this.days)) {
      if (d >= from) {
        reads += Number(u.r) || 0;
        writes += Number(u.w) || 0;
      }
    }
    return {
      reads: reads + this.reads - this.flushedReads,
      writes: writes + this.writes - this.flushedWrites,
    };
  }
  remainingWrites() {
    return Math.max(
      0,
      Math.min(BUDGET.rowsWritten - this.total().writes, RUN_MAX_WRITES - this.writes),
    );
  }
  readsLeft() {
    return BUDGET.rowsRead - this.total().reads;
  }
  read(n) {
    this.reads += n;
    if (this.readsLeft() < 0)
      throw new BudgetError("budget: the rolling 30-day Turso read budget is used up");
  }
  write(n) {
    this.writes += n;
  }
  async flush() {
    const d = dayOf(this.now());
    const cur = this.days[d] ?? { r: 0, w: 0 };
    this.days[d] = {
      r: (Number(cur.r) || 0) + (this.reads - this.flushedReads),
      w: (Number(cur.w) || 0) + (this.writes - this.flushedWrites),
    };
    this.flushedReads = this.reads;
    this.flushedWrites = this.writes;
    try {
      await this.db.execute({
        sql: "INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
        args: [USAGE_KEY, JSON.stringify({ days: this.days }), new Date(this.now()).toISOString()],
      });
    } catch {
      // the meter is advisory bookkeeping; a failure to save it must not mask the run's own result
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Row comparison

const rowText = (cols, row) => JSON.stringify(cols.map((c) => encodeValue(row[c])));
const keyText = (pk, row) => JSON.stringify(pk.map((c) => encodeValue(row[c])));

async function tableInfo(db, name) {
  const info = await db.execute(`PRAGMA table_info(${q(name)})`);
  const cols = info.rows.map((r) => String(r.name));
  const pk = info.rows
    .filter((r) => Number(r.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map((r) => String(r.name));
  return { cols, pk };
}

/**
 * One keyset page of rows with key in (lo, hi] (either bound may be null), ordered by key. No OFFSET.
 */
async function readRange(db, table, cols, pk, lo, hi, limit) {
  const keyList = pk.map(q).join(", ");
  const ph = pk.map(() => "?").join(", ");
  const conds = [];
  const args = [];
  if (lo) {
    conds.push(`(${keyList}) > (${ph})`);
    args.push(...lo);
  }
  if (hi) {
    conds.push(`(${keyList}) <= (${ph})`);
    args.push(...hi);
  }
  if (table === "worker_state") {
    conds.push(`"key" NOT IN (${PROTECTED_KEYS.map((k) => `'${k}'`).join(", ")})`);
  }
  const where = conds.length ? ` WHERE ${conds.join(" AND ")}` : "";
  const res = await db.execute({
    sql: `SELECT ${cols.map(q).join(", ")} FROM ${q(table)}${where} ORDER BY ${keyList} LIMIT ?`,
    args: [...args, limit],
  });
  return res.rows;
}

/**
 * Compare one table. `targetPresent` false = the target table is empty/missing (just copy).
 * Returns { upserts: row[], deletes: keyArray[], scanned, sourceRows }; stops collecting at `cap` ops
 * (truncated = true).
 */
export async function diffTable({ source, target, table, cols, pk, targetPresent, meter, cap }) {
  const out = { upserts: [], deletes: [], sourceRows: 0, truncated: false };
  const noDelete = NO_DELETE_TABLES.includes(table);
  let lo = null;
  for (;;) {
    const srcRows = await readRange(source, table, cols, pk, lo, null, PAGE);
    const hi = srcRows.length === PAGE ? pk.map((k) => srcRows[srcRows.length - 1][k]) : null;
    out.sourceRows += srcRows.length;
    // the target's rows in the same key range, paged by key too (a range is ~PAGE rows unless the target
    // holds many rows the source does not)
    const have = new Map();
    if (targetPresent) {
      let tlo = lo;
      for (;;) {
        const rows = await readRange(target, table, cols, pk, tlo, hi, PAGE);
        meter.read(rows.length);
        for (const r of rows) have.set(keyText(pk, r), rowText(cols, r));
        if (rows.length < PAGE) break;
        tlo = pk.map((k) => rows[rows.length - 1][k]);
      }
    }
    const seen = new Set();
    for (const r of srcRows) {
      const k = keyText(pk, r);
      seen.add(k);
      if (have.get(k) !== rowText(cols, r)) {
        if (out.upserts.length + out.deletes.length >= cap) out.truncated = true;
        else out.upserts.push(r);
      }
    }
    if (!noDelete) {
      for (const k of have.keys()) {
        if (seen.has(k)) continue;
        if (out.upserts.length + out.deletes.length >= cap) out.truncated = true;
        else out.deletes.push(JSON.parse(k));
      }
    }
    if (out.truncated || !hi) break;
    lo = hi;
  }
  return out;
}

function upsertSql(table, cols, pk) {
  const set = cols.filter((c) => !pk.includes(c));
  const conflict = set.length
    ? `DO UPDATE SET ${set.map((c) => `${q(c)} = excluded.${q(c)}`).join(", ")}`
    : "DO NOTHING";
  return `INSERT INTO ${q(table)} (${cols.map(q).join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) ON CONFLICT (${pk.map(q).join(", ")}) ${conflict}`;
}

const keyArgs = (keyJson) => keyJson.map(decodeValue);

async function runBatches(db, stmts, meter, { counted }) {
  for (let i = 0; i < stmts.length; i += BATCH) {
    const slice = stmts.slice(i, i + BATCH);
    try {
      await db.batch(["PRAGMA defer_foreign_keys = ON", ...slice], "write");
    } catch (e) {
      // the message can carry column names or values: only the error code leaves this function
      throw new SqldError(`target write failed (${e?.code ?? "error"})`);
    }
    if (counted) meter.write(slice.length);
  }
}

// ---------------------------------------------------------------------------------------------
// The refresh of one database

/**
 * @param {{ name: "main" | "auth", source: import("@libsql/client").Client, target: import("@libsql/client").Client,
 *   meter: Meter, guard: () => Promise<void>, dry?: boolean, verify?: boolean,
 *   forceRebuild?: string[], log?: (s: string) => void }} o
 */
export async function refreshDatabase(o) {
  const { name, source, target, meter, guard } = o;
  const dry = o.dry === true;
  const ephemeral = EPHEMERAL_TABLES[name] ?? [];
  const master = async (db) => {
    const r = await db.execute(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name",
    );
    return r.rows
      .map((x) => ({
        type: String(x.type),
        name: String(x.name),
        table: String(x.tbl_name),
        sql: String(x.sql),
      }))
      .filter((x) => !isInternal(x.name));
  };
  const srcObjs = await master(source);
  const tgtObjs = await master(target);
  meter.read(tgtObjs.length);
  const srcTables = srcObjs.filter((x) => x.type === "table");
  const tgtTables = new Map(tgtObjs.filter((x) => x.type === "table").map((x) => [x.name, x]));
  const sqlOf = new Map(srcTables.map((t) => [t.name, t.sql]));
  const order = foreignKeyOrder(
    srcTables.map((t) => t.name),
    sqlOf,
  );

  // --- schema: which tables must be rebuilt
  const differs = new Set();
  for (const t of srcTables) {
    const have = tgtTables.get(t.name);
    if (!have || norm(have.sql) !== norm(t.sql)) differs.add(t.name);
  }
  for (const f of o.forceRebuild ?? []) {
    if (sqlOf.has(f)) differs.add(f);
  }
  if (differs.has("worker_state") && tgtTables.has("worker_state")) {
    throw new SqldError(
      "refused: the Turso worker_state schema differs; it is never dropped (fix by hand)",
    );
  }
  const rebuild = new Set(differs);
  for (let grew = true; grew;) {
    grew = false;
    for (const t of srcTables) {
      if (rebuild.has(t.name)) continue;
      const refs = [...t.sql.matchAll(/\bREFERENCES\s+[`"[]?([A-Za-z_][A-Za-z0-9_]*)/gi)].map(
        (m) => m[1],
      );
      if (refs.some((r) => r !== t.name && rebuild.has(r))) {
        rebuild.add(t.name);
        grew = true;
      }
    }
  }
  if (rebuild.has("worker_state") && tgtTables.has("worker_state")) {
    throw new SqldError(
      "refused: a rebuild would drop worker_state; it is never dropped (fix by hand)",
    );
  }

  const stats = {
    tables: order.length,
    scanned: 0,
    upserted: 0,
    deleted: 0,
    rebuilt: rebuild.size,
    partial: false,
  };
  const droppedTriggers = new Set();
  const srcTriggers = new Map(srcObjs.filter((x) => x.type === "trigger").map((x) => [x.name, x]));

  try {
    // --- schema writes
    const dropTables = order.filter((n) => rebuild.has(n) && tgtTables.has(n)).reverse();
    const ddl = [];
    for (const n of dropTables) ddl.push(`DROP TABLE IF EXISTS ${q(n)}`);
    for (const n of order) if (rebuild.has(n)) ddl.push(sqlOf.get(n));
    // indexes and views: create the missing, replace the changed (a rebuilt table lost its indexes)
    const tgtOther = new Map(
      tgtObjs.filter((x) => x.type === "index" || x.type === "view").map((x) => [x.name, x]),
    );
    for (const x of srcObjs.filter((s) => s.type === "index" || s.type === "view")) {
      const have = tgtOther.get(x.name);
      const lost = rebuild.has(x.table);
      if (have && !lost && norm(have.sql) === norm(x.sql)) continue;
      if (have && !lost) ddl.push(`DROP ${x.type.toUpperCase()} IF EXISTS ${q(x.name)}`);
      ddl.push(x.sql);
    }
    if (ddl.length && !dry) {
      await guard();
      await runBatches(target, ddl, meter, { counted: true });
    }

    // --- data, parent first
    const pendingDeletes = [];
    const tableOrder = order.filter((n) => !ephemeral.includes(n));
    let budgetStop = false;
    let queued = 0;
    for (const table of tableOrder) {
      const { cols, pk } = await tableInfo(source, table);
      if (pk.length === 0)
        throw new SqldError(`${table}: no primary key, cannot be copied incrementally`);
      const present = tgtTables.has(table) && !rebuild.has(table);
      const cap = Math.max(0, meter.remainingWrites() - queued);
      const d = await diffTable({
        source,
        target,
        table,
        cols,
        pk,
        targetPresent: present,
        meter,
        cap,
      });
      stats.scanned += d.sourceRows;
      if (d.truncated) budgetStop = true;
      if (d.deletes.length) {
        pendingDeletes.push({ table, pk, keys: d.deletes });
        queued += d.deletes.length;
      }
      if (!d.upserts.length) {
        if (d.truncated) break;
        continue;
      }
      stats.upserted += d.upserts.length;
      if (dry) continue;
      await guard();
      // drop this table's triggers (re-created from the source at the end)
      const trg = [...tgtObjs, ...srcObjs].filter((x) => x.type === "trigger" && x.table === table);
      const names = [...new Set(trg.map((x) => x.name))].filter((n) => !droppedTriggers.has(n));
      if (names.length) {
        await runBatches(
          target,
          names.map((n) => `DROP TRIGGER IF EXISTS ${q(n)}`),
          meter,
          { counted: false },
        );
        for (const n of names) droppedTriggers.add(n);
      }
      const sql = upsertSql(table, cols, pk);
      const stmts = d.upserts.map((r) => ({ sql, args: cols.map((c) => r[c]) }));
      await runBatches(target, stmts, meter, { counted: true });
      await meter.flush();
      if (d.truncated) break;
    }

    // --- deletes, children first
    if (!dry && pendingDeletes.length && !budgetStop) {
      pendingDeletes.sort((a, b) => order.indexOf(b.table) - order.indexOf(a.table));
      await guard();
      for (const { table, pk, keys } of pendingDeletes) {
        const trg = [...tgtObjs, ...srcObjs].filter(
          (x) => x.type === "trigger" && x.table === table,
        );
        const names = [...new Set(trg.map((x) => x.name))].filter((n) => !droppedTriggers.has(n));
        if (names.length) {
          await runBatches(
            target,
            names.map((n) => `DROP TRIGGER IF EXISTS ${q(n)}`),
            meter,
            { counted: false },
          );
          for (const n of names) droppedTriggers.add(n);
        }
        const sql = `DELETE FROM ${q(table)} WHERE ${pk.map((c) => `${q(c)} = ?`).join(" AND ")}`;
        const stmts = [];
        for (const k of keys) stmts.push({ sql, args: keyArgs(k) });
        await runBatches(target, stmts, meter, { counted: true });
        stats.deleted += keys.length;
      }
      await meter.flush();
    } else if (pendingDeletes.length) {
      stats.deleted = pendingDeletes.reduce((n, p) => n + p.keys.length, 0);
    }
    stats.partial = budgetStop;
    if (budgetStop) {
      throw new BudgetError(
        "budget: stopped at the Turso write budget; the next run continues from here",
      );
    }
  } finally {
    // triggers: re-create every source trigger that is missing, changed or was dropped; remove extras
    if (!dry) {
      try {
        const have = new Map(tgtObjs.filter((x) => x.type === "trigger").map((x) => [x.name, x]));
        const stmts = [];
        for (const [n, t] of srcTriggers) {
          const h = have.get(n);
          if (droppedTriggers.has(n) || !h || rebuild.has(t.table) || norm(h.sql) !== norm(t.sql)) {
            stmts.push(`DROP TRIGGER IF EXISTS ${q(n)}`, t.sql);
          }
        }
        for (const [n, h] of have) {
          if (!srcTriggers.has(n) && sqlOf.has(h.table))
            stmts.push(`DROP TRIGGER IF EXISTS ${q(n)}`);
        }
        if (stmts.length) await runBatches(target, stmts, meter, { counted: false });
      } catch {
        // best effort: the next run repairs the triggers (a missing trigger is "changed" next time)
      }
      await meter.flush();
    }
  }

  if (o.verify && !dry) {
    for (const table of order.filter((n) => !ephemeral.includes(n))) {
      const { cols, pk } = await tableInfo(source, table);
      const d = await diffTable({
        source,
        target,
        table,
        cols,
        pk,
        targetPresent: true,
        meter,
        cap: 1,
      });
      if (d.upserts.length || d.deletes.length || d.truncated) {
        throw new SqldError(`verify: ${table} still differs from the source`);
      }
    }
  }
  return stats;
}
