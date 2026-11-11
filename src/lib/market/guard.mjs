// The write guard, application side (M19 A2; MKT-110 b, D-995). Migration 0035 installs BEFORE INSERT and
// BEFORE UPDATE OF market triggers on every table with a `market` column; a row of a market that is not enabled is
// refused with the text `MarketNotEnabled <table>`. This module maps that database error to the typed
// `MarketNotEnabled` (defined in errors.mjs, D-1013; re-exported here, never redefined) and gives every writer
// the same pre-check. Plain ESM: the Next app, the Worker and the Actions scripts import it.
//
//   wrapClient(client, onRefusal)   a libsql client whose execute/batch/transaction/executeMultiple rethrow a
//                                   refused write as MarketNotEnabled (after onRefusal ran; it never throws out)
//   assertMarketEnabled(db, code)   one primary-key read; throws MarketNotEnabled before a script's first write
//   marketNotEnabledFrom(err)       the typed error for a raw database error, or null
import { MarketNotEnabled, isMarketNotEnabled } from "./errors.mjs";

export { MarketNotEnabled, isMarketNotEnabled };

/** The text the triggers raise (RAISE takes a literal only, so the market code cannot be in it). */
export const GUARD_TEXT = "MarketNotEnabled";
const REFUSED_RE = /MarketNotEnabled ([A-Za-z_][A-Za-z0-9_]*)/;
const CODE_RE = /^[A-Z][A-Z0-9]{1,5}$/;
const QUOTED_RE = /'([A-Z][A-Z0-9]{1,5})'/g;

/** @param {unknown} err the table of a refused write, from the trigger text (also through `cause`), or null */
export function refusedTable(err) {
  for (let e = err, i = 0; e instanceof Error && i < 4; e = e.cause, i += 1) {
    const m = REFUSED_RE.exec(e.message);
    if (m) return m[1];
  }
  return null;
}

/**
 * The market of a refused statement (or batch), best effort: the trigger cannot name it, so look at the statement
 * (string arguments and quoted literals that look like a market code). Codes `isEnabled` reports as enabled are
 * dropped; a code `isKnown` (it has a market row) beats a string that only looks like one, such as a ticker;
 * otherwise the first candidate. Falls back to "unknown".
 * @param {unknown} stmt a statement (string or {sql, args}) or an array of them
 * @param {(code: string) => boolean} [isEnabled]
 * @param {(code: string) => boolean} [isKnown]
 */
export function marketOfStatement(stmt, isEnabled = () => false, isKnown = () => false) {
  /** @type {string[]} */
  const cands = [];
  /** @param {unknown} v */
  const add = (v) => {
    if (typeof v === "string" && CODE_RE.test(v) && !cands.includes(v)) cands.push(v);
  };
  for (const one of Array.isArray(stmt) ? stmt : [stmt]) {
    const sql = typeof one === "string" ? one : one && typeof one === "object" ? one.sql : "";
    const args = one && typeof one === "object" ? one.args : undefined;
    if (Array.isArray(args)) args.forEach(add);
    else if (args && typeof args === "object") Object.values(args).forEach(add);
    if (typeof sql === "string") for (const m of sql.matchAll(QUOTED_RE)) add(m[1]);
  }
  const open = cands.filter((c) => !isEnabled(c));
  return open.find((c) => isKnown(c)) ?? (open.length > 0 ? open : cands)[0] ?? "unknown";
}

/**
 * The typed error for a raw database error that came from the guard triggers, else null.
 * @param {unknown} err
 * @param {string} [market] when known; "unknown" otherwise
 */
export function marketNotEnabledFrom(err, market = "unknown") {
  if (isMarketNotEnabled(err)) return /** @type {MarketNotEnabled} */ (err);
  const table = refusedTable(err);
  if (table === null) return null;
  const typed = new MarketNotEnabled(market, table);
  typed.cause = err;
  return typed;
}

/**
 * Throws MarketNotEnabled unless the market is enabled: one primary-key read of the 3-row `market` table.
 * Call it before the first write of any job with a market input (MKT-110 a); a refused job writes no run record.
 * @param {{ execute: (s: any) => Promise<{ rows: any[] }> }} db
 * @param {string} code
 * @returns {Promise<string>} the code
 */
export async function assertMarketEnabled(db, code) {
  // rows-ok: primary-key probe
  const r = await db.execute({
    sql: "SELECT 1 FROM market WHERE code = ? AND enabled = 1",
    args: [code],
  });
  if (r.rows.length !== 1) throw new MarketNotEnabled(String(code));
  return code;
}

const WRAPPED = new WeakMap();
const GUARDED_METHODS = new Set(["execute", "batch", "executeMultiple", "migrate"]);

/**
 * The libsql client with the guard's error mapping. `onRefusal(err, info)` runs once per refused statement before
 * the typed error is thrown (an incident writer; a failure inside it is swallowed). Wrapping the same client twice
 * returns the same wrapper. The wrapper forwards everything else (closed, close, sync, ...) to the client.
 * @template T
 * @param {T} client
 * @param {(err: MarketNotEnabled, info: { table: string | null }) => unknown} [onRefusal]
 * @returns {T}
 */
export function wrapClient(client, onRefusal) {
  const c = /** @type {any} */ (client);
  const hit = WRAPPED.get(c);
  if (hit) return hit;

  /** @param {unknown} err @param {unknown} stmt */
  async function refuse(err, stmt) {
    if (isMarketNotEnabled(err)) throw err;
    const table = refusedTable(err);
    if (table === null) throw err;
    // the failure path only: which markets exist and are enabled (a held transaction may refuse the read)
    const enabled = new Set();
    const known = new Set();
    try {
      // rows-ok: the market table holds one row per built market (3)
      const r = await c.execute("SELECT code, enabled FROM market");
      for (const x of r.rows) {
        known.add(String(x.code));
        if (Number(x.enabled) === 1) enabled.add(String(x.code));
      }
    } catch {
      /* the lookup is best effort */
    }
    const market = marketOfStatement(
      stmt,
      (x) => enabled.has(x),
      (x) => known.has(x),
    );
    const typed = /** @type {MarketNotEnabled} */ (marketNotEnabledFrom(err, market));
    if (onRefusal) {
      try {
        await onRefusal(typed, { table });
      } catch {
        /* best effort: the refusal itself is the outcome */
      }
    }
    throw typed;
  }

  /** @param {any} target @returns {any} */
  function guardTarget(target) {
    return new Proxy(target, {
      get(t, prop) {
        const v = Reflect.get(t, prop, t);
        if (typeof v !== "function") return v;
        if (GUARDED_METHODS.has(String(prop))) {
          return async (/** @type {any} */ stmt, /** @type {any[]} */ ...rest) => {
            try {
              return await v.call(t, stmt, ...rest);
            } catch (e) {
              return refuse(e, stmt);
            }
          };
        }
        if (prop === "transaction") {
          return async (/** @type {any[]} */ ...a) => guardTarget(await v.apply(t, a));
        }
        return v.bind(t);
      },
    });
  }

  const wrapped = guardTarget(c);
  WRAPPED.set(c, wrapped);
  return wrapped;
}
