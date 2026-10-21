// Owner pause / resume of a strategy and kill-switch on / off of a family (M7 T13; UX-050, UXN-150
// neighbour; docs/M7_design.md decision 51; D-128 draft). HIGH RISK: this is the only entry point a
// person has to stop NEW entries of a strategy (batch 2b reads `arena_control` since D-094).
//
// Same shape as the other Owner writers (src/lib/learning/ownerActions.ts, D-047 / D-125):
//   1. validate the input (no I/O) and refuse a missing confirmation;
//   2. check that the strategy or family exists and that the state really changes;
//   3. `audited`: refuse in data-only mode, append the audit event in the auth DB FIRST, then run the
//      writer, and append `<action>_failed` when the writer fails (the audit row stays);
//   4. the writer appends ONE row to the append-only `arena_control` log (the same columns and the
//      same state words the kill-switch trip writes in src/lib/stats/killSwitch.ts). Nothing is
//      updated or deleted; a pause or kill stops new entries only, exits still run (D-094).
// The actor is always the session user (`u<id>`), never a field of the request. No money is
// handled here: the file does no arithmetic at all.
import type { Client } from "@libsql/client";
import { controlStates, type ControlState } from "@/lib/agents/controls";
import { FAMILIES } from "@/lib/agents/schema";
import type { CurrentUser } from "@/lib/auth/session";
import {
  actorOf,
  audited,
  MARKET,
  type ActionResult,
  type OwnerCtx,
} from "@/lib/learning/ownerActions";

export const CONTROL_REASON_MAX = 200; // threshold-ok: characters of the optional reason

export type ControlScope = "execution" | "family";
export type ControlTarget = "paused" | "enabled" | "killed";

/** What the Owner may do: pause / resume a strategy, kill / lift a family. */
const ALLOWED: Readonly<Record<ControlScope, readonly ControlTarget[]>> = {
  execution: ["paused", "enabled"],
  family: ["killed", "enabled"],
};

export type ControlInput = {
  scope: unknown;
  key: unknown;
  state: unknown;
  reason?: unknown;
  confirm: unknown;
};

const HTTP_BAD = 400; // threshold-ok: HTTP status
const HTTP_FORBIDDEN = 403; // threshold-ok: HTTP status
const HTTP_NOT_FOUND = 404; // threshold-ok: HTTP status
const HTTP_CONFLICT = 409; // threshold-ok: HTTP status
const HTTP_UNAVAILABLE = 503; // threshold-ok: HTTP status

const res = (status: number, body: Record<string, unknown>): ActionResult => ({ status, body });
const bad = (error: string, status = HTTP_BAD): ActionResult => res(status, { error });

const isScope = (v: unknown): v is ControlScope => v === "execution" || v === "family";
const isTarget = (v: unknown): v is ControlTarget =>
  v === "paused" || v === "enabled" || v === "killed";

const printable = (s: string): boolean => {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 32 || c === 127) return false; // threshold-ok: ASCII control characters
  }
  return true;
};

/** A strategy id as the arena writes it ("E01", "E12"): short, no spaces or control characters. */
const keyOk = (s: unknown): s is string =>
  typeof s === "string" && s.length > 0 && s.length <= 40 && !s.includes(" ") && printable(s); // threshold-ok: id length guard

export type ParsedControl = {
  scope: ControlScope;
  key: string;
  state: ControlTarget;
  reason: string | null;
};

/** Pure validation: the combination, the key shape, the reason and the explicit confirmation. */
export function parseControlInput(b: ControlInput): ParsedControl | ActionResult {
  if (!isScope(b.scope) || !isTarget(b.state) || !keyOk(b.key)) return bad("invalid");
  if (!ALLOWED[b.scope].includes(b.state)) return bad("invalid");
  let reason: string | null = null;
  if (b.reason !== undefined && b.reason !== null && b.reason !== "") {
    if (typeof b.reason !== "string") return bad("invalid");
    const t = b.reason.trim();
    if (t.length > CONTROL_REASON_MAX || !printable(t)) return bad("invalid");
    reason = t.length === 0 ? null : t;
  }
  if (b.confirm !== true) return res(HTTP_CONFLICT, { error: "confirmation_required" });
  return { scope: b.scope, key: b.key, state: b.state, reason };
}

const isParsed = (v: ParsedControl | ActionResult): v is ParsedControl => "scope" in v;

/** The effective state of one scope key from the append-only log (killed is sticky, D-094). */
export async function currentControlState(
  db: Pick<Client, "execute">,
  scope: ControlScope,
  key: string,
): Promise<ControlState> {
  const r = await db.execute({
    sql: "SELECT scope, scope_key, state FROM arena_control WHERE scope = ? AND scope_key = ? ORDER BY id",
    args: [scope, key],
  });
  const states = controlStates(
    r.rows.map((x) => ({
      scope: String(x.scope),
      scopeKey: String(x.scope_key),
      state: String(x.state),
    })),
  );
  return states.get(`${scope}|${key}`) ?? "enabled";
}

async function exists(db: Pick<Client, "execute">, scope: ControlScope, key: string) {
  if (scope === "family") return (FAMILIES as readonly string[]).includes(key);
  const r = await db.execute({
    sql: "SELECT 1 FROM execution WHERE id = ? AND market = ? AND kind = 'E'",
    args: [key, MARKET],
  });
  return r.rows.length > 0;
}

/** Appends one state row. The only INSERT into arena_control outside the kill-switch trip. */
export async function appendControlRow(
  db: Pick<Client, "execute">,
  row: {
    scope: ControlScope;
    key: string;
    state: ControlTarget;
    at: string;
    by: string;
    reason: string;
  },
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO arena_control (scope, scope_key, state, set_at, set_by, reason)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [row.scope, row.key, row.state, row.at, row.by, row.reason],
  });
}

const VERB: Readonly<Record<ControlTarget, string>> = {
  paused: "Owner paused new entries",
  enabled: "Owner resumed",
  killed: "Owner switched the family off",
};

/**
 * The Owner action. The caller has ALREADY passed the Owner guard (`requireUser("admin")` or
 * `withAuth("admin")`); the role is checked once more here so a mistaken caller cannot bypass it.
 */
export async function setArenaControl(
  c: OwnerCtx,
  user: CurrentUser,
  input: ControlInput,
): Promise<ActionResult> {
  if (user.role !== "owner") return bad("forbidden", HTTP_FORBIDDEN);
  const p = parseControlInput(input);
  if (!isParsed(p)) return p;
  let before: ControlState;
  try {
    if (!(await exists(c.mainDb, p.scope, p.key))) return bad("not_found", HTTP_NOT_FOUND);
    before = await currentControlState(c.mainDb, p.scope, p.key);
  } catch {
    return bad("unavailable", HTTP_UNAVAILABLE);
  }
  if (before === p.state) return res(HTTP_CONFLICT, { error: "no_change", state: before });
  const action = p.state === "enabled" ? "arena.control_resume" : `arena.control_${p.state}`;
  return audited(c, user, {
    action,
    targetType: "arena_control",
    targetId: `${p.scope}:${p.key}`,
    detail: { scope: p.scope, key: p.key, from: before, to: p.state, reason: p.reason },
    run: async (auditRef, _d, now) => {
      await appendControlRow(c.mainDb, {
        scope: p.scope,
        key: p.key,
        state: p.state,
        at: now,
        by: actorOf(user),
        reason: `${VERB[p.state]} (${auditRef})${p.reason === null ? "" : `: ${p.reason}`}`,
      });
      return { ok: true, body: { scope: p.scope, key: p.key, state: p.state } };
    },
  });
}
