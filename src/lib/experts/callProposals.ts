// Structured-call proposals (M22 E3; KB-084, D-1435, D-543, D-524). The typed face of the plain engine in
// `callEngine.mjs` (which the Node scripts also load) plus the stored side: proposals are rows of
// `expert_call_proposal` (append-only, 0039), complete or not. A proposal NEVER tracks itself: `expert_call` is written
// only by the Owner's confirmation (`confirmCall` in review.ts) and by the seed importer, so the paper tracker
// (`settleCalls`) reads confirmed calls only. This file reads the universe and the calendar for the context of a
// summary; it writes only proposal rows. A model is reached only through the injected `ask` (the night's router, wired
// outside this folder), never built or imported here.
import { createHash } from "node:crypto";
import {
  answerOf,
  candidateCodes,
  extractFacts,
  parseModelAnswer,
  proposeCallStructure,
  type CallAnswer,
  type CallField,
  type CallProposalCore,
  type CallState,
  type CalendarIn,
  type CallUniverseIn,
  type PriceBasis,
} from "./callEngine.mjs";
import type { Exec } from "./store";

export {
  CALL_ANSWER_SCHEMA,
  CALL_FIELDS,
  FIELD_WORDS,
  candidateCodes,
  proposeCallStructure,
  rulesAnswer,
} from "./callEngine.mjs";
export type { CallAnswer, CallField, CallState, CalendarIn, CallUniverseIn, PriceBasis };

export type ProposalSource = "rules" | "model" | "owner";
/** A proposal as stored: the engine's answer, the claim it belongs to, and its id. */
export type CallProposal = Omit<CallProposalCore, "source"> & {
  proposalId: string;
  claimId: string;
  source: ProposalSource;
  modelId: string | null;
};

const IN_CHUNK = 50; // threshold-ok: codes asked per statement
const PENDING_LIMIT = 200; // threshold-ok: claims proposed per run (the daily extraction cap is far lower)
const REASON_MAX = 200; // threshold-ok: expert_call_proposal.reason cap (0039)

const s = (v: unknown): string => String(v);
const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const sn = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** The proposal id: the hash of the claim and every field, so the same proposal has the same id (and is stored once). */
export function proposalIdOf(
  claimId: string,
  p: Omit<CallProposalCore, "source"> & { source: ProposalSource },
): string {
  const parts = [
    claimId,
    p.market,
    p.code,
    p.direction,
    p.callD,
    p.horizonSessions,
    p.priceBasis,
    p.targetMicro,
    p.stopMicro,
    p.state,
    p.source,
  ].map((x) => (x === null ? "-" : String(x)));
  return createHash("sha256")
    .update(`call-proposal-1|${parts.join("|")}`)
    .digest("hex");
}

export function withIds(
  claimId: string,
  p: Omit<CallProposalCore, "source"> & { source: ProposalSource },
  modelId: string | null = null,
): CallProposal {
  return { ...p, claimId, modelId, proposalId: proposalIdOf(claimId, p) };
}

/**
 * The universe of a summary: which of its capitalised tokens are active codes of the market's newest snapshot at or
 * before `day`. Asking only for the tokens of the texts keeps the read to a few rows, not the whole universe.
 */
export async function resolveUniverse(
  db: Exec,
  market: string,
  day: string,
  summaries: readonly string[],
): Promise<CallUniverseIn> {
  const tokens = [...new Set(summaries.flatMap((t) => candidateCodes(t)))];
  const codes = new Set<string>();
  for (let i = 0; i < tokens.length; i += IN_CHUNK) {
    const chunk = tokens.slice(i, i + IN_CHUNK);
    // rows-ok: at most IN_CHUNK rows (one per asked code), primary-key lookups on (market, d, code).
    const r = await db.execute({
      sql: `SELECT code FROM universe_snapshot
             WHERE market = ? AND status = 'active'
               AND d = (SELECT MAX(d) FROM universe_snapshot WHERE market = ? AND d <= ?)
               AND code IN (${chunk.map(() => "?").join(",")})`,
      args: [market, market, day, ...chunk],
    });
    for (const row of r.rows) codes.add(s(row.code));
  }
  return { market, codes };
}

/** The market's holiday rows (a few a year): the calendar a horizon in weeks or months is counted on. */
export async function loadHolidays(db: Exec, market: string): Promise<CalendarIn> {
  // rows-ok: holiday rows of one market, about ten a year.
  const r = await db.execute({
    sql: "SELECT d, kind FROM trading_calendar WHERE market = ? AND kind = 'holiday' ORDER BY d",
    args: [market],
  });
  return r.rows.map((row) => ({ d: s(row.d), kind: s(row.kind) }));
}

export type CallAsk = (req: {
  summary: string;
  rules: CallAnswer;
  /** The answer when it has the shape and is grounded in the summary, else null. */
  parse: (v: unknown) => CallAnswer | null;
}) => Promise<{ value: CallAnswer; live: boolean; modelId: string | null }>;

/**
 * One claim's proposal. Rules-only (no `ask`, or a router that answered with the rules) is the deterministic
 * answer; a live model answer is used only when it is grounded (D-1435), and any other outcome falls back to rules.
 */
export async function proposeForClaim(
  claimId: string,
  summary: string,
  universe: CallUniverseIn,
  calendar: CalendarIn,
  ask?: CallAsk,
): Promise<CallProposal> {
  const rules = proposeCallStructure(summary, universe, calendar);
  if (ask !== undefined && rules.state !== "not_trackable") {
    const facts = extractFacts(summary, universe);
    const res = await ask({
      summary,
      rules: answerOf(rules, facts),
      parse: (v) =>
        parseModelAnswer(summary, v, universe, calendar) === null ? null : (v as CallAnswer),
    });
    if (res.live) {
      const m = parseModelAnswer(summary, res.value, universe, calendar);
      if (m !== null) return withIds(claimId, { ...m, source: "model" }, res.modelId);
    }
  }
  return withIds(claimId, { ...rules, source: "rules" });
}

/** Appends the proposal (insert-or-ignore on its id: the same proposal is stored once). */
export async function storeProposal(db: Exec, p: CallProposal, at: string): Promise<boolean> {
  // rows-ok: one row, keyed by the proposal id.
  const r = await db.execute({
    sql: `INSERT OR IGNORE INTO expert_call_proposal (proposal_id, claim_id, market, code, direction, call_d,
            horizon_sessions, price_basis, target_micro, stop_micro, state, reason, source, model_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      p.proposalId,
      p.claimId,
      p.market,
      p.code,
      p.direction,
      p.callD,
      p.horizonSessions,
      p.priceBasis,
      p.targetMicro,
      p.stopMicro,
      p.state,
      p.reason.slice(0, REASON_MAX),
      p.source,
      p.modelId,
      at,
    ],
  });
  return r.rowsAffected === 1;
}

const MISSING_FIELDS: readonly CallField[] = ["code", "direction", "date", "horizon"];
const fromRow = (r: Record<string, unknown>): CallProposal => {
  const p = {
    proposalId: s(r.proposal_id),
    claimId: s(r.claim_id),
    market: s(r.market),
    code: sn(r.code),
    direction: sn(r.direction) as CallProposal["direction"],
    callD: sn(r.call_d),
    horizonSessions: n(r.horizon_sessions),
    priceBasis: s(r.price_basis) as PriceBasis,
    targetMicro: n(r.target_micro),
    stopMicro: n(r.stop_micro),
    state: s(r.state) as CallState,
    reason: s(r.reason),
    source: s(r.source) as ProposalSource,
    modelId: sn(r.model_id),
    missing: [] as CallField[],
  };
  if (p.state === "incomplete") {
    p.missing = MISSING_FIELDS.filter((f) =>
      f === "code"
        ? p.code === null
        : f === "direction"
          ? p.direction === null
          : f === "date"
            ? p.callD === null
            : p.horizonSessions === null,
    );
  }
  return p;
};

export async function proposalById(db: Exec, proposalId: string): Promise<CallProposal | null> {
  // rows-ok: one row by primary key.
  const r = await db.execute({
    sql: "SELECT * FROM expert_call_proposal WHERE proposal_id = ?",
    args: [proposalId],
  });
  return r.rows[0] === undefined ? null : fromRow(r.rows[0] as Record<string, unknown>);
}

/** The newest stored proposal of each call claim (by time, then id); claims with none are absent. */
export async function latestProposals(db: Exec): Promise<Map<string, CallProposal>> {
  // rows-ok: proposals of call claims; one per claim and source at most a handful, bounded by the call claims.
  const r = await db.execute(
    "SELECT * FROM expert_call_proposal ORDER BY claim_id, created_at DESC, proposal_id DESC",
  );
  const out = new Map<string, CallProposal>();
  for (const row of r.rows) {
    const p = fromRow(row as Record<string, unknown>);
    if (!out.has(p.claimId)) out.set(p.claimId, p);
  }
  return out;
}

export type ConfirmedCall = {
  claimId: string;
  market: string;
  code: string;
  direction: "long" | "short";
  callD: string;
  horizonSessions: number;
  tracked: boolean;
};
/** The calls that are tracked or stored (rows of `expert_call`), by claim. */
export async function confirmedCalls(db: Exec): Promise<Map<string, ConfirmedCall>> {
  // rows-ok: one row per call claim (the seed's 28 plus the Owner's confirmations).
  const r = await db.execute(
    "SELECT claim_id, market, code, direction, call_d, horizon_sessions, tracked FROM expert_call ORDER BY claim_id",
  );
  return new Map(
    r.rows.map((row) => [
      s(row.claim_id),
      {
        claimId: s(row.claim_id),
        market: s(row.market),
        code: s(row.code),
        direction: s(row.direction) as "long" | "short",
        callD: s(row.call_d),
        horizonSessions: Number(row.horizon_sessions),
        tracked: Number(row.tracked) === 1,
      },
    ]),
  );
}

export type PendingCall = { claimId: string; summary: string };
/**
 * Call claims the extraction wrote (actor `extract`, type `call`) that have no proposal yet and no `expert_call`
 * (E2 hand-off). Oldest id first, at most `limit`; no paging offset (the proposal written removes a claim from the list).
 */
export async function pendingCallClaims(db: Exec, limit = PENDING_LIMIT): Promise<PendingCall[]> {
  // rows-ok: capped by LIMIT (PENDING_LIMIT).
  const r = await db.execute({
    sql: `SELECT c.id AS id,
                 (SELECT v.statement FROM claim_revision v WHERE v.claim_id = c.id ORDER BY v.seq DESC LIMIT 1) AS statement
            FROM claim c
            JOIN claim_status st ON st.claim_id = c.id AND st.seq = 1
           WHERE c.type = 'call' AND st.actor = 'extract'
             AND NOT EXISTS (SELECT 1 FROM expert_call_proposal p WHERE p.claim_id = c.id)
             AND NOT EXISTS (SELECT 1 FROM expert_call k WHERE k.claim_id = c.id)
           ORDER BY c.id LIMIT ?`,
    args: [Math.min(Math.max(1, Math.trunc(limit)), PENDING_LIMIT)],
  });
  return r.rows.map((row) => ({ claimId: s(row.id), summary: s(row.statement) }));
}

export type ProposeReport = {
  looked: number;
  complete: number;
  incomplete: number;
  notTrackable: number;
  model: number;
};

/**
 * Writes one proposal for each pending call claim (rules, or a grounded model answer through `ask`). Never writes an
 * `expert_call`: only the Owner's confirmation does.
 */
export async function proposePending(
  db: Exec,
  x: { market: string; day: string; now: () => Date; ask?: CallAsk },
): Promise<ProposeReport> {
  const rep: ProposeReport = { looked: 0, complete: 0, incomplete: 0, notTrackable: 0, model: 0 };
  const pending = await pendingCallClaims(db);
  if (pending.length === 0) return rep;
  const universe = await resolveUniverse(
    db,
    x.market,
    x.day,
    pending.map((p) => p.summary),
  );
  const calendar = await loadHolidays(db, x.market);
  for (const c of pending) {
    const p = await proposeForClaim(c.claimId, c.summary, universe, calendar, x.ask);
    if (await storeProposal(db, p, x.now().toISOString())) {
      rep.looked += 1;
      if (p.state === "complete") rep.complete += 1;
      else if (p.state === "incomplete") rep.incomplete += 1;
      else rep.notTrackable += 1;
      if (p.source === "model") rep.model += 1;
    }
  }
  return rep;
}

/** The current statement of every call claim (raw text), by claim id: what the queue computes proposals from. */
export async function callStatements(db: Exec): Promise<Map<string, string>> {
  // rows-ok: one row per call claim (the seed's 28 plus the night's extractions).
  const r = await db.execute(
    `SELECT c.id AS id,
            (SELECT v.statement FROM claim_revision v WHERE v.claim_id = c.id ORDER BY v.seq DESC LIMIT 1) AS statement
       FROM claim c WHERE c.type = 'call' ORDER BY c.id`,
  );
  return new Map(r.rows.map((row) => [s(row.id), s(row.statement)]));
}
