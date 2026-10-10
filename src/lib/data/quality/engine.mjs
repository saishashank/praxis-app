// Data quality engine (M2 T7): stage 8 of the Batch 1 pipeline (DAT-020). Reads the stored bars of
// one trading date, runs the pure rules of ./rules.mjs (DAT-200), writes `data_quality_flag` rows
// (DAT-211) and the three `quality_score` rows (DAT-201), and returns a per-date summary for the
// run record. Plain ESM + JSDoc so the Actions CLI runs it without a build. The spec quotes and the
// list of choices are in ./rules.mjs.
//
// Writes: `data_quality_flag` (insert, and the single allowed cleared_at NULL -> value update) and
// `quality_score` (append-only, first write wins). Nothing else. Idempotent (DAT-003): a flag is
// inserted only when no open flag with the same (market, code, date, check) exists, so a re-run
// adds nothing; a flag that no longer applies is cleared once. Errors carry no row data (SEC-110).
import { addDays, isValidCode } from "../pipeline/rules.mjs";
import {
  evaluateBar,
  evaluateMissing,
  evaluateRefetch,
  evaluateRejects,
  gateFinding,
  qualityConfigFrom,
  REEVALUATED_IDS,
  RULES,
  scoreDay,
  TIERS,
} from "./rules.mjs";

const STATEMENTS_PER_BATCH = 100;
const CONFIG_KEYS = ["refetch_diff_flag", "suspect_move", "u1_quality_gate"];

/**
 * @typedef {import("@libsql/client").Client} Client
 * @typedef {{ read: number, written: number }} Io
 */

/** @param {Client} db @param {Io} io */
async function sel(db, io, sql, args = []) {
  const r = await db.execute({ sql, args });
  io.read += r.rows.length;
  return r.rows;
}

/**
 * The three Owner-editable thresholds (ch.15), validated against their bounds; absent or invalid
 * values fall back to the defaults.
 * @param {Client} db @param {Io} [io]
 */
export async function readQualityConfig(db, io = { read: 0, written: 0 }) {
  /** @type {Record<string, unknown>} */
  const raw = {};
  for (const key of CONFIG_KEYS) {
    const rows = await sel(
      db,
      io,
      "SELECT value_json FROM config_version WHERE key = ? AND scope = 'global' ORDER BY id DESC LIMIT 1",
      [key],
    );
    if (!rows.length) continue;
    try {
      raw[key] = JSON.parse(String(rows[0].value_json));
    } catch {
      // an unreadable stored value falls back to the default
    }
  }
  return qualityConfigFrom(raw);
}

/** Expected codes for date `d`: the snapshot of `d`, else active instruments with the last known tier. */
async function loadExpected(db, io, market, d) {
  const snap = await sel(
    db,
    io,
    "SELECT code, tier, halted FROM universe_snapshot WHERE market = ? AND d = ? ORDER BY code",
    [market, d],
  );
  if (snap.length > 0) {
    return snap
      .filter((r) => isValidCode(String(r.code)))
      .map((r) => ({ code: String(r.code), tier: String(r.tier), halted: Number(r.halted) === 1 }));
  }
  const inst = await sel(
    db,
    io,
    `SELECT code FROM instrument WHERE market = ? AND (listed_on IS NULL OR listed_on <= ?)
     AND (delisted_on IS NULL OR delisted_on > ?) ORDER BY code`,
    [market, d, d],
  );
  const prior = await sel(
    db,
    io,
    `SELECT code, tier FROM universe_snapshot
     WHERE market = ? AND d = (SELECT MAX(d) FROM universe_snapshot WHERE market = ? AND d < ?)`,
    [market, market, d],
  );
  const tier = new Map(prior.map((r) => [String(r.code), String(r.tier)]));
  return inst
    .map((r) => String(r.code))
    .filter(isValidCode)
    .map((code) => ({ code, tier: tier.get(code) ?? "U3", halted: false }));
}

const barOf = (r) => ({
  o: Number(r.o),
  h: Number(r.h),
  l: Number(r.l),
  c: Number(r.c),
  volume: Number(r.volume),
});

/** Codes with a corporate action or a price-sensitive announcement in [from, to] (DAT-200). */
async function loadExplained(db, io, market, from, to) {
  const out = new Set();
  const ca = await sel(
    db,
    io,
    "SELECT DISTINCT code FROM corporate_action WHERE market = ? AND ex_date >= ? AND ex_date <= ?",
    [market, from, to],
  );
  for (const r of ca) out.add(String(r.code));
  const af = await sel(
    db,
    io,
    "SELECT DISTINCT code FROM adjustment_factor WHERE market = ? AND ex_date >= ? AND ex_date <= ?",
    [market, from, to],
  );
  for (const r of af) out.add(String(r.code));
  const an = await sel(
    db,
    io,
    `SELECT DISTINCT code FROM announcement WHERE market = ? AND price_sensitive = 1
     AND published_at >= ? AND published_at < ?`,
    [market, `${from}T00:00:00.000Z`, `${addDays(to, 1)}T00:00:00.000Z`],
  );
  for (const r of an) out.add(String(r.code));
  return out;
}

/** Corporate actions whose latest status is `queued` (DAT-201 "unresolved corporate actions"). */
async function countUnresolvedActions(db, io, market) {
  const rows = await sel(
    db,
    io,
    `SELECT COUNT(*) AS n FROM corporate_action ca
     WHERE ca.market = ? AND (SELECT e.status FROM corporate_action_event e
       WHERE e.action_id = ca.id ORDER BY e.id DESC LIMIT 1) = 'queued'`,
    [market],
  );
  return Number(rows[0].n);
}

/** DAT-210: consecutive failing U1 nights up to and including `d` (stored gate verdicts). */
async function consecutiveGateFailures(db, io, market, d, failsToday) {
  if (!failsToday) return 0;
  const prior = await sel(
    db,
    io,
    `SELECT gate_pass FROM quality_score WHERE market = ? AND tier = 'U1' AND d < ?
     ORDER BY d DESC LIMIT 30`,
    [market, d],
  );
  let n = 1;
  for (const r of prior) {
    if (Number(r.gate_pass) !== 0) break;
    n += 1;
  }
  return n;
}

const keyOf = (code, rule, d) => `${d}|${code ?? ""}|${rule}`;

/**
 * Run the engine for one trading date. Called by the Batch 1 pipeline (stage 8) and by anything
 * that wants to re-evaluate a date (for example after a corporate action is recorded).
 * @param {{
 *   db: Client, market: string, d: string, io: Io, now?: string,
 *   tradingDay?: boolean,
 *   rejected?: { code: string | null, date: string | null, reason: string }[],
 *   refetchDiffs?: { code: string, d: string, maxDiffPct: number }[],
 * }} ctx
 */
export async function runQuality(ctx) {
  const { db, market, d, io } = ctx;
  const now = ctx.now ?? new Date().toISOString();
  const cfg = await readQualityConfig(db, io);

  const expected = await loadExpected(db, io, market, d);
  const barRows = await sel(
    db,
    io,
    "SELECT code, o, h, l, c, volume FROM price_bar WHERE market = ? AND d = ?",
    [market, d],
  );
  const bars = new Map(barRows.map((r) => [String(r.code), barOf(r)]));
  const prevD = (
    await sel(db, io, "SELECT MAX(d) AS d FROM price_bar WHERE market = ? AND d < ?", [market, d])
  )[0]?.d;
  const prevDate = prevD == null ? null : String(prevD);
  const prevBars = new Map();
  let explained = new Set();
  if (prevDate !== null) {
    const rows = await sel(
      db,
      io,
      "SELECT code, o, h, l, c, volume FROM price_bar WHERE market = ? AND d = ?",
      [market, prevDate],
    );
    for (const r of rows) prevBars.set(String(r.code), barOf(r));
    explained = await loadExplained(db, io, market, prevDate, d);
  }

  /** @type {Map<string, string[]>} */
  const rejectedBy = new Map();
  for (const r of ctx.rejected ?? []) {
    if (r.code === null || r.code === undefined) continue;
    rejectedBy.set(r.code, [...(rejectedBy.get(r.code) ?? []), r.reason]);
  }

  /** @type {{ code: string | null, d: string, finding: import("./rules.mjs").Finding }[]} */
  const wanted = [];
  const invalid = new Set();
  let suspect = 0;
  let missing = 0;
  for (const e of expected) {
    const bar = bars.get(e.code);
    const reasons = rejectedBy.get(e.code) ?? [];
    let findings;
    if (bar) {
      findings = [
        ...evaluateBar({
          bar,
          prev: prevBars.get(e.code) ?? null,
          tradingDay: ctx.tradingDay !== false,
          tier: e.tier,
          halted: e.halted,
          explained: explained.has(e.code),
          suspectMovePct: cfg.suspectMovePct,
        }),
        ...evaluateRejects(reasons),
      ];
    } else {
      findings = [...evaluateMissing({ rejectReasons: reasons }), ...evaluateRejects(reasons)];
      missing += 1;
    }
    if (findings.some((f) => f.blocks_entries)) invalid.add(e.code);
    if (
      bar &&
      findings.some((f) =>
        [RULES.suspect_move.id, RULES.zero_volume_u1.id, RULES.identical_ohlcv.id].includes(f.rule),
      )
    ) {
      suspect += 1;
    }
    for (const finding of findings) wanted.push({ code: e.code, d, finding });
  }

  // DAT-002: re-fetch differences belong to the previous session's bar and never block.
  const expectedCodes = new Set(expected.map((e) => e.code));
  for (const diff of ctx.refetchDiffs ?? []) {
    if (!expectedCodes.has(diff.code)) continue;
    for (const finding of evaluateRefetch(diff.maxDiffPct, cfg.refetchDiffPct)) {
      wanted.push({ code: diff.code, d: diff.d, finding });
    }
  }

  const day = scoreDay({ expected, invalid, gatePct: cfg.u1GatePct });
  if (day.gateFailed) {
    wanted.push({
      code: null,
      d,
      finding: gateFinding(day.tiers.U1, cfg.u1GatePct),
    });
  }

  // Flags: clear what no longer applies (once), insert what is new (never a duplicate).
  const open = await sel(
    db,
    io,
    `SELECT id, code, d, check_id FROM data_quality_flag
     WHERE market = ? AND d = ? AND cleared_at IS NULL`,
    [market, d],
  );
  const wantedKeys = new Set(wanted.map((w) => keyOf(w.code, w.finding.rule, w.d)));
  const reeval = new Set(REEVALUATED_IDS);
  const toClear = open.filter(
    (r) =>
      reeval.has(String(r.check_id)) &&
      !wantedKeys.has(keyOf(r.code == null ? null : String(r.code), String(r.check_id), d)),
  );

  /** @type {{ sql: string, args: any[] }[]} */
  const stmts = [];
  for (const r of toClear) {
    stmts.push({
      sql: "UPDATE data_quality_flag SET cleared_at = ? WHERE id = ? AND cleared_at IS NULL",
      args: [now, Number(r.id)],
    });
  }
  const clearCount = stmts.length;
  for (const w of wanted) {
    stmts.push({
      sql: `INSERT INTO data_quality_flag
              (market, code, d, check_id, severity, detail_json, raised_at, cleared_at, blocks_entries)
            SELECT ?, ?, ?, ?, ?, ?, ?, NULL, ?
            WHERE NOT EXISTS (SELECT 1 FROM data_quality_flag
              WHERE market = ? AND code IS ? AND d = ? AND check_id = ? AND cleared_at IS NULL)`,
      args: [
        market,
        w.code,
        w.d,
        w.finding.rule,
        w.finding.severity,
        JSON.stringify(w.finding.detail),
        now,
        w.finding.blocks_entries ? 1 : 0,
        market,
        w.code,
        w.d,
        w.finding.rule,
      ],
    });
  }
  for (const t of TIERS) {
    const s = day.tiers[t];
    stmts.push({
      sql: `INSERT INTO quality_score (market, d, tier, valid, expected, score, gate_pass)
            VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      args: [market, d, t, s.valid, s.expected, s.score, s.gate_pass ? 1 : 0],
    });
  }
  let cleared = 0;
  let inserted = 0;
  let scoresWritten = 0;
  for (let i = 0; i < stmts.length; i += STATEMENTS_PER_BATCH) {
    const slice = stmts.slice(i, i + STATEMENTS_PER_BATCH);
    const res = await db.batch(slice, "write");
    res.forEach((r, k) => {
      const idx = i + k;
      if (idx < clearCount) cleared += r.rowsAffected;
      else if (idx < stmts.length - TIERS.length) inserted += r.rowsAffected;
      else scoresWritten += r.rowsAffected;
    });
  }
  io.written += cleared + inserted + scoresWritten;

  const unresolvedActions = await countUnresolvedActions(db, io, market);
  const consecutive = await consecutiveGateFailures(db, io, market, d, day.gateFailed);

  /** @type {Record<string, number>} */
  const byRule = {};
  for (const w of wanted) byRule[w.finding.rule] = (byRule[w.finding.rule] ?? 0) + 1;
  return {
    flags: inserted,
    cleared,
    summary: {
      scores: Object.fromEntries(
        TIERS.map((t) => [
          t,
          {
            valid: day.tiers[t].valid,
            expected: day.tiers[t].expected,
            score: day.tiers[t].score,
            ...(day.tiers[t].empty ? { empty: true } : {}),
          },
        ]),
      ),
      gate: {
        pass: !day.gateFailed,
        threshold_pct: cfg.u1GatePct,
        consecutive_failures: consecutive,
      },
      counts: {
        suspect,
        missing,
        cross_source_disagreements: 0, // DAT-102 needs a second source (none in M2)
        unresolved_corporate_actions: unresolvedActions,
      },
      flags_by_rule: byRule,
      flags_new: inserted,
      flags_cleared: cleared,
    },
  };
}

/** The Batch 1 stage-8 hook: the pipeline's context in, the engine's result out. */
export const qualityHook = async (c) =>
  runQuality({
    db: c.db,
    market: c.market,
    d: c.d,
    io: c.io,
    now: c.now,
    tradingDay: true,
    rejected: c.rejected,
    refetchDiffs: c.refetchDiffs,
  });
