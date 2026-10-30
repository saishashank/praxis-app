// Corporate action engine (M2 T8): stage 4 of the Batch 1 pipeline (DAT-020) and the shared
// settle/resolve steps the Owner review queue uses. The rules, spec quotes and the list of
// choices are in ./rules.mjs. Plain ESM + JSDoc so the Actions CLI runs it without a build.
//
// Writes (all append-only, so a re-run never duplicates, DAT-003):
// - `corporate_action`: one row per distinct action (INSERT ... WHERE NOT EXISTS on the same
//   market, code, type, ex-date and canonical payload; the table has no unique key to conflict on).
// - `corporate_action_event`: the status history. Nothing is ever edited; a reversal, a
//   supersede and an Owner decision are new rows.
// - `adjustment_factor`: a new row only when the effective factor of an action changes (a
//   confirmation, a reversal); never updated.
// - `data_quality_flag`: the DAT-222 entry block while an action is unresolved (cleared once when
//   it is resolved) and the DAT-221 "applied on best evidence" flag.
// Re-running quality for the affected dates goes through the quality engine (`runQuality`) and only
// ever clears suspect-move flags. Errors carry no row data (SEC-110).
import { readQualityConfig, runQuality } from "../quality/engine.mjs";
import { RULES } from "../quality/rules.mjs";
import {
  autoApplyDue,
  canonicalJson,
  classOf,
  DEFAULT_AUTO_APPLY_SESSIONS,
  DEFAULT_PRICE_TOLERANCE_PCT,
  evaluateGroup,
  factorFor,
  factorKindOf,
  inferRatio,
  isEffective,
  isPriceOnly,
  isUnresolved,
  parseNote,
  pickBestEvidence,
  ratioToNumber,
  refCloseMatches,
  stateOf,
  validateCandidate,
} from "./rules.mjs";

export const BLOCK_CHECK = "DAT-222:unresolved_corporate_action";
export const BEST_EVIDENCE_CHECK = "DAT-221:applied_best_evidence";
const SYSTEM = "system";
const CONFIG_KEYS = ["corporate_action_auto_apply_sessions", "corporate_action_price_tolerance"];

/**
 * @typedef {import("@libsql/client").Client} Client
 * @typedef {{ read: number, written: number }} Io
 * @typedef {{ code: string, type: string, ex_date: string, record_date?: string | null,
 *   payload?: unknown, source: string, ref?: string | null }} Candidate
 */

/** @param {Client} db @param {Io} io */
async function sel(db, io, sql, args = []) {
  const r = await db.execute({ sql, args });
  io.read += r.rows.length;
  return r.rows;
}

/** @param {Client} db @param {Io} io */
async function run(db, io, sql, args) {
  const r = await db.execute({ sql, args });
  io.written += r.rowsAffected;
  return r;
}

/** ISO time at least 1 ms after `prev`, so a later row always sorts after an earlier one. */
const after = (now, prev) => {
  if (!prev || now > prev) return now;
  return new Date(Date.parse(prev) + 1).toISOString();
};

/**
 * The two Owner-editable settings, validated against their bounds; absent or invalid values fall
 * back to the defaults. Also returns the DAT-200 suspect-move threshold used by the jump check.
 * @param {Client} db @param {Io} [io]
 */
export async function readCaConfig(db, io = { read: 0, written: 0 }) {
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
  const s = raw.corporate_action_auto_apply_sessions;
  const t = raw.corporate_action_price_tolerance;
  const q = await readQualityConfig(db, io);
  return {
    autoApplySessions: Number.isInteger(s) && s >= 1 && s <= 60 ? s : DEFAULT_AUTO_APPLY_SESSIONS,
    priceTolerancePct:
      typeof t === "number" && Number.isFinite(t) && t >= 1 && t <= 50
        ? t
        : DEFAULT_PRICE_TOLERANCE_PCT,
    suspectMovePct: q.suspectMovePct,
  };
}

/**
 * Every action of a market with its newest event, current state and evidence sources.
 * @param {Client} db @param {Io} io @param {string} market
 */
export async function loadActions(db, io, market) {
  const acts = await sel(
    db,
    io,
    `SELECT id, code, type, ex_date, record_date, payload_json, evidence_json
     FROM corporate_action WHERE market = ? ORDER BY id`,
    [market],
  );
  const evs = await sel(
    db,
    io,
    `SELECT e.id, e.action_id, e.at, e.status, e.by, e.note
     FROM corporate_action_event e JOIN corporate_action a ON a.id = e.action_id
     WHERE a.market = ? ORDER BY e.id`,
    [market],
  );
  const byAction = new Map();
  for (const e of evs) {
    const id = Number(e.action_id);
    const list = byAction.get(id) ?? [];
    list.push({
      id: Number(e.id),
      at: String(e.at),
      status: String(e.status),
      by: String(e.by),
      note: e.note === null ? null : String(e.note),
    });
    byAction.set(id, list);
  }
  return acts.map((a) => {
    const id = Number(a.id);
    const events = byAction.get(id) ?? [];
    const latest = events.length ? events[events.length - 1] : null;
    let payload = {};
    try {
      payload = JSON.parse(String(a.payload_json));
    } catch {
      // an unreadable payload yields no factor and never auto-confirms
    }
    let evidence = {};
    try {
      evidence = a.evidence_json ? JSON.parse(String(a.evidence_json)) : {};
    } catch {
      // ignore
    }
    const sources = new Set(
      (Array.isArray(evidence.sources) ? evidence.sources : []).map((s) => String(s.src)),
    );
    for (const e of events) {
      const added = parseNote(e.note).add_source;
      if (added && typeof added.src === "string") sources.add(added.src);
    }
    const st = stateOf(latest);
    return {
      id,
      code: String(a.code),
      type: String(a.type),
      ex_date: String(a.ex_date),
      payload,
      payloadText: String(a.payload_json),
      sources: [...sources],
      events,
      latest,
      state: st.state,
      stateSince: st.d,
      note: parseNote(latest?.note),
    };
  });
}

/** @typedef {Awaited<ReturnType<typeof loadActions>>[number]} Action */

const groupKey = (a) => `${a.code}|${a.ex_date}|${classOf(a.type)}`;

async function addEvent(db, io, p) {
  await run(
    db,
    io,
    "INSERT INTO corporate_action_event (action_id, at, status, by, note) VALUES (?, ?, ?, ?, ?)",
    [p.actionId, p.now, p.status, p.by ?? SYSTEM, JSON.stringify(p.note)],
  );
}

// ---------------------------------------------------------------------------------------------
// Capture.

/**
 * Insert candidates as pending actions (idempotent). A candidate that repeats a known action adds
 * its source to a still-open action and is otherwise ignored (a rejected or confirmed action is
 * never re-opened by a re-detection).
 * @param {Client} db @param {{ market: string, d: string, now: string, io: Io,
 *   candidates: Candidate[], actions: Action[] }} c
 */
export async function captureCandidates(db, c) {
  const out = { inserted: 0, source_added: 0, known: 0, invalid: 0 };
  for (const raw of c.candidates) {
    const v = validateCandidate(raw);
    if (!v.ok) {
      out.invalid += 1;
      continue;
    }
    const cand = v.value;
    const payloadText = canonicalJson(cand.payload);
    const existing = c.actions.find(
      (a) =>
        a.code === cand.code &&
        a.type === cand.type &&
        a.ex_date === cand.ex_date &&
        canonicalJson(a.payload) === payloadText,
    );
    if (existing) {
      const open = ["pending", "owner", "blocked"].includes(existing.state);
      if (open && !existing.sources.includes(cand.source)) {
        const note = {
          ...existing.note,
          d: existing.stateSince ?? c.d,
          add_source: { src: cand.source, ref: cand.ref },
        };
        await addEvent(db, c.io, {
          actionId: existing.id,
          now: after(c.now, existing.latest?.at),
          status: "queued",
          note,
        });
        existing.sources.push(cand.source);
        out.source_added += 1;
      } else {
        out.known += 1;
      }
      continue;
    }
    const evidence = JSON.stringify({ sources: [{ src: cand.source, ref: cand.ref }] });
    const tx = await db.transaction("write");
    try {
      const r = await tx.execute({
        sql: `INSERT INTO corporate_action
                (market, code, type, ex_date, record_date, payload_json, evidence_json)
              SELECT ?, ?, ?, ?, ?, ?, ?
              WHERE NOT EXISTS (SELECT 1 FROM corporate_action
                WHERE market = ? AND code = ? AND type = ? AND ex_date = ? AND payload_json = ?)`,
        args: [
          c.market,
          cand.code,
          cand.type,
          cand.ex_date,
          cand.record_date,
          payloadText,
          evidence,
          c.market,
          cand.code,
          cand.type,
          cand.ex_date,
          payloadText,
        ],
      });
      if (r.rowsAffected === 1) {
        const id = Number(r.lastInsertRowid);
        await tx.execute({
          sql: `INSERT INTO corporate_action_event (action_id, at, status, by, note)
                VALUES (?, ?, 'queued', ?, ?)`,
          args: [id, c.now, SYSTEM, JSON.stringify({ d: c.d, queue: "pending" })],
        });
        c.io.written += 2;
        out.inserted += 1;
        const note = { d: c.d, queue: "pending" };
        c.actions.push({
          id,
          code: cand.code,
          type: cand.type,
          ex_date: cand.ex_date,
          payload: cand.payload,
          payloadText,
          sources: [cand.source],
          events: [],
          latest: { id: 0, at: c.now, status: "queued", by: SYSTEM, note: JSON.stringify(note) },
          state: "pending",
          stateSince: c.d,
          note,
        });
      } else {
        out.known += 1; // a racing run inserted it first
      }
      await tx.commit();
    } finally {
      tx.close();
    }
  }
  return out;
}

/**
 * DAT-221 "unexplained-jump check": a stored close-to-close move above the suspect-move threshold
 * on `d` with no action recorded for that code and date yields a price-only candidate, when the
 * move matches a clean split or consolidation ratio.
 * @param {Client} db @param {{ market: string, d: string, io: Io, actions: Action[] }} c
 * @param {{ suspectMovePct: number, priceTolerancePct: number }} cfg
 * @returns {Promise<{ candidates: Candidate[], no_ratio: number }>}
 */
export async function scanJumps(db, c, cfg) {
  const prev = (
    await sel(db, c.io, "SELECT MAX(d) AS d FROM price_bar WHERE market = ? AND d < ?", [
      c.market,
      c.d,
    ])
  )[0]?.d;
  if (prev == null) return { candidates: [], no_ratio: 0 };
  const rows = await sel(
    db,
    c.io,
    `SELECT t.code AS code, t.c AS c1, p.c AS c0
     FROM price_bar t JOIN price_bar p ON p.market = t.market AND p.code = t.code AND p.d = ?
     WHERE t.market = ? AND t.d = ? AND p.c > 0 AND t.c > 0
       AND ABS(t.c * 1.0 / p.c - 1) * 100 > ?
     ORDER BY t.code`,
    [String(prev), c.market, c.d, cfg.suspectMovePct],
  );
  const known = new Set(
    c.actions.filter((a) => a.ex_date === c.d && classOf(a.type) === "price").map((a) => a.code),
  );
  /** @type {Candidate[]} */
  const candidates = [];
  let noRatio = 0;
  for (const r of rows) {
    const code = String(r.code);
    if (known.has(code)) continue;
    const inferred = inferRatio(Number(r.c1) / Number(r.c0), cfg.priceTolerancePct);
    if (!inferred) {
      noRatio += 1;
      continue;
    }
    candidates.push({
      code,
      type: inferred.type,
      ex_date: c.d,
      payload: inferred.payload,
      source: "price",
      ref: null,
    });
  }
  return { candidates, no_ratio: noRatio };
}

// ---------------------------------------------------------------------------------------------
// Evaluate pending, promote, apply due.

/** Price evidence for a group: the ex-date close and the previous stored close. */
async function priceEvidence(db, io, market, code, exDate) {
  const rows = await sel(
    db,
    io,
    "SELECT d, c FROM price_bar WHERE market = ? AND code = ? AND d <= ? ORDER BY d DESC LIMIT 2",
    [market, code, exDate],
  );
  if (rows.length < 2 || String(rows[0].d) !== exDate) return null;
  return { prevClose: Number(rows[1].c), exClose: Number(rows[0].c) };
}

/**
 * Decide every pending action whose evidence is available: auto-confirm, or queue as a conflict
 * (Owner queue for relevant codes, blocked-only otherwise).
 * @param {Client} db @param {{ market: string, d: string, now: string, io: Io, actions: Action[],
 *   relevant: (code: string) => boolean,
 *   adjClose?: Record<string, { prevAdj: number, exAdj: number }> }} c
 * @param {{ priceTolerancePct: number }} cfg
 */
export async function evaluatePending(db, c, cfg) {
  const out = { auto_confirmed: 0, queued_owner: 0, queued_blocked: 0, still_pending: 0 };
  const changed = [];
  const groups = new Map();
  for (const a of c.actions) {
    if (!["pending", "owner", "blocked", "confirmed"].includes(a.state)) continue;
    const k = groupKey(a);
    groups.set(k, [...(groups.get(k) ?? []), a]);
  }
  for (const members of groups.values()) {
    const pending = members.filter((a) => a.state === "pending");
    if (!pending.length) continue;
    const first = members[0];
    const priceClass = classOf(first.type) === "price";
    const price =
      priceClass && first.ex_date <= c.d
        ? await priceEvidence(db, c.io, c.market, first.code, first.ex_date)
        : null;
    const open = members.filter((a) => a.state !== "confirmed");
    const res = evaluateGroup({
      actions: open.map((a) => ({
        id: a.id,
        type: a.type,
        payload: a.payload,
        sources: a.sources,
      })),
      price,
      tolerancePct: cfg.priceTolerancePct,
      hasEffective: members.some((a) => a.state === "confirmed"),
      // GL-01: optional Yahoo adjusted closes (code -> { prevAdj, exAdj }); absent = no veto.
      adj: c.adjClose?.[first.code] ?? null,
    });
    if (res.pending) {
      out.still_pending += pending.length;
      continue;
    }
    for (const dec of res.decisions) {
      const a = open.find((x) => x.id === dec.id);
      if (!a || a.state !== "pending") continue;
      const now = after(c.now, a.latest?.at);
      if (dec.outcome === "auto_confirm") {
        await addEvent(db, c.io, {
          actionId: a.id,
          now,
          status: "auto_confirmed",
          note: { d: c.d, observed: res.observed, sources: a.sources },
        });
        a.state = "confirmed";
        out.auto_confirmed += 1;
      } else {
        const queue = c.relevant(a.code) ? "owner" : "blocked";
        await addEvent(db, c.io, {
          actionId: a.id,
          now,
          status: "queued",
          note: {
            d: c.d,
            queue,
            reasons: dec.reasons,
            score: dec.score,
            observed: res.observed,
            sources: a.sources,
          },
        });
        a.state = queue;
        a.stateSince = c.d;
        a.note = { d: c.d, queue, reasons: dec.reasons, score: dec.score };
        if (queue === "owner") out.queued_owner += 1;
        else out.queued_blocked += 1;
      }
      a.latest = { id: 0, at: now, status: "", by: SYSTEM, note: null };
      changed.push(a);
    }
  }
  return { ...out, changed };
}

/**
 * DAT-221 (s13): a blocked-only conflict whose code becomes held or a candidate moves to the Owner
 * queue now, and the auto-apply timer restarts (note.d is today).
 * @param {Client} db @param {{ market: string, d: string, now: string, io: Io, actions: Action[],
 *   relevant: (code: string) => boolean }} c
 */
export async function promoteBlocked(db, c) {
  let n = 0;
  for (const a of c.actions) {
    if (a.state !== "blocked" || !c.relevant(a.code)) continue;
    const now = after(c.now, a.latest?.at);
    await addEvent(db, c.io, {
      actionId: a.id,
      now,
      status: "queued",
      note: { ...a.note, d: c.d, queue: "owner", promoted: true },
    });
    a.state = "owner";
    a.stateSince = c.d;
    a.latest = { id: 0, at: now, status: "", by: SYSTEM, note: null };
    n += 1;
  }
  return n;
}

async function raiseFlag(db, io, p) {
  const r = await run(
    db,
    io,
    `INSERT INTO data_quality_flag
       (market, code, d, check_id, severity, detail_json, raised_at, cleared_at, blocks_entries)
     SELECT ?, ?, ?, ?, ?, ?, ?, NULL, ?
     WHERE NOT EXISTS (SELECT 1 FROM data_quality_flag
       WHERE market = ? AND code IS ? AND d = ? AND check_id = ? AND cleared_at IS NULL
         AND json_extract(detail_json, '$.action_id') = ?)`,
    [
      p.market,
      p.code,
      p.d,
      p.check,
      p.severity,
      JSON.stringify(p.detail),
      p.now,
      p.blocks ? 1 : 0,
      p.market,
      p.code,
      p.d,
      p.check,
      p.detail.action_id,
    ],
  );
  return r.rowsAffected;
}

/**
 * DAT-221: queued items unresolved after N sessions are applied on the best-evidence
 * interpretation and flagged. One interpretation per (code, ex-date, class) is applied; the
 * others are superseded. If a sibling is already confirmed the due items are superseded.
 * @param {Client} db @param {{ market: string, d: string, now: string, io: Io, actions: Action[] }} c
 * @param {{ autoApplySessions: number }} cfg
 */
export async function applyDue(db, c, cfg) {
  const out = { applied: 0, superseded: 0, changed: [] };
  const owner = c.actions.filter((a) => a.state === "owner" && a.stateSince);
  if (!owner.length) return out;
  const from = owner.reduce((m, a) => (a.stateSince < m ? a.stateSince : m), owner[0].stateSince);
  const cal = (
    await sel(
      db,
      c.io,
      "SELECT d, kind FROM trading_calendar WHERE market = ? AND d >= ? AND d <= ?",
      [c.market, from, c.d],
    )
  ).map((r) => ({ d: String(r.d), kind: String(r.kind) }));
  // GL-01: a price-only inferred action is never auto-applied; it waits for the Owner.
  const due = owner.filter(
    (a) => !isPriceOnly(a.sources) && autoApplyDue(a.stateSince, c.d, cal, cfg.autoApplySessions),
  );
  const done = new Set();
  for (const a of due) {
    const k = groupKey(a);
    if (done.has(k)) continue;
    done.add(k);
    const members = c.actions.filter((x) => groupKey(x) === k);
    const hasEffective = members.some((x) => x.state === "confirmed");
    const openMembers = members.filter((x) => ["owner", "blocked", "pending"].includes(x.state));
    const eligible = openMembers.filter((x) => x.state !== "pending" && !isPriceOnly(x.sources));
    // Nothing but vetoed price-only readings left: they stay queued (and entries stay blocked).
    if (!hasEffective && !eligible.length) continue;
    const best = hasEffective
      ? null
      : pickBestEvidence(eligible.map((x) => ({ id: x.id, score: Number(x.note.score ?? 0) })));
    for (const x of openMembers) {
      const now = after(c.now, x.latest?.at);
      if (best && x.id === best.id) {
        await addEvent(db, c.io, {
          actionId: x.id,
          now,
          status: "applied_best_evidence",
          note: { d: c.d, flagged: true, reasons: x.note.reasons ?? [], score: best.score },
        });
        await raiseFlag(db, c.io, {
          market: c.market,
          code: x.code,
          d: c.d,
          check: BEST_EVIDENCE_CHECK,
          severity: "warning",
          blocks: false,
          detail: { action_id: x.id, ex_date: x.ex_date, type: x.type },
          now: c.now,
        });
        x.state = "confirmed";
        out.applied += 1;
      } else {
        await addEvent(db, c.io, {
          actionId: x.id,
          now,
          status: "resolved",
          note: { d: c.d, resolution: "superseded" },
        });
        x.state = "rejected";
        out.superseded += 1;
      }
      x.latest = { id: 0, at: now, status: "", by: SYSTEM, note: null };
      out.changed.push(x);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Factors, flags and quality re-evaluation (shared with the Owner path).

/**
 * Bring `adjustment_factor` in line with the event history (DAT-222): an effective action has its
 * exact factor, an action that is no longer effective but has factors gets a neutral 1 row.
 * Adds a row only when the effective value changes; never updates one.
 * @param {Client} db @param {{ market: string, now: string, io: Io, actions: Action[] }} c
 */
export async function syncFactors(db, c) {
  const rows = await sel(
    db,
    c.io,
    `SELECT corporate_action_id AS id, factor, computed_at, ref_close_micro FROM adjustment_factor
     WHERE market = ? ORDER BY computed_at`,
    [c.market],
  );
  const latest = new Map();
  for (const r of rows)
    latest.set(Number(r.id), {
      factor: Number(r.factor),
      at: String(r.computed_at),
      ref: r.ref_close_micro === null ? null : Number(r.ref_close_micro),
    });
  let written = 0;
  for (const a of c.actions) {
    const cur = latest.get(a.id);
    const kind = factorKindOf(a.type);
    let want = null;
    let ref = null;
    if (isEffective(a.state)) {
      const f = factorFor(a.type, a.payload);
      want = f === null ? 1 : ratioToNumber(f);
      if (kind === "price") {
        ref = await refCloseOf(db, c.io, c.market, a.code, a.ex_date);
        // DAT-233 (D-237): a price factor other than 1 is used only while its stored reference close
        // still equals the raw close before the ex-date; an Owner-resolved action is the Owner's call.
        if (want !== 1 && a.latest?.by === SYSTEM && !refCloseMatches(cur?.ref ?? null, ref)) {
          const now = after(c.now, a.latest?.at);
          const d = c.now.slice(0, 10);
          const note = { d, queue: "owner", reasons: ["ref_close_mismatch"], score: 0 };
          await addEvent(db, c.io, { actionId: a.id, now, status: "queued", note });
          a.state = "owner";
          a.stateSince = d;
          a.note = note;
          a.latest = { id: 0, at: now, status: "queued", by: SYSTEM, note: JSON.stringify(note) };
          want = 1;
          ref = cur?.ref ?? null;
        }
      }
    } else if (cur) {
      want = 1;
    }
    if (want === null || (cur && Object.is(cur.factor, want))) continue;
    const r = await run(
      db,
      c.io,
      `INSERT INTO adjustment_factor
         (market, code, ex_date, factor, corporate_action_id, computed_at, factor_kind,
          ref_close_micro)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      [c.market, a.code, a.ex_date, want, a.id, after(c.now, cur?.at), kind, ref],
    );
    written += r.rowsAffected;
  }
  return written;
}

/** DAT-233: the raw close before the ex-date in whole micro (null when no earlier bar is stored). */
async function refCloseOf(db, io, market, code, exDate) {
  const rows = await sel(
    db,
    io,
    "SELECT c FROM price_bar WHERE market = ? AND code = ? AND d < ? ORDER BY d DESC LIMIT 1",
    [market, code, exDate],
  );
  return rows.length === 0 ? null : microOfDollars(rows[0].c);
}

/**
 * A stored dollar price (REAL) in whole micro, by its shortest decimal text, never float arithmetic
 * (the .mjs twin of money/micro.ts toMicroFromVendor, which a plain-node CLI cannot import). More than
 * six decimals, or exponent form, rounds half away from zero once on the decimal digits.
 * @param {unknown} value
 * @returns {number | null}
 */
export function microOfDollars(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const text =
    Math.abs(n) < 1e21 && Math.abs(n) >= 1e-6 ? String(Math.abs(n)) : Math.abs(n).toFixed(12);
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (m === null) return null;
  const frac = (m[2] ?? "").padEnd(7, "0");
  let micro = BigInt(m[1] + frac.slice(0, 6));
  if (frac.charCodeAt(6) >= 53) micro += 1n; // first dropped digit >= "5"
  return Number(n < 0 ? -micro : micro);
}

/**
 * GL-02: stamp `known_at` on every action confirmed in this run that has none yet, with the instant of the event
 * that made it effective (announcement-backed auto-confirm, Owner resolve, or the 5-session
 * auto-apply). Set once (the table trigger allows only NULL -> value) and never moved, so a later
 * reversal or recompute cannot re-date it; replays use an action only when known_at <= cut-off(D).
 * @param {Client} db @param {{ market: string, now: string, io: Io, actions: Action[] }} c
 */
export async function syncKnownAt(db, c) {
  let stamped = 0;
  for (const a of c.actions) {
    if (!isEffective(a.state)) continue;
    // only a confirmation made in THIS run is stamped; older effective rows stay NULL (legacy: known)
    if (a.latest === null || a.latest.at < c.now) continue;
    // not counted in io.written: a stamp is bookkeeping on an existing row, run records stay as before
    const r = await db.execute({
      sql: "UPDATE corporate_action SET known_at = ? WHERE id = ? AND market = ? AND known_at IS NULL",
      args: [a.latest.at, a.id, c.market],
    });
    stamped += r.rowsAffected;
  }
  return stamped;
}

/**
 * DAT-222: while an action is unresolved its code is blocked for entries. `assertDate` raises the
 * block for that decision date (the nightly run passes today); every open block of an action that
 * is no longer unresolved is cleared once.
 * @param {Client} db @param {{ market: string, now: string, io: Io, actions: Action[],
 *   assertDate: string | null }} c
 */
export async function syncBlockFlags(db, c) {
  let raised = 0;
  let cleared = 0;
  const unresolved = c.actions.filter((a) => isUnresolved(a.state));
  if (c.assertDate) {
    for (const a of unresolved) {
      raised += await raiseFlag(db, c.io, {
        market: c.market,
        code: a.code,
        d: c.assertDate,
        check: BLOCK_CHECK,
        severity: "warning",
        blocks: true,
        detail: { action_id: a.id, ex_date: a.ex_date, type: a.type, queue: a.state },
        now: c.now,
      });
    }
  }
  const open = await sel(
    db,
    c.io,
    `SELECT id, json_extract(detail_json, '$.action_id') AS action_id FROM data_quality_flag
     WHERE market = ? AND check_id = ? AND cleared_at IS NULL`,
    [c.market, BLOCK_CHECK],
  );
  const stillBlocked = new Set(unresolved.map((a) => a.id));
  for (const f of open) {
    if (stillBlocked.has(Number(f.action_id))) continue;
    const r = await run(
      db,
      c.io,
      "UPDATE data_quality_flag SET cleared_at = ? WHERE id = ? AND cleared_at IS NULL",
      [c.now, Number(f.id)],
    );
    cleared += r.rowsAffected;
  }
  return { raised, cleared };
}

/**
 * Re-run the quality check for the dates a resolved action explains (its ex-date and the next
 * stored bar date), skipping `excludeDate` (the pipeline's own stage 8 runs for it). Only
 * suspect-move flags may be cleared: the re-run has no reject list or re-fetch diffs.
 * @param {Client} db @param {{ market: string, now: string, io: Io, today: string,
 *   changed: { ex_date: string }[], excludeDate: string | null }} c
 */
export async function reevaluateQuality(db, c) {
  const dates = new Set();
  for (const a of c.changed) {
    dates.add(a.ex_date);
    const next = (
      await sel(db, c.io, "SELECT MIN(d) AS d FROM price_bar WHERE market = ? AND d > ?", [
        c.market,
        a.ex_date,
      ])
    )[0]?.d;
    if (next != null) dates.add(String(next));
  }
  const done = [];
  for (const d of [...dates].sort()) {
    if (d === c.excludeDate || d > c.today) continue;
    const has = await sel(
      db,
      c.io,
      "SELECT 1 AS x FROM price_bar WHERE market = ? AND d = ? LIMIT 1",
      [c.market, d],
    );
    if (!has.length) continue;
    await runQuality({
      db,
      market: c.market,
      d,
      io: c.io,
      now: c.now,
      clearOnly: [RULES.suspect_move.id],
    });
    done.push(d);
  }
  return done;
}

/**
 * Factors, entry-block flags and quality re-evaluation after any change of state. Idempotent.
 * @param {Client} db @param {{ market: string, now: string, io: Io, today: string,
 *   assertDate?: string | null, excludeDate?: string | null,
 *   changed?: { ex_date: string }[] }} c
 */
export async function settle(db, c) {
  const actions = await loadActions(db, c.io, c.market);
  const factors = await syncFactors(db, { ...c, actions });
  await syncKnownAt(db, { ...c, actions });
  const flags = await syncBlockFlags(db, { ...c, actions, assertDate: c.assertDate ?? null });
  const reevaluated = await reevaluateQuality(db, {
    ...c,
    changed: c.changed ?? [],
    excludeDate: c.excludeDate ?? null,
  });
  return { factors, flags_raised: flags.raised, flags_cleared: flags.cleared, reevaluated };
}

// ---------------------------------------------------------------------------------------------
// Owner decisions and reversal.

/**
 * Append a `resolved` event for an action, inside one transaction that re-reads the newest event
 * (a second click or a racing run finds the action no longer open). Confirm supersedes the open
 * siblings of the same code, ex-date and class; it is refused if a sibling is already confirmed.
 * `reverse` is for a confirmed action (a new event; its factors become 1 on the next settle).
 * @param {Client} db @param {{ market: string, actionId: number,
 *   decision: "confirm" | "reject" | "reverse", by: string, now: string, d: string, io: Io }} c
 * @returns {Promise<{ ok: true, code: string, type: string, ex_date: string }
 *   | { ok: false, error: "not_found" | "not_open" | "not_confirmed" | "conflicts_with_confirmed" }>}
 */
export async function resolveAction(db, c) {
  const tx = await db.transaction("write");
  try {
    const a = (
      await tx.execute({
        sql: `SELECT id, code, type, ex_date FROM corporate_action WHERE id = ? AND market = ?`,
        args: [c.actionId, c.market],
      })
    ).rows[0];
    if (!a) return { ok: false, error: "not_found" };
    const key = (r) => `${String(r.code)}|${String(r.ex_date)}|${classOf(String(r.type))}`;
    const evs = (
      await tx.execute({
        sql: `SELECT e.action_id, e.at, e.status, e.note FROM corporate_action_event e
              WHERE e.action_id IN (SELECT id FROM corporate_action
                WHERE market = ? AND code = ? AND ex_date = ?) ORDER BY e.id`,
        args: [c.market, String(a.code), String(a.ex_date)],
      })
    ).rows;
    const sib = (
      await tx.execute({
        sql: "SELECT id, code, type, ex_date FROM corporate_action WHERE market = ? AND code = ? AND ex_date = ?",
        args: [c.market, String(a.code), String(a.ex_date)],
      })
    ).rows.filter((r) => key(r) === key(a));
    const latestOf = (id) => {
      const mine = evs.filter((e) => Number(e.action_id) === id);
      const e = mine[mine.length - 1];
      return {
        state: stateOf(
          e ? { status: String(e.status), note: e.note === null ? null : String(e.note) } : null,
        ).state,
        at: e ? String(e.at) : null,
      };
    };
    const me = latestOf(c.actionId);
    if (c.decision === "reverse") {
      if (me.state !== "confirmed") return { ok: false, error: "not_confirmed" };
    } else if (me.state !== "owner" && me.state !== "blocked") {
      return { ok: false, error: "not_open" };
    }
    if (c.decision === "confirm" && sib.some((s) => latestOf(Number(s.id)).state === "confirmed")) {
      return { ok: false, error: "conflicts_with_confirmed" };
    }
    const resolution =
      c.decision === "confirm" ? "confirmed" : c.decision === "reverse" ? "reversed" : "rejected";
    const write = async (id, at, note) =>
      tx.execute({
        sql: `INSERT INTO corporate_action_event (action_id, at, status, by, note)
              VALUES (?, ?, 'resolved', ?, ?)`,
        args: [id, after(c.now, at), c.by, JSON.stringify(note)],
      });
    await write(c.actionId, me.at, { d: c.d, resolution });
    let written = 1;
    if (c.decision === "confirm") {
      // GL-02: the Owner confirmation is the first moment the action is known (set once)
      const stamp = await tx.execute({
        sql: "UPDATE corporate_action SET known_at = ? WHERE id = ? AND known_at IS NULL",
        args: [after(c.now, me.at), c.actionId],
      });
      void stamp; // not counted: bookkeeping on the existing row
    }
    if (c.decision === "confirm") {
      for (const s of sib) {
        const id = Number(s.id);
        if (id === c.actionId) continue;
        const st = latestOf(id);
        if (st.state === "pending" || st.state === "owner" || st.state === "blocked") {
          await write(id, st.at, { d: c.d, resolution: "superseded" });
          written += 1;
        }
      }
    }
    await tx.commit();
    c.io.written += written;
    return { ok: true, code: String(a.code), type: String(a.type), ex_date: String(a.ex_date) };
  } finally {
    tx.close();
  }
}

// ---------------------------------------------------------------------------------------------
// The nightly stage.

/**
 * Stage 4 for one trading date: capture, decide, queue, apply due items, recompute factors, raise
 * and clear entry blocks, re-run quality for earlier affected dates.
 * @param {{ db: Client, market: string, d: string, io: Io, now?: string,
 *   candidates?: Candidate[], relevant?: (code: string) => boolean,
 *   adjClose?: Record<string, { prevAdj: number, exAdj: number }> }} ctx
 */
export async function runCorporateActions(ctx) {
  const { db, market, d, io } = ctx;
  const now = ctx.now ?? new Date().toISOString();
  const relevant = ctx.relevant ?? (() => true);
  const cfg = await readCaConfig(db, io);
  let actions = await loadActions(db, io, market);

  // Provided candidates first, so a price jump that an announcement or vendor field already
  // covers does not become a second, price-only reading of the same event.
  const captured = await captureCandidates(db, {
    market,
    d,
    now,
    io,
    candidates: ctx.candidates ?? [],
    actions,
  });
  const jumps = await scanJumps(db, { market, d, io, actions }, cfg);
  const capturedJumps = await captureCandidates(db, {
    market,
    d,
    now,
    io,
    candidates: jumps.candidates,
    actions,
  });
  captured.inserted += capturedJumps.inserted;
  const base = { market, d, now, io, actions, relevant, adjClose: ctx.adjClose };
  const evaluated = await evaluatePending(db, base, cfg);
  const promoted = await promoteBlocked(db, base);
  const applied = await applyDue(db, base, cfg);
  actions = base.actions;

  const changed = [...evaluated.changed, ...applied.changed];
  const settled = await settle(db, {
    market,
    now,
    io,
    today: d,
    assertDate: d,
    excludeDate: d,
    changed,
  });
  return {
    captured: captured.inserted,
    source_added: captured.source_added,
    invalid: captured.invalid,
    jumps_without_ratio: jumps.no_ratio,
    auto_confirmed: evaluated.auto_confirmed,
    queued_owner: evaluated.queued_owner,
    queued_blocked: evaluated.queued_blocked,
    pending: evaluated.still_pending,
    promoted,
    applied_best_evidence: applied.applied,
    superseded: applied.superseded,
    factors_written: settled.factors,
    flags_raised: settled.flags_raised,
    flags_cleared: settled.flags_cleared,
    reevaluated: settled.reevaluated,
  };
}

/** The Batch 1 stage-4 hook: the pipeline's context in, the engine's summary out. */
export const corporateActionsHook = async (c) =>
  runCorporateActions({
    db: c.db,
    market: c.market,
    d: c.d,
    io: c.io,
    now: c.now,
    candidates: c.candidates,
    relevant: c.relevant,
    adjClose: c.adjClose,
  });
