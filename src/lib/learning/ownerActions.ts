// Owner and Editor actions of the learning loop (M6 T14; ROL-102, ROL-102b, KB-050/051, UX-071/071a;
// docs/M6_design.md 4.7; D-033..D-040 auth pattern, D-047 audit before write, D-111, D-119, D-121;
// D-125 draft). HIGH RISK: these are the only entry points that let a person change which rule
// version trades money or which lesson is applied.
//
// Pattern (the D-047 / controls.ts shape; two databases, so no single transaction):
//   1. refuse what needs no audit row: wrong input, missing confirmation, a market in data-only mode;
//   2. append the audit event in the auth DB FIRST -> its id is the Owner audit reference;
//   3. call the learning writer (main DB, one transaction of its own) with that reference;
//   4. when the writer refuses or throws, append `<action>_failed` (best effort) -- the audit row
//      stays, no change exists without an audit row (a refused one leaves only the failure trail).
// The actor is always the session user (`u<id>`), never a field of the request.
//
// Annotations live in the auth DB only; their audit event and the change commit in ONE transaction
// (audit appended first inside it). Annotation text is never read by anything that builds an LLM
// context (LLM-036, KB-051): this file is the only reader besides the pages.
import type { Client } from "@libsql/client";
import { loadAgentParams } from "@/lib/agents/params";
import { FAMILY_PARAM_KEYS } from "@/lib/agents/families/ruleSchema";
import type { Family } from "@/lib/agents/schema";
import { auditTx, requireKey, type RequestMeta } from "@/lib/auth/audit";
import type { AuthEnv } from "@/lib/auth/env";
import type { CurrentUser } from "@/lib/auth/session";
import { marketDate } from "@/lib/data/calendar";
import { appendAudit, auditKey } from "@/lib/db/audit";
import {
  ChallengerError,
  createChallenger,
  familyFrozen,
  incumbentOf,
  loadChallenger,
  transitionChallenger,
} from "./challengerLifecycle";
import {
  PromotionError,
  requestForceApply,
  requestPromotion,
  requestRollback,
  retireRuleVersion,
  type RequestBase,
} from "./promotion";
import { forceApplyLesson, LaneAError } from "./laneA";

export const MARKET = "AU";
export const ANNOTATION_MAX_CHARS = 1000; // ROL-102b
export const ANNOTATION_KINDS = ["lesson", "card", "hypothesis"] as const;
export type AnnotationKind = (typeof ANNOTATION_KINDS)[number];

export type OwnerCtx = {
  readonly mainDb: Client;
  readonly authDb: Client;
  readonly env: AuthEnv;
  readonly meta: RequestMeta;
  readonly now?: () => Date;
};

export type ActionResult = { readonly status: number; readonly body: Record<string, unknown> };
const res = (status: number, body: Record<string, unknown>): ActionResult => ({ status, body });
const bad = (error: string, status = 400): ActionResult => res(status, { error });

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
export const actorOf = (user: Pick<CurrentUser, "id">): string => `u${user.id}`;
const nowOf = (c: OwnerCtx): Date => (c.now ? c.now() : new Date());
const melbourneD = (now: Date): string => marketDate(now, "Australia/Melbourne");
const idOk = (s: unknown): s is string =>
  typeof s === "string" && s.length > 0 && s.length <= 200 && !/[\s\u0000-\u001f]/.test(s);

// ---- the audit-first runner --------------------------------------------------------------------------

export type Outcome =
  { readonly ok: true; readonly body: Record<string, unknown> } | RefusedOutcome;
type RefusedOutcome = {
  readonly ok: false;
  readonly reason: string;
  readonly detail?: string;
  readonly status?: number;
};

async function marketMode(db: Client): Promise<string | null> {
  const r = await db.execute({ sql: "SELECT mode FROM market WHERE code = ?", args: [MARKET] });
  return r.rows.length === 0 ? null : String(r.rows[0]!.mode);
}

export type Step = {
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly detail: Record<string, unknown>;
  readonly run: (auditRef: string, d: string, now: string) => Promise<Outcome>;
};

/** Owner-only action: data-only refusal, audit event first, writer second, `_failed` on any failure. */
export async function audited(c: OwnerCtx, user: CurrentUser, step: Step): Promise<ActionResult> {
  const now = nowOf(c);
  const at = now.toISOString();
  let mode: string | null;
  try {
    mode = await marketMode(c.mainDb);
  } catch {
    return bad("unavailable", 503);
  }
  if (mode === "data_only") return res(409, { error: "market_data_only" });
  const ev = (action: string, detail: Record<string, unknown>) =>
    appendAudit(c.authDb, auditKey(requireKey(c.env)), {
      at,
      actorUserId: user.id,
      action,
      targetType: step.targetType,
      targetId: step.targetId,
      detail,
      ip: c.meta.ip,
      userAgent: c.meta.userAgent,
    });
  let id: number;
  try {
    id = await ev(step.action, step.detail);
  } catch {
    return bad("unavailable", 503); // nothing has changed
  }
  const failed = async (detail: Record<string, unknown>) => {
    try {
      await ev(`${step.action}_failed`, { ...step.detail, ...detail, auditId: id });
    } catch {
      // best effort: the change did not happen either way
    }
  };
  let out: Outcome;
  try {
    out = await step.run(`audit:${id}`, melbourneD(now), at);
  } catch (e) {
    const known = e instanceof PromotionError || e instanceof ChallengerError;
    await failed({ error: known ? (e as Error).message : "write_failed" });
    return known
      ? res(409, { error: "refused", detail: (e as Error).message })
      : bad("unavailable", 503);
  }
  if (!out.ok) {
    await failed({ reason: out.reason, detail: out.detail ?? null });
    return res(out.status ?? 409, { error: out.reason, detail: out.detail ?? null });
  }
  return res(200, { ok: true, auditId: id, ...out.body });
}

function refusal(r: { reason: string; detail: string }): RefusedOutcome {
  return { ok: false, reason: r.reason, detail: r.detail };
}

// ---- challenger actions ----------------------------------------------------------------------------------------

type Body = Record<string, unknown>;
const confirmed = (b: Body): boolean => b.confirm === true;

/** The family of a challenger's rule version (null when unknown). */
async function familyOfChallenger(db: Client, id: string): Promise<Family | null> {
  const r = await db.execute({
    sql: `SELECT v.family FROM challenger c JOIN rule_version v ON v.id = c.rule_version_id
          WHERE c.id = ? AND v.market = ?`,
    args: [id, MARKET],
  });
  return r.rows.length === 0 ? null : (String(r.rows[0]!.family) as Family);
}

const killedFamily = (db: Client, family: Family): Promise<boolean> =>
  familyFrozen(db, MARKET, family);

/** Common pre-checks (no audit row): confirmation, challenger exists, second confirmation for a killed family. */
async function challengerGate(
  c: OwnerCtx,
  id: string,
  b: Body,
  secondForKilled: boolean,
): Promise<ActionResult | null> {
  if (!idOk(id)) return bad("invalid");
  if (!confirmed(b)) return res(409, { error: "confirmation_required" });
  try {
    const fam = await familyOfChallenger(c.mainDb, id);
    if (fam === null) return bad("not_found", 404);
    if (secondForKilled && b.confirm_killed !== true && (await killedFamily(c.mainDb, fam))) {
      return res(409, { error: "second_confirmation_required", family: fam });
    }
  } catch {
    return bad("unavailable", 503);
  }
  return null;
}

const baseOf = (user: CurrentUser, auditRef: string, d: string, now: string, b: Body) =>
  ({
    market: MARKET,
    d,
    actor: actorOf(user),
    auditRef,
    now,
    confirmKilled: b.confirm_killed === true,
  }) satisfies RequestBase;

/** Approve: review -> approved (Owner event), then the promotion request (applies at the restart). */
export async function approveChallenger(
  c: OwnerCtx,
  user: CurrentUser,
  id: string,
  b: Body,
): Promise<ActionResult> {
  const g = await challengerGate(c, id, b, false);
  if (g) return g;
  return audited(c, user, {
    action: "learning.challenger_approve",
    targetType: "challenger",
    targetId: id,
    detail: { challenger: id },
    run: async (auditRef, d, now) => {
      const ch = await loadChallenger(c.mainDb, id);
      if (ch === null) return { ok: false, reason: "not_found", status: 404 };
      if (ch.state === "review") {
        await transitionChallenger(
          c.mainDb,
          {
            id,
            to: "approved",
            d: d < ch.state_d ? ch.state_d : d,
            actor: actorOf(user),
            reason: "approved by Owner",
            ref: { audit_ref: auditRef },
          },
          (await loadAgentParams(c.mainDb)).learning,
        );
      } else if (ch.state !== "approved") {
        return { ok: false, reason: "not_in_review", detail: `${id} is ${ch.state}` };
      }
      const promotion = await requestPromotion(c.mainDb, {
        ...baseOf(user, auditRef, d, now, b),
        challengerId: id,
      });
      return { ok: true, body: { approved: true, promotion } };
    },
  });
}

export async function rejectChallenger(
  c: OwnerCtx,
  user: CurrentUser,
  id: string,
  b: Body,
): Promise<ActionResult> {
  const g = await challengerGate(c, id, b, false);
  if (g) return g;
  const reason = typeof b.reason === "string" ? b.reason.slice(0, 200) : "";
  return audited(c, user, {
    action: "learning.challenger_reject",
    targetType: "challenger",
    targetId: id,
    detail: { challenger: id, reason },
    run: async (auditRef, d) => {
      const ch = await loadChallenger(c.mainDb, id);
      if (ch === null) return { ok: false, reason: "not_found", status: 404 };
      const t = await transitionChallenger(
        c.mainDb,
        {
          id,
          to: "rejected",
          d: d < ch.state_d ? ch.state_d : d,
          actor: actorOf(user),
          reason: reason === "" ? "rejected by Owner" : `rejected by Owner: ${reason}`,
          ref: { audit_ref: auditRef },
        },
        (await loadAgentParams(c.mainDb)).learning,
      );
      return { ok: true, body: { rejected: true, changed: t.changed, from: t.from } };
    },
  });
}

export async function forceApplyChallenger(
  c: OwnerCtx,
  user: CurrentUser,
  id: string,
  b: Body,
): Promise<ActionResult> {
  const g = await challengerGate(c, id, b, true);
  if (g) return g;
  return audited(c, user, {
    action: "learning.challenger_force_apply",
    targetType: "challenger",
    targetId: id,
    detail: { challenger: id, confirmKilled: b.confirm_killed === true },
    run: async (auditRef, d, now) => {
      const r = await requestForceApply(c.mainDb, {
        ...baseOf(user, auditRef, d, now, b),
        challengerId: id,
      });
      return r.status === "refused" ? refusal(r) : { ok: true, body: { request: r } };
    },
  });
}

export async function retireChallenger(
  c: OwnerCtx,
  user: CurrentUser,
  id: string,
  b: Body,
): Promise<ActionResult> {
  const g = await challengerGate(c, id, b, false);
  if (g) return g;
  const reason = typeof b.reason === "string" && b.reason !== "" ? b.reason.slice(0, 200) : "";
  return audited(c, user, {
    action: "learning.challenger_retire",
    targetType: "challenger",
    targetId: id,
    detail: { challenger: id, reason },
    run: async (auditRef, d, now) => {
      const ch = await loadChallenger(c.mainDb, id);
      if (ch === null) return { ok: false, reason: "not_found", status: 404 };
      const r = await retireRuleVersion(c.mainDb, {
        market: MARKET,
        versionId: ch.rule_version_id,
        d,
        now,
        actor: actorOf(user),
        reason: reason === "" ? "retired by Owner" : `retired by Owner: ${reason}`,
        auditRef,
      });
      return r.status === "refused" ? refusal(r) : { ok: true, body: { result: r } };
    },
  });
}

/** ARN-082: the Owner opened the forward shadow results; the holdout then starts after this date. */
export async function markShadowViewed(
  c: OwnerCtx,
  user: CurrentUser,
  id: string,
): Promise<ActionResult> {
  if (!idOk(id)) return bad("invalid");
  let ch;
  try {
    ch = await loadChallenger(c.mainDb, id);
  } catch {
    return bad("unavailable", 503);
  }
  if (ch === null) return bad("not_found", 404);
  const today = melbourneD(nowOf(c));
  if (ch.shadow_viewed_d !== null && ch.shadow_viewed_d >= today) {
    return res(200, { ok: true, changed: false, shadowViewedD: ch.shadow_viewed_d });
  }
  return audited(c, user, {
    action: "learning.challenger_shadow_viewed",
    targetType: "challenger",
    targetId: id,
    detail: { challenger: id, from: ch.shadow_viewed_d },
    run: async (_ref, d) => {
      const r = await c.mainDb.execute({
        sql: `UPDATE challenger SET shadow_viewed_d = ?
              WHERE id = ? AND (shadow_viewed_d IS NULL OR shadow_viewed_d < ?)`,
        args: [d, id, d],
      });
      return { ok: true, body: { changed: r.rowsAffected > 0, shadowViewedD: d } };
    },
  });
}

// ---- family actions -----------------------------------------------------------------------------------------------

const FAMILIES: readonly string[] = Object.keys(FAMILY_PARAM_KEYS);
const isFamily = (f: unknown): f is Family => typeof f === "string" && FAMILIES.includes(f);

export async function rollbackFamily(
  c: OwnerCtx,
  user: CurrentUser,
  family: string,
  b: Body,
): Promise<ActionResult> {
  if (!isFamily(family) || !idOk(b.to_version)) return bad("invalid");
  if (!confirmed(b)) return res(409, { error: "confirmation_required" });
  try {
    if (b.confirm_killed !== true && (await killedFamily(c.mainDb, family))) {
      return res(409, { error: "second_confirmation_required", family });
    }
  } catch {
    return bad("unavailable", 503);
  }
  const toVersion = b.to_version;
  return audited(c, user, {
    action: "learning.family_rollback",
    targetType: "family",
    targetId: family,
    detail: { family, toVersion, confirmKilled: b.confirm_killed === true },
    run: async (auditRef, d, now) => {
      const r = await requestRollback(c.mainDb, {
        ...baseOf(user, auditRef, d, now, b),
        family,
        toVersion,
      });
      return r.status === "refused" ? refusal(r) : { ok: true, body: { request: r } };
    },
  });
}

/** Owner-authored version (KB-050): the given values over the live version's, entered as a challenger. */
export async function createOwnerVersion(
  c: OwnerCtx,
  user: CurrentUser,
  family: string,
  b: Body,
): Promise<ActionResult> {
  if (!isFamily(family) || !isRecord(b.params) || Object.keys(b.params).length === 0) {
    return bad("invalid");
  }
  const changes = b.params;
  if (!Object.values(changes).every((v) => typeof v === "number" && Number.isFinite(v))) {
    return bad("invalid");
  }
  return audited(c, user, {
    action: "learning.owner_version",
    targetType: "family",
    targetId: family,
    detail: { family, params: changes },
    run: async (auditRef, d) => {
      const live = await incumbentOf(c.mainDb, MARKET, family);
      if (live === null) return { ok: false, reason: "no_live_version", detail: family };
      const v = await c.mainDb.execute({
        sql: "SELECT params_json FROM rule_version WHERE id = ?",
        args: [live],
      });
      const base = JSON.parse(String(v.rows[0]!.params_json)) as Record<string, unknown>;
      const unknown = Object.keys(changes).filter((k) => !(k in base));
      if (unknown.length > 0) {
        return {
          ok: false,
          reason: "invalid_params",
          detail: `unknown keys: ${unknown.join(", ")}`,
        };
      }
      const p = await loadAgentParams(c.mainDb);
      const r = await createChallenger(c.mainDb, {
        market: MARKET,
        family,
        origin: "owner",
        params: { ...base, ...changes },
        lessonIds: [],
        d,
        actor: actorOf(user),
        learning: p.learning,
        stats: p.stats,
        incumbentVersionId: live,
      });
      return r.status === "refused" ? refusal(r) : { ok: true, body: { result: r, auditRef } };
    },
  });
}

// ---- lesson actions ----------------------------------------------------------------------------------------------

async function lessonExists(db: Client, id: string): Promise<boolean> {
  const r = await db.execute({
    sql: "SELECT 1 FROM lesson WHERE id = ? AND market = ?",
    args: [id, MARKET],
  });
  return r.rows.length > 0;
}

async function lessonGate(c: OwnerCtx, id: string, b: Body): Promise<ActionResult | null> {
  if (!idOk(id)) return bad("invalid");
  if (!confirmed(b)) return res(409, { error: "confirmation_required" });
  try {
    if (!(await lessonExists(c.mainDb, id))) return bad("not_found", 404);
  } catch {
    return bad("unavailable", 503);
  }
  return null;
}

export async function forceApplyLessonAction(
  c: OwnerCtx,
  user: CurrentUser,
  id: string,
  b: Body,
): Promise<ActionResult> {
  const g = await lessonGate(c, id, b);
  if (g) return g;
  return audited(c, user, {
    action: "learning.lesson_force_apply",
    targetType: "lesson",
    targetId: id,
    detail: { lesson: id },
    run: async (auditRef, d, now) => {
      try {
        const ledgerId = await forceApplyLesson(c.mainDb, {
          market: MARKET,
          lessonId: id,
          actor: actorOf(user),
          auditRef,
          effectiveD: d,
          now,
        });
        return { ok: true, body: { ledgerId } };
      } catch (e) {
        if (e instanceof LaneAError) return { ok: false, reason: "refused", detail: e.message };
        throw e;
      }
    },
  });
}

/** Owner retirement of a lesson: a `retired` grade row plus a `retire` ledger row, one transaction. */
export async function retireLessonAction(
  c: OwnerCtx,
  user: CurrentUser,
  id: string,
  b: Body,
): Promise<ActionResult> {
  const g = await lessonGate(c, id, b);
  if (g) return g;
  const reason = typeof b.reason === "string" ? b.reason.slice(0, 200) : "";
  return audited(c, user, {
    action: "learning.lesson_retire",
    targetType: "lesson",
    targetId: id,
    detail: { lesson: id, reason },
    run: async (auditRef, d, now) => {
      const tx = await c.mainDb.transaction("write");
      try {
        const last = await tx.execute({
          sql: "SELECT * FROM lesson_grade WHERE lesson_id = ? ORDER BY seq DESC LIMIT 1",
          args: [id],
        });
        const g0 = last.rows[0];
        if (g0 !== undefined && String(g0.grade) === "retired") {
          await tx.rollback();
          return { ok: true, body: { changed: false } };
        }
        await tx.execute({
          sql: `INSERT INTO lesson_grade (lesson_id, seq, grade, split_version, window, n, blocks, B,
                  state_text, run_id, d)
                VALUES (?, ?, 'retired', ?, NULL, ?, ?, 0, ?, ?, ?)`,
          args: [
            id,
            g0 === undefined ? 1 : Number(g0.seq) + 1,
            g0 === undefined ? 0 : Number(g0.split_version),
            g0 === undefined ? 0 : Number(g0.n),
            g0 === undefined ? 0 : Number(g0.blocks),
            reason === "" ? "retired by Owner" : `retired by Owner: ${reason}`,
            `owner:${auditRef}`,
            d,
          ],
        });
        await tx.execute({
          sql: `INSERT INTO change_ledger (market, kind, target, after_json, lesson_ids_json,
                  effective_d, actor, audit_ref, created_at)
                VALUES (?, 'retire', ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            MARKET,
            `lesson/${id}`,
            JSON.stringify({ status: "retired", reason }),
            JSON.stringify([id]),
            d,
            actorOf(user),
            auditRef,
            now,
          ],
        });
        await tx.commit();
        return { ok: true, body: { changed: true } };
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
    },
  });
}

// ---- read models (all roles) -------------------------------------------------------------------------------------

export async function listChallengers(db: Client) {
  const r = await db.execute({
    sql: `SELECT c.id, v.family, c.state, c.state_d, c.origin, c.ready, c.shakedown_ok_sessions,
                 c.rule_version_id, c.incumbent_version_id, c.shadow_viewed_d
          FROM challenger c JOIN rule_version v ON v.id = c.rule_version_id
          WHERE v.market = ? ORDER BY c.state_d DESC, c.id LIMIT 200`,
    args: [MARKET],
  });
  return r.rows.map((x) => ({ ...x }));
}

export async function listLessons(db: Client) {
  const r = await db.execute({
    sql: `SELECT l.id, l.template_id, l.rule_version, l.created_d,
                 (SELECT grade FROM lesson_grade g WHERE g.lesson_id = l.id ORDER BY seq DESC LIMIT 1) AS grade
          FROM lesson l WHERE l.market = ? ORDER BY l.created_d DESC, l.id LIMIT 200`,
    args: [MARKET],
  });
  return r.rows.map((x) => ({ ...x }));
}

// ---- annotations (auth DB; Editor and Owner write, everyone reads, Viewers masked) ---------------------------

export type AnnotationView = {
  id: number;
  subjectKind: string;
  subjectId: string;
  authorId: number;
  authorRole: string;
  createdAt: string;
  editedAt: string | null;
  text: string | null;
  masked: boolean;
  history?: { op: string; at: string; actorId: number; before: string; after: string | null }[];
};

const kindOk = (k: unknown): k is AnnotationKind =>
  typeof k === "string" && (ANNOTATION_KINDS as readonly string[]).includes(k);
const textOk = (t: unknown): t is string =>
  typeof t === "string" && t.trim().length > 0 && t.length <= ANNOTATION_MAX_CHARS;

/**
 * Masked-content rule of UX-071a s13: a Viewer sees "Note added by <role> on <date>" without text;
 * Owner and Editor see the text (and, on request, the edit history).
 */
export async function listAnnotations(
  c: OwnerCtx,
  user: CurrentUser,
  q: { subjectKind: unknown; subjectId: unknown; history?: boolean },
): Promise<ActionResult> {
  if (!kindOk(q.subjectKind) || !idOk(q.subjectId)) return bad("invalid");
  try {
    const r = await c.authDb.execute({
      sql: `SELECT a.id, a.author_id, a.text, a.created_at, a.edited_at, u.role AS author_role
            FROM annotation a JOIN app_user u ON u.id = a.author_id
            WHERE a.subject_kind = ? AND a.subject_id = ? AND a.deleted_at IS NULL
            ORDER BY a.id`,
      args: [q.subjectKind, q.subjectId],
    });
    const unmasked = user.role === "owner" || user.role === "editor";
    const items: AnnotationView[] = [];
    for (const x of r.rows) {
      const v: AnnotationView = {
        id: Number(x.id),
        subjectKind: q.subjectKind,
        subjectId: q.subjectId,
        authorId: Number(x.author_id),
        authorRole: String(x.author_role),
        createdAt: String(x.created_at),
        editedAt: x.edited_at === null ? null : String(x.edited_at),
        text: unmasked ? String(x.text) : null,
        masked: !unmasked,
      };
      if (unmasked && q.history === true) {
        const h = await c.authDb.execute({
          sql: `SELECT op, at, actor_id, before_text, after_text FROM annotation_history
                WHERE annotation_id = ? ORDER BY id`,
          args: [v.id],
        });
        v.history = h.rows.map((y) => ({
          op: String(y.op),
          at: String(y.at),
          actorId: Number(y.actor_id),
          before: String(y.before_text),
          after: y.after_text === null ? null : String(y.after_text),
        }));
      }
      items.push(v);
    }
    return res(200, {
      annotations: items.map((v) =>
        v.masked
          ? { ...v, note: `Note added by ${v.authorRole} on ${v.createdAt.slice(0, 10)}` }
          : v,
      ),
    });
  } catch {
    return bad("unavailable", 503);
  }
}

async function annotationTx(
  c: OwnerCtx,
  user: CurrentUser,
  action: string,
  targetId: string,
  detail: Record<string, unknown>,
  body: (tx: Awaited<ReturnType<Client["transaction"]>>, at: string) => Promise<ActionResult>,
): Promise<ActionResult> {
  const at = nowOf(c).toISOString();
  let tx;
  try {
    tx = await c.authDb.transaction("write");
    // audit FIRST inside the transaction: if the change fails, the whole thing rolls back
    await auditTx(tx, c.env, c.meta, {
      at,
      actorUserId: user.id,
      action,
      targetType: "annotation",
      targetId,
      detail,
    });
    const out = await body(tx, at);
    if (out.status !== 200) {
      await tx.rollback();
      return out;
    }
    await tx.commit();
    return out;
  } catch {
    try {
      await tx?.rollback();
    } catch {
      // already rolled back
    }
    try {
      await appendAudit(c.authDb, auditKey(requireKey(c.env)), {
        at,
        actorUserId: user.id,
        action: `${action}_failed`,
        targetType: "annotation",
        targetId,
        detail,
        ip: c.meta.ip,
        userAgent: c.meta.userAgent,
      });
    } catch {
      // best effort
    }
    return bad("unavailable", 503);
  } finally {
    tx?.close();
  }
}

export async function addAnnotation(
  c: OwnerCtx,
  user: CurrentUser,
  b: Body,
): Promise<ActionResult> {
  if (!kindOk(b.subject_kind) || !idOk(b.subject_id) || !textOk(b.text)) return bad("invalid");
  const kind = b.subject_kind;
  const subject = b.subject_id;
  const text = b.text;
  if (kind === "lesson") {
    try {
      if (!(await lessonExists(c.mainDb, subject))) return bad("not_found", 404);
    } catch {
      return bad("unavailable", 503);
    }
  }
  return annotationTx(
    c,
    user,
    "annotation.add",
    `${kind}:${subject}`,
    { subjectKind: kind, subjectId: subject, length: text.length },
    async (tx, at) => {
      const r = await tx.execute({
        sql: `INSERT INTO annotation (subject_kind, subject_id, author_id, text, created_at)
              VALUES (?, ?, ?, ?, ?)`,
        args: [kind, subject, user.id, text, at],
      });
      return res(200, { ok: true, id: Number(r.lastInsertRowid) });
    },
  );
}

async function loadLive(db: Pick<Client, "execute">, id: number) {
  const r = await db.execute({
    sql: "SELECT id, author_id, text FROM annotation WHERE id = ? AND deleted_at IS NULL",
    args: [id],
  });
  return r.rows[0] ?? null;
}

const idNum = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;

async function changeAnnotation(
  c: OwnerCtx,
  user: CurrentUser,
  b: Body,
  op: "edit" | "delete",
): Promise<ActionResult> {
  const id = idNum(b.id);
  if (id === null || (op === "edit" && !textOk(b.text))) return bad("invalid");
  let row;
  try {
    row = await loadLive(c.authDb, id);
  } catch {
    return bad("unavailable", 503);
  }
  if (row === null) return bad("not_found", 404);
  // author or Owner only (UX-071a)
  if (Number(row.author_id) !== user.id && user.role !== "owner") return bad("forbidden", 403);
  const after = op === "edit" ? (b.text as string) : null;
  return annotationTx(
    c,
    user,
    `annotation.${op}`,
    String(id),
    { annotationId: id, byOwner: Number(row.author_id) !== user.id },
    async (tx, at) => {
      const cur = await loadLive(tx, id);
      if (cur === null) return bad("not_found", 404);
      if (op === "edit" && after === String(cur.text)) return bad("unchanged", 409);
      await tx.execute({
        sql: `INSERT INTO annotation_history (annotation_id, op, at, actor_id, before_text, after_text)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [id, op, at, user.id, String(cur.text), after],
      });
      await tx.execute(
        op === "edit"
          ? {
              sql: "UPDATE annotation SET text = ?, edited_at = ? WHERE id = ?",
              args: [after!, at, id],
            }
          : { sql: "UPDATE annotation SET deleted_at = ? WHERE id = ?", args: [at, id] },
      );
      return res(200, { ok: true, id });
    },
  );
}

export const editAnnotation = (c: OwnerCtx, u: CurrentUser, b: Body) =>
  changeAnnotation(c, u, b, "edit");
export const deleteAnnotation = (c: OwnerCtx, u: CurrentUser, b: Body) =>
  changeAnnotation(c, u, b, "delete");

// ---- request plumbing ---------------------------------------------------------------------------------------------

/** Reads a JSON object body (empty body = {}); null when it is not an object or is too large. */
export async function readBody(req: Request): Promise<Body | null> {
  const raw = await req.text();
  if (raw.length > 20_000) return null;
  if (raw.trim() === "") return {};
  try {
    const v: unknown = JSON.parse(raw);
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

export const toResponse = (r: ActionResult): Response =>
  Response.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
