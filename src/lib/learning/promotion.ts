// Promotion, force-apply, rollback, retire, kill-switch freeze and the holdout roll (M6 T10; ARN-065,
// ARN-067, ARN-082, ARN-085, ARN-092, KB-040..043, KB-050, AGT-042; D-076, D-090, D-093/D-094,
// D-110 #18, #19, #22, D-119; docs/M6_design.md 2.8 and 2.9; D-121 proposed). HIGH RISK: this is the
// code that changes which rule version trades money.
//
// Shape. A change of a family's live version has two halves:
//   1. a REQUEST by the Owner (requestPromotion / requestForceApply / requestRollback): one
//      transaction that writes the `promotion` row (pending), any new `rule_version` (force and
//      rollback copy parameters into a NEW immutable version, KB-011) and the APPROVAL RECORD, a
//      `change_ledger` row carrying the Owner's audit reference (ROL-102, audit-first). Nothing
//      else changes: the live version is unchanged until the restart.
//   2. the APPLICATION, at the family's next group restart (ARN-053, D-076: the twins restart
//      together, so "the target's next cohort boundary" and "both twins' next common boundary" are
//      the same session). cohortWriter.runTerminalChecks calls selectDueChangeIn and
//      commitChangeIn inside the restart transaction: successors of the family's executions start
//      with the new `rule_version`, `execution.rule_version` changes (the only allowed change), the
//      promotion goes pending -> applied, status history and the change ledger are written, and a
//      promoted challenger moves approved -> promoted. Ending and shadow cohorts keep their version
//      (their `cohort.rule_version` is immutable). The restart transaction has no clock: rows are
//      stamped with the restart date, so a replay writes the same bytes.
//
// A pending change with no approval record, a stale one (the live version moved, the target version
// retired, the challenger no longer approved) never applies: stale ones are cancelled at the restart.
// Promotion (not force-apply, not rollback) also waits for the weekly cap and for a frozen family
// (an arena_control `killed` row, KB-043); force-apply and rollback need neither VAL-110 nor the
// cap (D-110 #19) and, for a killed family, a second confirmation recorded in the approval row.
//
// After a PROMOTION only: rollAfterPromotion rolls the lineage split (ARN-082), re-freezes the
// lesson windows and rolls the trial budget (D-078 #26), idempotently, keyed by the promotion id.
import type { Client, Transaction } from "@libsql/client";
import type { StatsParams } from "@/lib/agents/params";
import type { Family } from "@/lib/agents/schema";
import { CONFIG_KEYS } from "@/lib/config/keys";
import {
  lineageId,
  maxHoldingUpperBound,
  rolledBudgetAtRoll,
  rollLineageSplit,
  type LineageSplitRecord,
  type TrialLedgerRow,
} from "@/lib/stats/splits";
import {
  familyFrozen,
  incumbentOf,
  loadChallenger,
  promotionCapacity,
  type PromotionCapacity,
} from "./challengerLifecycle";
import { paramsJson } from "./ruleVersions";
import { CHALLENGER_EDGES, type ChallengerRow, type ChallengerState } from "./schema";
import { freezeLessonWindow, lessonWindowRow, splitLessonWindows } from "./windows";

type Exec = Pick<Client | Transaction, "execute">;

const text = (v: unknown): string => String(v);
const num = (v: unknown): number => Number(v);

export class PromotionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PromotionError";
    this.code = code;
  }
}

export type ChangeKind = "promotion" | "force_apply" | "rollback";

/** The weekly cap used when the caller passes none (the registry default, ch.15 `max_promotions_per_week`). */
export const DEFAULT_MAX_PROMOTIONS_PER_WEEK = CONFIG_KEYS["max_promotions_per_week"]
  .default as number;

/** Actors that are never the Owner: an approval event by one of them is not an Owner approval. */
const SYSTEM_ACTORS: ReadonlySet<string> = new Set(["A6", "A7", "system"]);

export const groupOf = (family: Family): string => `TW-${family}`;
const baseId = (market: string, family: string, kind: ChangeKind, key: string): string =>
  `PR:${market}:${family}:${kind}:${key}`;

// ---- small readers --------------------------------------------------------------------------------------------

type VersionRow = {
  readonly id: string;
  readonly market: string;
  readonly family: Family;
  readonly n: number;
  readonly parent: string | null;
  readonly origin: string;
  readonly params_json: string;
  readonly params_sha: string;
  readonly spec_json: string;
  readonly schema_version: number;
  readonly registered_d: string;
};

async function versionRow(db: Exec, id: string): Promise<VersionRow | null> {
  const rs = await db.execute({ sql: "SELECT * FROM rule_version WHERE id = ?", args: [id] });
  if (rs.rows.length === 0) return null;
  const r = rs.rows[0]!;
  return {
    id: text(r.id),
    market: text(r.market),
    family: text(r.family) as Family,
    n: num(r.n),
    parent: r.parent === null ? null : text(r.parent),
    origin: text(r.origin),
    params_json: text(r.params_json),
    params_sha: text(r.params_sha),
    spec_json: text(r.spec_json),
    schema_version: num(r.schema_version),
    registered_d: text(r.registered_d),
  };
}

async function statuses(db: Exec, id: string): Promise<string[]> {
  const rs = await db.execute({
    sql: "SELECT status FROM rule_version_status WHERE rule_version_id = ? ORDER BY seq",
    args: [id],
  });
  return rs.rows.map((r) => text(r.status));
}

/** Appends a status unless it is already the latest (idempotent); never after `retired`. */
async function appendStatus(
  tx: Exec,
  id: string,
  status: "registered" | "live" | "shadow" | "retired",
  d: string,
  reason: string,
): Promise<boolean> {
  const rs = await tx.execute({
    sql: `SELECT seq, status FROM rule_version_status WHERE rule_version_id = ?
          ORDER BY seq DESC LIMIT 1`,
    args: [id],
  });
  const last = rs.rows[0];
  if (last !== undefined && text(last.status) === status) return false;
  if (last !== undefined && text(last.status) === "retired") {
    throw new PromotionError("retired", `${id} is retired`);
  }
  await tx.execute({
    sql: `INSERT INTO rule_version_status (rule_version_id, seq, status, d, reason)
          VALUES (?, ?, ?, ?, ?)`,
    args: [id, last === undefined ? 1 : num(last.seq) + 1, status, d, reason],
  });
  return true;
}

type LedgerIn = {
  readonly market: string;
  readonly kind: string;
  readonly target: string;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly lessonIdsJson?: string;
  readonly challengerId?: string | null;
  readonly effectiveD: string;
  readonly actor: string;
  readonly auditRef: string | null;
  readonly createdAt: string;
};

async function ledgerFind(
  tx: Exec,
  market: string,
  kind: string,
  target: string,
): Promise<{
  id: number;
  auditRef: string | null;
  actor: string;
  after: Record<string, unknown>;
} | null> {
  const rs = await tx.execute({
    sql: `SELECT id, audit_ref, actor, after_json FROM change_ledger
          WHERE market = ? AND kind = ? AND target = ? ORDER BY id LIMIT 1`,
    args: [market, kind, target],
  });
  if (rs.rows.length === 0) return null;
  const r = rs.rows[0]!;
  return {
    id: num(r.id),
    auditRef: r.audit_ref === null ? null : text(r.audit_ref),
    actor: text(r.actor),
    after: r.after_json === null ? {} : (JSON.parse(text(r.after_json)) as Record<string, unknown>),
  };
}

async function ledgerInsert(tx: Exec, r: LedgerIn): Promise<number> {
  const res = await tx.execute({
    sql: `INSERT INTO change_ledger (market, kind, target, before_json, after_json, lesson_ids_json,
            challenger_id, effective_d, actor, audit_ref, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      r.market,
      r.kind,
      r.target,
      r.before === undefined ? null : paramsJson(r.before as Record<string, unknown>),
      r.after === undefined ? null : paramsJson(r.after as Record<string, unknown>),
      r.lessonIdsJson ?? "[]",
      r.challengerId ?? null,
      r.effectiveD,
      r.actor,
      r.auditRef,
      r.createdAt,
    ],
  });
  return Number(res.lastInsertRowid);
}

/** The instant a restart-transaction row is stamped with: the restart date, no clock (replay parity). */
const stampOf = (d: string): string => `${d}T00:00:00.000Z`;

type PromotionRow = {
  readonly id: string;
  readonly market: string;
  readonly family: Family;
  readonly kind: ChangeKind;
  readonly from_version: string;
  readonly to_version: string;
  readonly challenger_id: string | null;
  readonly approved_at: string;
  readonly approved_by: string;
  readonly status: "pending" | "applied" | "cancelled";
  readonly applied_d: string | null;
  readonly group_id: string;
};

function promotionFrom(r: Record<string, unknown>): PromotionRow {
  return {
    id: text(r.id),
    market: text(r.market),
    family: text(r.family) as Family,
    kind: text(r.kind) as ChangeKind,
    from_version: text(r.from_version),
    to_version: text(r.to_version),
    challenger_id: r.challenger_id === null ? null : text(r.challenger_id),
    approved_at: text(r.approved_at),
    approved_by: text(r.approved_by),
    status: text(r.status) as PromotionRow["status"],
    applied_d: r.applied_d === null ? null : text(r.applied_d),
    group_id: text(r.group_id),
  };
}

export async function loadPromotion(db: Exec, id: string): Promise<PromotionRow | null> {
  const rs = await db.execute({ sql: "SELECT * FROM promotion WHERE id = ?", args: [id] });
  return rs.rows.length === 0 ? null : promotionFrom(rs.rows[0]!);
}

/** The pending changes of a market (oldest first). */
export async function pendingChanges(db: Exec, market: string): Promise<PromotionRow[]> {
  const rs = await db.execute({
    sql: `SELECT * FROM promotion WHERE market = ? AND status = 'pending' ORDER BY approved_at, id`,
    args: [market],
  });
  return rs.rows.map((r) => promotionFrom(r));
}

const scheduleTarget = (family: string, promotionId: string): string =>
  `${family}/schedule/${promotionId}`;

/** The approval record of a promotion row: its schedule ledger row (null = no record, never applies). */
async function approvalOf(tx: Exec, p: PromotionRow) {
  const row = await ledgerFind(tx, p.market, p.kind, scheduleTarget(p.family, p.id));
  if (row === null || row.auditRef === null || row.auditRef.trim() === "") return null;
  return row;
}

// ---- challenger moves done inside another transaction ---------------------------------------------------------

/**
 * One KB-040 edge written inside the caller's transaction (transitionChallenger opens its own).
 * `state_d` is monotone in the database, so the date never goes backwards.
 */
async function moveChallengerIn(
  tx: Exec,
  row: ChallengerRow,
  to: ChallengerState,
  d: string,
  actor: string,
  reason: string,
  ref: Record<string, unknown>,
): Promise<boolean> {
  if (row.state === to) return false;
  if (!CHALLENGER_EDGES[row.state].includes(to)) {
    throw new PromotionError("edge", `${row.id}: ${row.state} -> ${to} is not a KB-040 edge`);
  }
  const stateD = d < row.state_d ? row.state_d : d;
  const clearReady = (row.state === "review" || row.state === "approved") && to !== "promoted";
  await tx.execute({
    sql: `UPDATE challenger SET state = ?, state_d = ?${clearReady ? ", ready = 0" : ""} WHERE id = ?`,
    args: [to, stateD, row.id],
  });
  const seq = await tx.execute({
    sql: "SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM challenger_event WHERE challenger_id = ?",
    args: [row.id],
  });
  await tx.execute({
    sql: `INSERT INTO challenger_event (challenger_id, seq, from_state, to_state, d, actor, reason, ref_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [row.id, num(seq.rows[0]!.s), row.state, to, stateD, actor, reason, paramsJson(ref)],
  });
  return true;
}

// ---- requests (Owner) -------------------------------------------------------------------------------------------

export type RequestBase = {
  readonly market: string;
  /** The Melbourne date of the request. */
  readonly d: string;
  /** The Owner (user id hash). */
  readonly actor: string;
  /** The audit-log entry of the Owner's action (ROL-102, required). */
  readonly auditRef: string;
  /** ISO-8601 UTC instant of the request. */
  readonly now: string;
  /** Second confirmation for a killed family (force-apply and rollback only, decision 19). */
  readonly confirmKilled?: boolean;
};

export type RequestRefusal =
  | "unknown_challenger"
  | "unknown_version"
  | "wrong_market"
  | "not_approved"
  | "not_ready"
  | "no_approval_event"
  | "approval_not_owner"
  | "family_frozen"
  | "confirmation_required"
  | "no_live_version"
  | "stale_incumbent"
  | "pending_exists"
  | "challenger_state"
  | "same_version"
  | "not_prior_live";

export type RequestResult =
  | {
      readonly status: "scheduled";
      readonly promotionId: string;
      readonly toVersion: string;
      readonly groupId: string;
      /** False when the identical request already existed (nothing written). */
      readonly created: boolean;
    }
  | { readonly status: "refused"; readonly reason: RequestRefusal; readonly detail: string };

function need(base: RequestBase): void {
  if (base.actor.trim() === "")
    throw new PromotionError("actor", "a change needs the Owner as actor");
  if (base.auditRef.trim() === "")
    throw new PromotionError("audit_ref", "a change needs the Owner's audit reference");
}

const refused = (reason: RequestRefusal, detail: string): RequestResult => ({
  status: "refused",
  reason,
  detail,
});

async function inTx<T>(db: Client, body: (tx: Transaction) => Promise<T>): Promise<T> {
  const tx = await db.transaction("write");
  try {
    const out = await body(tx);
    await tx.commit();
    return out;
  } catch (e) {
    try {
      await tx.rollback();
    } catch {
      // already rolled back
    }
    throw e;
  } finally {
    tx.close();
  }
}

/** A request that already exists for this key and is not cancelled is returned as is (idempotent). */
async function existingRequest(
  tx: Exec,
  base: string,
): Promise<{ existing: PromotionRow | null; id: string }> {
  const rs = await tx.execute({
    sql: "SELECT * FROM promotion WHERE id = ? OR id LIKE ? ORDER BY id",
    args: [base, `${base}#%`],
  });
  const rows = rs.rows.map((r) => promotionFrom(r));
  const live = rows.find((r) => r.status !== "cancelled");
  if (live !== undefined) return { existing: live, id: live.id };
  return { existing: null, id: rows.length === 0 ? base : `${base}#${rows.length + 1}` };
}

async function pendingFor(tx: Exec, market: string, family: Family): Promise<PromotionRow | null> {
  const rs = await tx.execute({
    sql: `SELECT * FROM promotion WHERE market = ? AND family = ? AND status = 'pending' LIMIT 1`,
    args: [market, family],
  });
  return rs.rows.length === 0 ? null : promotionFrom(rs.rows[0]!);
}

async function writeRequest(
  tx: Exec,
  base: RequestBase,
  p: {
    readonly id: string;
    readonly family: Family;
    readonly kind: ChangeKind;
    readonly from: string;
    readonly to: string;
    readonly challengerId: string | null;
    readonly approvedBy: string;
    readonly lessonIdsJson?: string;
    readonly frozen: boolean;
    readonly extra?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.execute({
    sql: `INSERT INTO promotion (id, market, family, kind, from_version, to_version, challenger_id,
            approved_at, approved_by, status, group_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    args: [
      p.id,
      base.market,
      p.family,
      p.kind,
      p.from,
      p.to,
      p.challengerId,
      base.now,
      p.approvedBy,
      groupOf(p.family),
    ],
  });
  await ledgerInsert(tx, {
    market: base.market,
    kind: p.kind,
    target: scheduleTarget(p.family, p.id),
    before: { version: p.from },
    after: {
      status: "scheduled",
      version: p.to,
      group: groupOf(p.family),
      second_confirmation: p.frozen && base.confirmKilled === true,
      ...(p.extra ?? {}),
    },
    lessonIdsJson: p.lessonIdsJson,
    challengerId: p.challengerId,
    effectiveD: base.d,
    actor: base.actor,
    auditRef: base.auditRef,
    createdAt: base.now,
  });
}

/**
 * Schedules the PROMOTION of an approved and ready challenger (ARN-065, KB-040, AGT-042). Needs the
 * Owner's approval event (review -> approved by a non-system actor), the `ready` mark, a family that
 * is not frozen and an incumbent that is still the live version. One transaction; the same request
 * again returns the first (nothing written). It applies at the family's next group restart, within
 * the weekly cap (selectDueChangeIn).
 */
export async function requestPromotion(
  db: Client,
  base: RequestBase & { readonly challengerId: string },
): Promise<RequestResult> {
  need(base);
  return inTx(db, async (tx) => {
    const ch = await loadChallenger(tx, base.challengerId);
    if (ch === null) return refused("unknown_challenger", base.challengerId);
    const rv = await versionRow(tx, ch.rule_version_id);
    if (rv === null) return refused("unknown_version", ch.rule_version_id);
    if (rv.market !== base.market) return refused("wrong_market", rv.market);
    const family = rv.family;
    const key = baseId(base.market, family, "promotion", ch.id);
    const prior = await existingRequest(tx, key);
    if (prior.existing !== null) {
      return {
        status: "scheduled",
        promotionId: prior.existing.id,
        toVersion: prior.existing.to_version,
        groupId: prior.existing.group_id,
        created: false,
      };
    }
    if (ch.state !== "approved") return refused("not_approved", `${ch.id} is ${ch.state}`);
    if (ch.ready !== 1) return refused("not_ready", `${ch.id}: a Critic check has not passed`);
    const ev = await tx.execute({
      sql: `SELECT actor FROM challenger_event WHERE challenger_id = ? AND to_state = 'approved'
            ORDER BY seq DESC LIMIT 1`,
      args: [ch.id],
    });
    if (ev.rows.length === 0) return refused("no_approval_event", `${ch.id} has no approval event`);
    const approver = text(ev.rows[0]!.actor);
    if (SYSTEM_ACTORS.has(approver)) {
      return refused("approval_not_owner", `${ch.id} was approved by ${approver}`);
    }
    if (await familyFrozen(tx, base.market, family)) {
      return refused("family_frozen", `${family} is killed: no promotion (KB-043)`);
    }
    const live = await incumbentOf(tx, base.market, family);
    if (live === null) return refused("no_live_version", family);
    if (live !== ch.incumbent_version_id) {
      return refused(
        "stale_incumbent",
        `${ch.id} was tested against ${ch.incumbent_version_id}, ${live} is live`,
      );
    }
    if ((await pendingFor(tx, base.market, family)) !== null) {
      return refused("pending_exists", `${family} already has a pending change`);
    }
    await writeRequest(tx, base, {
      id: prior.id,
      family,
      kind: "promotion",
      from: live,
      to: ch.rule_version_id,
      challengerId: ch.id,
      approvedBy: approver,
      lessonIdsJson: ch.lesson_ids_json,
      frozen: false,
    });
    return {
      status: "scheduled",
      promotionId: prior.id,
      toVersion: ch.rule_version_id,
      groupId: groupOf(family),
      created: true,
    };
  });
}

/** Copies a version's parameters into a NEW immutable version (origin force / rollback). */
async function copyVersionIn(
  tx: Exec,
  source: VersionRow,
  origin: "force" | "rollback",
  parent: string,
  d: string,
  actor: string,
): Promise<string> {
  const n = await tx.execute({
    sql: "SELECT COALESCE(MAX(n), 0) + 1 AS n FROM rule_version WHERE market = ? AND family = ?",
    args: [source.market, source.family],
  });
  const next = num(n.rows[0]!.n);
  const id = `${source.family}.v${next}`;
  await tx.execute({
    sql: `INSERT INTO rule_version (id, market, family, n, parent, origin, params_json, params_sha,
            spec_json, schema_version, registered_d, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      source.market,
      source.family,
      next,
      parent,
      origin,
      source.params_json,
      source.params_sha,
      source.spec_json,
      source.schema_version,
      d,
      actor,
    ],
  });
  await appendStatus(
    tx,
    id,
    "registered",
    d,
    origin === "force" ? "forced by Owner" : `rollback of ${source.id}`,
  );
  return id;
}

/**
 * Schedules the FORCE-APPLY of a challenger whose checks did not all pass, or of an Owner version
 * (AGT-042, KB-050, decision 22): a challenger in review or approved, or an Owner-origin version in
 * any undecided state. The challenger's parameters are copied into a new version (origin `force`,
 * label UNVALIDATED "forced by Owner"); this is NOT a promotion: no VAL-110, no cap count, no roll.
 * The challenger itself is left as it is. A killed family needs `confirmKilled`.
 */
export async function requestForceApply(
  db: Client,
  base: RequestBase & { readonly challengerId: string },
): Promise<RequestResult> {
  need(base);
  return inTx(db, async (tx) => {
    const ch = await loadChallenger(tx, base.challengerId);
    if (ch === null) return refused("unknown_challenger", base.challengerId);
    const rv = await versionRow(tx, ch.rule_version_id);
    if (rv === null) return refused("unknown_version", ch.rule_version_id);
    if (rv.market !== base.market) return refused("wrong_market", rv.market);
    const family = rv.family;
    const key = baseId(base.market, family, "force_apply", ch.id);
    const prior = await existingRequest(tx, key);
    if (prior.existing !== null) {
      return {
        status: "scheduled",
        promotionId: prior.existing.id,
        toVersion: prior.existing.to_version,
        groupId: prior.existing.group_id,
        created: false,
      };
    }
    const undecided = ["proposed", "replay", "shakedown", "review", "approved"].includes(ch.state);
    const eligible =
      ch.state === "review" || ch.state === "approved" || (undecided && ch.origin === "owner");
    if (!eligible) return refused("challenger_state", `${ch.id} is ${ch.state} (${ch.origin})`);
    const frozen = await familyFrozen(tx, base.market, family);
    if (frozen && base.confirmKilled !== true) {
      return refused(
        "confirmation_required",
        `${family} is killed: a second confirmation is needed`,
      );
    }
    const live = await incumbentOf(tx, base.market, family);
    if (live === null) return refused("no_live_version", family);
    if (live === rv.id) return refused("same_version", `${rv.id} is already live`);
    if ((await pendingFor(tx, base.market, family)) !== null) {
      return refused("pending_exists", `${family} already has a pending change`);
    }
    const to = await copyVersionIn(tx, rv, "force", live, base.d, base.actor);
    await writeRequest(tx, base, {
      id: prior.id,
      family,
      kind: "force_apply",
      from: live,
      to,
      challengerId: ch.id,
      approvedBy: base.actor,
      lessonIdsJson: ch.lesson_ids_json,
      frozen,
      extra: { label: "UNVALIDATED", qualifier: "forced by Owner", copied_from: rv.id },
    });
    return {
      status: "scheduled",
      promotionId: prior.id,
      toVersion: to,
      groupId: groupOf(family),
      created: true,
    };
  });
}

/**
 * Schedules a ROLLBACK to an earlier version of the family that has been live before (ARN-067,
 * KB-043, decision 19): a new version (origin `rollback`, parent = the current head, parameters
 * copied), applied at the next restart; no VAL-110, no cap count, no roll; label UNVALIDATED
 * "rollback of <v>"; history is never rewritten. A killed family needs `confirmKilled`.
 */
export async function requestRollback(
  db: Client,
  base: RequestBase & { readonly family: Family; readonly toVersion: string },
): Promise<RequestResult> {
  need(base);
  return inTx(db, async (tx) => {
    const family = base.family;
    const target = await versionRow(tx, base.toVersion);
    if (target === null) return refused("unknown_version", base.toVersion);
    if (target.market !== base.market || target.family !== family) {
      return refused("wrong_market", `${base.toVersion} is not a ${base.market} ${family} version`);
    }
    const live = await incumbentOf(tx, base.market, family);
    if (live === null) return refused("no_live_version", family);
    const key = baseId(base.market, family, "rollback", `${live}:${target.id}`);
    const prior = await existingRequest(tx, key);
    if (prior.existing !== null) {
      return {
        status: "scheduled",
        promotionId: prior.existing.id,
        toVersion: prior.existing.to_version,
        groupId: prior.existing.group_id,
        created: false,
      };
    }
    const liveRow = (await versionRow(tx, live))!;
    if (target.id === live || target.n >= liveRow.n) {
      return refused("same_version", `${target.id} is not earlier than the live ${live}`);
    }
    if (!(await statuses(tx, target.id)).includes("live")) {
      return refused("not_prior_live", `${target.id} has never been live`);
    }
    const frozen = await familyFrozen(tx, base.market, family);
    if (frozen && base.confirmKilled !== true) {
      return refused(
        "confirmation_required",
        `${family} is killed: a second confirmation is needed`,
      );
    }
    if ((await pendingFor(tx, base.market, family)) !== null) {
      return refused("pending_exists", `${family} already has a pending change`);
    }
    const to = await copyVersionIn(tx, target, "rollback", live, base.d, base.actor);
    await writeRequest(tx, base, {
      id: prior.id,
      family,
      kind: "rollback",
      from: live,
      to,
      challengerId: null,
      approvedBy: base.actor,
      frozen,
      extra: {
        label: "UNVALIDATED",
        qualifier: `rollback of ${target.id}`,
        copied_from: target.id,
      },
    });
    return {
      status: "scheduled",
      promotionId: prior.id,
      toVersion: to,
      groupId: groupOf(family),
      created: true,
    };
  });
}

export type CancelResult = { readonly status: "cancelled" | "unchanged" | "applied" | "unknown" };

/**
 * Cancels a pending change (Owner, audit reference required). A force or rollback version that was
 * created for it and never went live is retired. An applied or already cancelled change is left alone.
 */
export async function cancelChange(
  db: Client,
  input: {
    readonly promotionId: string;
    readonly d: string;
    readonly actor: string;
    readonly auditRef: string;
    readonly now: string;
    readonly reason: string;
  },
): Promise<CancelResult> {
  if (input.actor.trim() === "")
    throw new PromotionError("actor", "a cancel needs the Owner as actor");
  if (input.auditRef.trim() === "")
    throw new PromotionError("audit_ref", "a cancel needs the Owner's audit reference");
  return inTx(db, async (tx) => {
    const p = await loadPromotion(tx, input.promotionId);
    if (p === null) return { status: "unknown" };
    if (p.status === "applied") return { status: "applied" };
    if (p.status === "cancelled") return { status: "unchanged" };
    await cancelIn(tx, p, input.d, input.actor, input.auditRef, input.now, input.reason);
    return { status: "cancelled" };
  });
}

async function cancelIn(
  tx: Exec,
  p: PromotionRow,
  d: string,
  actor: string,
  auditRef: string | null,
  now: string,
  reason: string,
): Promise<void> {
  await tx.execute({
    sql: "UPDATE promotion SET status = 'cancelled' WHERE id = ? AND status = 'pending'",
    args: [p.id],
  });
  if (p.kind !== "promotion") {
    const st = await statuses(tx, p.to_version);
    if (st.length > 0 && !st.includes("live") && !st.includes("retired")) {
      await appendStatus(tx, p.to_version, "retired", d, `cancelled: ${reason}`);
    }
  }
  await ledgerInsert(tx, {
    market: p.market,
    kind: p.kind,
    target: `${p.family}/cancel/${p.id}`,
    before: { status: "pending", version: p.to_version },
    after: { status: "cancelled", reason },
    challengerId: p.challenger_id,
    effectiveD: d,
    actor,
    auditRef,
    createdAt: now,
  });
}

// ---- application at the group restart --------------------------------------------------------------------------

export type DueChange = {
  readonly promotion: PromotionRow;
  /** Audit reference of the approval record. */
  readonly auditRef: string;
  readonly label: string | null;
  readonly qualifier: string | null;
};

export type DueScan = {
  readonly due: DueChange | null;
  /** Pending rows that can never apply (stale); the commit cancels them. */
  readonly stale: readonly { readonly promotion: PromotionRow; readonly why: string }[];
};

export type AppliedChange = {
  readonly promotionId: string;
  readonly family: Family;
  readonly kind: ChangeKind;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly ledgerId: number;
};

export type CommitResult = {
  readonly applied: AppliedChange | null;
  /** Stale pending rows cancelled by this restart. */
  readonly cancelled: readonly string[];
};

function noTable(e: unknown): boolean {
  return /no such table/i.test(e instanceof Error ? e.message : String(e));
}

/**
 * Reads the change to apply at the restart of `group` on `restartD` (read only, inside the restart
 * transaction). At most one: the oldest pending row that has its approval record, whose `from`
 * version is still live, whose target is not retired, whose challenger (promotion) is still approved
 * and ready, and that the weekly cap and the freeze allow. A database without migration 0010 gives
 * an empty scan.
 */
export async function selectDueChangeIn(
  tx: Exec,
  input: {
    readonly group: string;
    readonly restartD: string;
    readonly maxPromotionsPerWeek?: number;
  },
): Promise<DueScan> {
  let rows: PromotionRow[];
  try {
    const rs = await tx.execute({
      sql: `SELECT * FROM promotion WHERE group_id = ? AND status = 'pending' ORDER BY approved_at, id`,
      args: [input.group],
    });
    rows = rs.rows.map((r) => promotionFrom(r));
  } catch (e) {
    if (noTable(e)) return { due: null, stale: [] };
    throw e;
  }
  const stale: { promotion: PromotionRow; why: string }[] = [];
  let due: DueChange | null = null;
  for (const p of rows) {
    const approval = await approvalOf(tx, p);
    if (approval === null) continue; // no approval record: never applies, never silently dropped
    const live = await incumbentOf(tx, p.market, p.family);
    if (live !== p.from_version) {
      stale.push({ promotion: p, why: `live version is ${live ?? "none"}, not ${p.from_version}` });
      continue;
    }
    const st = await statuses(tx, p.to_version);
    if (st.length === 0 || st.includes("retired")) {
      stale.push({ promotion: p, why: `${p.to_version} is retired or unknown` });
      continue;
    }
    if (p.kind === "promotion") {
      const ch = p.challenger_id === null ? null : await loadChallenger(tx, p.challenger_id);
      if (
        ch === null ||
        ch.state === "rejected" ||
        ch.state === "retired" ||
        ch.state === "promoted"
      ) {
        stale.push({
          promotion: p,
          why: `challenger ${p.challenger_id} is ${ch?.state ?? "unknown"}`,
        });
        continue;
      }
      if (ch.state !== "approved" || ch.ready !== 1) continue; // not (yet) approved + ready: waits
      const cap: PromotionCapacity = await promotionCapacity(
        tx,
        p.market,
        p.family,
        input.restartD,
        {
          maxPromotionsPerWeek: input.maxPromotionsPerWeek ?? DEFAULT_MAX_PROMOTIONS_PER_WEEK,
        },
      );
      if (!cap.allowed) continue; // weekly cap or frozen family: waits
    } else if (await familyFrozen(tx, p.market, p.family)) {
      if (approval.after.second_confirmation !== true) continue; // killed family without the second confirmation
    }
    if (due === null) {
      due = {
        promotion: p,
        auditRef: approval.auditRef!,
        label: typeof approval.after.label === "string" ? approval.after.label : null,
        qualifier: typeof approval.after.qualifier === "string" ? approval.after.qualifier : null,
      };
    }
  }
  return { due, stale };
}

/**
 * Writes the application of `scan.due` in the restart transaction, after the successors were
 * started: execution rows, promotion applied, version status history, challenger promoted, the
 * change ledger. Stale rows are cancelled. Returns null when there is nothing to apply.
 */
export async function commitChangeIn(
  tx: Exec,
  scan: DueScan,
  at: { readonly closeD: string; readonly restartD: string; readonly group: string },
): Promise<CommitResult> {
  const cancelled: string[] = [];
  for (const s of scan.stale) {
    await cancelIn(tx, s.promotion, at.restartD, "system", null, stampOf(at.restartD), s.why);
    cancelled.push(s.promotion.id);
  }
  const due = scan.due;
  if (due === null) return { applied: null, cancelled };
  const p = due.promotion;
  const upd = await tx.execute({
    sql: `UPDATE promotion SET status = 'applied', applied_d = ? WHERE id = ? AND status = 'pending'`,
    args: [at.restartD, p.id],
  });
  if (upd.rowsAffected === 0) return { applied: null, cancelled };
  // the family's executions (E, C2, C3 of the twin group) trade the new version from now on
  await tx.execute({
    sql: `UPDATE execution SET rule_version = ? WHERE market = ? AND family = ? AND twin_group = ?`,
    args: [p.to_version, p.market, p.family, at.group],
  });
  await appendStatus(tx, p.from_version, "shadow", at.restartD, `superseded by ${p.to_version}`);
  await appendStatus(
    tx,
    p.to_version,
    "live",
    at.restartD,
    `${p.kind} applied at ${at.group} restart`,
  );
  if (p.kind === "promotion" && p.challenger_id !== null) {
    const ch = await loadChallenger(tx, p.challenger_id);
    if (ch !== null) {
      await moveChallengerIn(
        tx,
        ch,
        "promoted",
        at.restartD,
        "system",
        `promoted at ${at.group} restart`,
        {
          promotion: p.id,
          approved_by: p.approved_by,
          audit_ref: due.auditRef,
        },
      );
    }
  }
  const ledgerId = await ledgerInsert(tx, {
    market: p.market,
    kind: p.kind,
    target: p.to_version,
    before: { version: p.from_version },
    after: {
      version: p.to_version,
      applied_d: at.restartD,
      close_d: at.closeD,
      group: at.group,
      promotion: p.id,
      label: p.kind === "promotion" ? null : due.label,
      qualifier: due.qualifier,
    },
    challengerId: p.challenger_id,
    effectiveD: at.restartD,
    actor: p.approved_by,
    auditRef: due.auditRef,
    createdAt: stampOf(at.restartD),
  });
  return {
    applied: {
      promotionId: p.id,
      family: p.family,
      kind: p.kind,
      fromVersion: p.from_version,
      toVersion: p.to_version,
      ledgerId,
    },
    cancelled,
  };
}

// ---- kill-switch freeze (KB-043, ARN-093) -------------------------------------------------------------------------

export type FreezeResult =
  | { readonly status: "not_killed" }
  | { readonly status: "unchanged"; readonly controlId: number }
  | {
      readonly status: "recorded";
      readonly controlId: number;
      readonly ledgerId: number;
      readonly cancelled: readonly string[];
    };

/**
 * Records the freeze of a killed family: one `kill_freeze` ledger row per `arena_control` kill row
 * (idempotent) and the cancellation of its pending PROMOTIONS (a killed family gets no promotion;
 * the challenger stays approved and needs a new request after the family is enabled again).
 * Force-apply and rollback stay possible with the second confirmation. The freeze itself changes no
 * prompt, so the KB version does not move. Promotion is blocked at request and at the restart even
 * when this record has not been written yet.
 */
export async function recordKillFreeze(
  db: Client,
  input: {
    readonly market: string;
    readonly family: Family;
    readonly d: string;
    readonly now: string;
    readonly actor?: string;
  },
): Promise<FreezeResult> {
  return inTx(db, async (tx) => {
    if (!(await familyFrozen(tx, input.market, input.family))) return { status: "not_killed" };
    const rs = await tx.execute(
      "SELECT id, scope, scope_key, state FROM arena_control ORDER BY id",
    );
    let controlId = 0;
    for (const r of rs.rows) {
      const hit =
        (text(r.scope) === "family" && text(r.scope_key) === input.family) ||
        (text(r.scope) === "market" && text(r.scope_key) === input.market);
      if (hit && text(r.state) === "killed") controlId = num(r.id);
    }
    const target = `${input.family}/freeze`;
    const rows = await tx.execute({
      sql: `SELECT after_json FROM change_ledger WHERE market = ? AND kind = 'kill_freeze' AND target = ?`,
      args: [input.market, target],
    });
    if (
      rows.rows.some(
        (r) =>
          num((JSON.parse(text(r.after_json)) as { control_id: number }).control_id) === controlId,
      )
    ) {
      return { status: "unchanged", controlId };
    }
    const pend = await tx.execute({
      sql: `SELECT * FROM promotion WHERE market = ? AND family = ? AND status = 'pending'
            AND kind = 'promotion' ORDER BY id`,
      args: [input.market, input.family],
    });
    const cancelled: string[] = [];
    for (const r of pend.rows) {
      const p = promotionFrom(r);
      await tx.execute({
        sql: "UPDATE promotion SET status = 'cancelled' WHERE id = ? AND status = 'pending'",
        args: [p.id],
      });
      cancelled.push(p.id);
    }
    const ledgerId = await ledgerInsert(tx, {
      market: input.market,
      kind: "kill_freeze",
      target,
      after: { control_id: controlId, cancelled_promotions: cancelled },
      effectiveD: input.d,
      actor: input.actor ?? "system",
      auditRef: null,
      createdAt: input.now,
    });
    return { status: "recorded", controlId, ledgerId, cancelled };
  });
}

// ---- retire (ARN-092) ---------------------------------------------------------------------------------------------

export type RetireRefusal = "unknown_version" | "live_version" | "held_by_cohort" | "wrong_market";
export type RetireResult =
  | { readonly status: "retired"; readonly ledgerId: number; readonly challengerRetired: boolean }
  | { readonly status: "unchanged" }
  | { readonly status: "refused"; readonly reason: RetireRefusal; readonly detail: string };

/**
 * Retires a rule version (a challenger version FAILED at a forward look or dominated, or an Owner
 * decision). The live version is never retired (it needs a rollback or a promotion to replace it,
 * "never left without a version"), nor one that an unfinished cohort still holds. Needs a basis:
 * the Owner's audit reference or the evidence reference of the learning run. Moves a challenger of
 * the version to `retired`, cancels a pending change that targets it, and writes a `retire` ledger row.
 */
export async function retireRuleVersion(
  db: Client,
  input: {
    readonly market: string;
    readonly versionId: string;
    readonly d: string;
    readonly now: string;
    readonly actor: string;
    readonly reason: string;
    readonly auditRef?: string;
    readonly evidenceRef?: string;
  },
): Promise<RetireResult> {
  if (input.actor.trim() === "") throw new PromotionError("actor", "a retirement needs an actor");
  const basis =
    (input.auditRef ?? "").trim() !== "" ? input.auditRef! : (input.evidenceRef ?? "").trim();
  if (basis === "")
    throw new PromotionError(
      "basis",
      "a retirement needs an audit reference or an evidence reference",
    );
  return inTx(db, async (tx) => {
    const v = await versionRow(tx, input.versionId);
    if (v === null)
      return { status: "refused", reason: "unknown_version", detail: input.versionId };
    if (v.market !== input.market)
      return { status: "refused", reason: "wrong_market", detail: v.market };
    const st = await statuses(tx, v.id);
    if (st[st.length - 1] === "retired") return { status: "unchanged" };
    if (st[st.length - 1] === "live") {
      return { status: "refused", reason: "live_version", detail: `${v.id} is the live version` };
    }
    const short = `v${v.n}`;
    const held = await tx.execute({
      sql: `SELECT 1 FROM cohort WHERE terminal_kind IS NULL AND (rule_version = ? OR rule_version = ?) LIMIT 1`,
      args: [v.id, short],
    });
    if (held.rows.length > 0) {
      return {
        status: "refused",
        reason: "held_by_cohort",
        detail: `${v.id} is held by an unfinished cohort`,
      };
    }
    await appendStatus(tx, v.id, "retired", input.d, input.reason);
    const pend = await tx.execute({
      sql: "SELECT * FROM promotion WHERE to_version = ? AND status = 'pending'",
      args: [v.id],
    });
    for (const r of pend.rows) {
      await cancelIn(
        tx,
        promotionFrom(r),
        input.d,
        input.actor,
        input.auditRef ?? null,
        input.now,
        `${v.id} retired`,
      );
    }
    const chs = await tx.execute({
      sql: "SELECT id FROM challenger WHERE rule_version_id = ?",
      args: [v.id],
    });
    let challengerRetired = false;
    let challengerId: string | null = null;
    for (const r of chs.rows) {
      const ch = await loadChallenger(tx, text(r.id));
      if (ch === null) continue;
      challengerId = ch.id;
      if (ch.state === "promoted" || ch.state === "rejected" || ch.state === "retired") continue;
      await moveChallengerIn(tx, ch, "retired", input.d, input.actor, input.reason, {
        basis: input.auditRef !== undefined ? "audit_ref" : "evidence_ref",
        ref: basis,
      });
      challengerRetired = true;
    }
    const ledgerId = await ledgerInsert(tx, {
      market: input.market,
      kind: "retire",
      target: v.id,
      after: { status: "retired", reason: input.reason, evidence_ref: input.evidenceRef ?? null },
      challengerId,
      effectiveD: input.d,
      actor: input.actor,
      auditRef: input.auditRef ?? null,
      createdAt: input.now,
    });
    return { status: "retired", ledgerId, challengerRetired };
  });
}

// ---- the roll after a promotion (ARN-082, ARN-063, ARN-085) ---------------------------------------------------------

export type RollInput = {
  readonly promotionId: string;
  /** Ascending session dates up to the data end. */
  readonly calendar: readonly string[];
  /** Realised rows of the lineage's primary variant (for the block re-measurement). */
  readonly primaryRows: readonly { readonly entryD: string; readonly exitD: string | null }[];
  readonly stats: StatsParams;
  readonly now: string;
};

export type RollResult =
  | {
      readonly status: "rolled";
      readonly splitVersion: number;
      /** The trial budget total of the new split (m minus the overlap-weighted accesses, D-078 #26). */
      readonly budgetTotal: number;
      readonly lessonWindowFrozen: boolean;
      readonly deferred: boolean;
    }
  | { readonly status: "unchanged"; readonly splitVersion: number }
  | { readonly status: "not_applied" | "not_a_promotion" | "no_split" };

export const rollMarker = (promotionId: string): string => `promotion:${promotionId}`;

function splitFrom(r: Record<string, unknown>): LineageSplitRecord {
  const opt = (v: unknown): string | null => (v === null || v === undefined ? null : text(v));
  return {
    lineage_id: text(r.lineage_id),
    version: num(r.version),
    block_sessions: num(r.block_sessions),
    holdout_len: num(r.holdout_len),
    validation_len: num(r.validation_len),
    purge: num(r.purge),
    data_end_d: text(r.data_end_d),
    holdout_start_d: opt(r.holdout_start_d),
    holdout_end_d: opt(r.holdout_end_d),
    validation_start_d: opt(r.validation_start_d),
    validation_end_d: opt(r.validation_end_d),
    dev_end_d: opt(r.dev_end_d),
    deferred_until_d: opt(r.deferred_until_d),
    reason: text(r.reason) as "create" | "roll",
    measured_on_run: opt(r.measured_on_run),
  };
}

/**
 * Rolls the lineage after an APPLIED promotion (never after a force-apply or a rollback): a new
 * `lineage_split` version (reason `roll`, marker `promotion:<id>`) from `rollLineageSplit`, the
 * lesson windows re-frozen for it, and the rolled trial budget recorded in a ledger row that carries
 * the promotion's Owner audit reference. One transaction; the marker makes a second call a no-op.
 * The promoted version shows "validation passed - holdout pending" until its holdout confirmation.
 */
export async function rollAfterPromotion(db: Client, input: RollInput): Promise<RollResult> {
  return inTx(db, async (tx) => {
    const p = await loadPromotion(tx, input.promotionId);
    if (p === null || p.status !== "applied" || p.applied_d === null)
      return { status: "not_applied" };
    if (p.kind !== "promotion") return { status: "not_a_promotion" };
    const lineage = lineageId(p.market, p.family);
    const marker = rollMarker(p.id);
    const done = await tx.execute({
      sql: "SELECT version FROM lineage_split WHERE lineage_id = ? AND measured_on_run = ?",
      args: [lineage, marker],
    });
    if (done.rows.length > 0)
      return { status: "unchanged", splitVersion: num(done.rows[0]!.version) };
    const prevRs = await tx.execute({
      sql: "SELECT * FROM lineage_split WHERE lineage_id = ? ORDER BY version DESC LIMIT 1",
      args: [lineage],
    });
    if (prevRs.rows.length === 0) return { status: "no_split" };
    const previous = splitFrom(prevRs.rows[0]!);
    const approval = await approvalOf(tx, p);
    const rv = await versionRow(tx, p.to_version);
    const ch = p.challenger_id === null ? null : await loadChallenger(tx, p.challenger_id);
    const anchorD = [p.applied_d, rv?.registered_d ?? "", ch?.shadow_viewed_d ?? ""].reduce(
      (a, b) => (b > a ? b : a),
    );
    const split = rollLineageSplit({
      market: p.market,
      family: p.family,
      previous,
      calendar: input.calendar,
      maxHoldingUpper: maxHoldingUpperBound(p.family),
      primaryRows: input.primaryRows,
      params: input.stats,
      anchorD,
      measuredOnRun: marker,
    });
    await tx.execute({
      sql: `INSERT INTO lineage_split (lineage_id, version, block_sessions, holdout_len, validation_len,
              purge, data_end_d, holdout_start_d, holdout_end_d, validation_start_d, validation_end_d,
              dev_end_d, deferred_until_d, reason, measured_on_run)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        split.lineage_id,
        split.version,
        split.block_sessions,
        split.holdout_len,
        split.validation_len,
        split.purge,
        split.data_end_d,
        split.holdout_start_d,
        split.holdout_end_d,
        split.validation_start_d,
        split.validation_end_d,
        split.dev_end_d,
        split.deferred_until_d,
        split.reason,
        split.measured_on_run,
      ],
    });
    let lessonWindowFrozen = false;
    if (split.dev_end_d !== null) {
      const dev = input.calendar.filter((d) => d <= split.dev_end_d!);
      const w = splitLessonWindows(dev, split.purge);
      if (w !== null) {
        await freezeLessonWindow(
          tx,
          lessonWindowRow(lineage, split.version, w, split.block_sessions, marker),
        );
        lessonWindowFrozen = true;
      }
    }
    const trials = await tx.execute({
      sql: `SELECT id, market, lineage_id, split_version, kind, rule_version, variant, run_id, d
            FROM trial_ledger WHERE lineage_id = ? AND split_version = ?`,
      args: [lineage, previous.version],
    });
    const ledger: TrialLedgerRow[] = trials.rows.map((r) => ({
      id: text(r.id),
      market: text(r.market),
      lineage_id: text(r.lineage_id),
      split_version: num(r.split_version),
      kind: text(r.kind) as TrialLedgerRow["kind"],
      rule_version: r.rule_version === null ? null : text(r.rule_version),
      variant: r.variant === null ? null : text(r.variant),
      run_id: r.run_id === null ? null : text(r.run_id),
      d: text(r.d),
    }));
    const budgetTotal = rolledBudgetAtRoll(
      ledger,
      previous,
      split,
      input.calendar,
      input.stats.trialBudgetPerLineage,
    );
    await ledgerInsert(tx, {
      market: p.market,
      kind: "promotion",
      target: `${p.family}/split/${split.version}`,
      before: { split_version: previous.version },
      after: {
        promotion: p.id,
        split_version: split.version,
        budget_total: budgetTotal,
        holdout_start_d: split.holdout_start_d,
        holdout_end_d: split.holdout_end_d,
        validation_start_d: split.validation_start_d,
        validation_end_d: split.validation_end_d,
        dev_end_d: split.dev_end_d,
        deferred_until_d: split.deferred_until_d,
        block_sessions: split.block_sessions,
        lesson_window: lessonWindowFrozen,
      },
      challengerId: p.challenger_id,
      effectiveD: p.applied_d,
      actor: "A6",
      auditRef: approval?.auditRef ?? null,
      createdAt: input.now,
    });
    return {
      status: "rolled",
      splitVersion: split.version,
      budgetTotal,
      lessonWindowFrozen,
      deferred: split.deferred_until_d !== null,
    };
  });
}

/** Applied promotions whose roll has not been written yet (the learning run calls rollAfterPromotion for each). */
export async function promotionsAwaitingRoll(db: Exec, market: string): Promise<string[]> {
  const rs = await db.execute({
    sql: `SELECT p.id FROM promotion p
          WHERE p.market = ? AND p.kind = 'promotion' AND p.status = 'applied'
            AND NOT EXISTS (SELECT 1 FROM lineage_split s
                            WHERE s.lineage_id = ? || ':' || p.family AND s.measured_on_run = 'promotion:' || p.id)
          ORDER BY p.applied_d, p.id`,
    args: [market, market],
  });
  return rs.rows.map((r) => text(r.id));
}

/**
 * The trial budget total of a lineage's split version: the rolled value recorded at the roll, else
 * `base` (the first-split budget m). Pass it as `budgetTotal` to createChallenger and the evidence run.
 */
export async function budgetTotalFor(
  db: Exec,
  market: string,
  family: Family,
  splitVersion: number,
  base: number,
): Promise<number> {
  const row = await ledgerFind(db, market, "promotion", `${family}/split/${splitVersion}`);
  const v = row?.after.budget_total;
  return typeof v === "number" ? v : base;
}
