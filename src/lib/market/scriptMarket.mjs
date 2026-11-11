// The market input of every script that writes a market-keyed row (M19 C2, MKT-110 a, D-996). Plain ESM so the
// Actions scripts import it like profileCore.mjs. The rule, in one place:
//   --market <CODE>   names the market; NO literal default exists anywhere.
//   omitted or empty  = the single enabled market; with none or several enabled the script exits 2
//                       ("market required"): it must not guess.
//   a market that is not enabled -> exit 2, the log line `refused: market not enabled`, and NO run record: a
//                       run record for that market would itself be a refused write (the guard trigger, D-995).
// `assertMarketEnabled` is the typed check a script calls before its first write; stream A2's guard.mjs exports
// the same function name for code that already holds the guard module, this one only needs the `market` table.
import { MarketNotEnabled } from "./errors.mjs";

export const MARKET_FLAG = "--market";
/** The log line of a refusal (fixed words; no code, no URL, no value). */
export const REFUSED_LINE = "refused: market not enabled";
export const REQUIRED_LINE = "market required";
/** A job whose data source belongs to one market (the ASIC and ASX history files) refuses any other (PRD-039). */
export const UNSUPPORTED_LINE = "refused: market not supported by this job";
/** Exit code of a refused or ambiguous market (2 = usage/refusal, like the `--now` refusal). */
export const REFUSED_EXIT = 2;

const CODE_RE = /^[A-Z][A-Z0-9]{1,7}$/;

/**
 * Takes `--market <CODE>` (or `--market=<CODE>`) out of an argument list.
 * @param {readonly string[]} argv
 * @returns {{ argv: string[], market: string | null, error: string | null }}
 */
export function takeMarketFlag(argv) {
  const rest = [];
  let market = null;
  let error = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === MARKET_FLAG) {
      const v = argv[i + 1];
      if (v === undefined || (v.startsWith("--") && v !== "")) error = "--market needs a value";
      else {
        market = v.trim() === "" ? null : v.trim();
        i += 1;
      }
    } else if (a.startsWith(`${MARKET_FLAG}=`)) {
      const v = a.slice(MARKET_FLAG.length + 1).trim();
      market = v === "" ? null : v;
    } else rest.push(a);
  }
  if (market !== null && !CODE_RE.test(market)) error = "--market is not a market code";
  return { argv: rest, market, error };
}

/**
 * The enabled market codes, code order. `rows-ok: 3` (the `market` table has at most three rows).
 * @param {{ execute: (q: { sql: string, args?: unknown[] }) => Promise<{ rows: unknown[] }> }} db
 * @returns {Promise<string[]>}
 */
export async function enabledCodes(db) {
  const res = await db.execute({ sql: "SELECT code FROM market WHERE enabled = 1 ORDER BY code" });
  return res.rows.map((r) => String(Array.isArray(r) ? r[0] : r.code));
}

/**
 * Throws MarketNotEnabled when the market is not enabled (a primary-key probe of the 3-row table).
 * @param {{ execute: (q: { sql: string, args?: unknown[] }) => Promise<{ rows: unknown[] }> }} db
 * @param {string} code
 */
export async function assertMarketEnabled(db, code) {
  const res = await db.execute({
    sql: "SELECT 1 AS ok FROM market WHERE code = ? AND enabled = 1",
    args: [code],
  });
  if (res.rows.length === 0) throw new MarketNotEnabled(code);
}

/**
 * The market a script runs for: the flag when given and enabled, else the single enabled market.
 * `{ ok: false }` carries the fixed log line and the exit code; nothing was written.
 * @param {Parameters<typeof enabledCodes>[0]} db
 * @param {string | null} flag the `--market` value (null = omitted)
 * @param {{ supported?: readonly string[] }} [opts] markets this job can run for (default: every enabled one)
 * @returns {Promise<{ ok: true, market: string } | { ok: false, line: string, exit: number }>}
 */
export async function resolveScriptMarket(db, flag, opts = {}) {
  const enabled = await enabledCodes(db);
  const refuse = (line) => ({ ok: false, line, exit: REFUSED_EXIT });
  let market;
  if (flag !== null) {
    if (!enabled.includes(flag)) return refuse(REFUSED_LINE);
    market = flag;
  } else if (enabled.length === 1) {
    market = enabled[0];
  } else {
    return refuse(enabled.length === 0 ? REFUSED_LINE : REQUIRED_LINE);
  }
  if (opts.supported !== undefined && !opts.supported.includes(market))
    return refuse(UNSUPPORTED_LINE);
  return { ok: true, market };
}
