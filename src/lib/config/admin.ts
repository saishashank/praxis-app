// Owner Configuration service (UX-116, PLT-041, ROL-102a, SEC-013). Lists every registry key with
// its effective value and updates the editable ones. Every edit is a new append-only
// config_version row (main DB) plus an audit event (auth DB).
//
// Atomicity (two databases, so no single transaction): the audit event `config.change` is
// appended FIRST. If that fails nothing has changed and the caller gets `unavailable`. Only then is
// the config_version row written; if that fails, a compensating `config.change_failed` event is
// appended (best effort). So an audit row may exist for a change that failed and is then followed
// by change_failed; a change never exists without an audit row.
// Audit detail holds config values only (no personal data, no secrets).
import type { Client } from "@libsql/client";
import { audit, NO_META, type RequestMeta } from "@/lib/auth/audit";
import type { AuthEnv } from "@/lib/auth/env";
import {
  CONFIG_KEYS,
  CONFIG_META,
  isConfigKey,
  type ConfigArea,
  type ConfigInput,
  type ConfigKey,
} from "./keys";
import { invalidateConfigCache } from "./runtime";
import { getConfig, setConfig } from "./store";

export type ConfigRow = {
  key: ConfigKey;
  label: string;
  area: ConfigArea;
  unit: string;
  default: unknown;
  bounds: string;
  editable: "O" | "fixed";
  ref: string;
  input: ConfigInput;
  value: unknown;
  source: "default" | "stored";
  lastChange: { at: string; versionId: number } | null;
};

export type ConfigHistoryRow = {
  id: number;
  at: string;
  key: string;
  scope: string;
  before: unknown;
  after: unknown;
  reason: string | null;
};

export type UpdateError = "invalid" | "fixed" | "unknown" | "forbidden" | "unavailable";
export type UpdateResult =
  { ok: true; versionId: number } | { ok: false; error: UpdateError; message?: string };

export type UpdateInput = {
  mainDb: Client;
  authDb: Client;
  env: AuthEnv;
  meta?: RequestMeta;
  actorId: number;
  key: unknown;
  scope?: unknown;
  rawValue: unknown;
  reason: unknown;
  now?: Date;
};

const SCOPE_RE = /^(global|[A-Z]{2,5})$/;
const fail = (error: UpdateError, message?: string): UpdateResult =>
  message === undefined ? { ok: false, error } : { ok: false, error, message };

const keysOf = Object.keys(CONFIG_KEYS) as ConfigKey[];

export async function listConfig(mainDb: Client, scope = "global"): Promise<ConfigRow[]> {
  const res = await mainDb.execute({
    sql: `SELECT id, key, scope, value_json, changed_at FROM config_version
          WHERE scope IN (?, 'global') ORDER BY id DESC`,
    args: [scope],
  });
  // Newest row for the key in the requested scope wins, else the newest global row.
  const own = new Map<string, (typeof res.rows)[number]>();
  const global = new Map<string, (typeof res.rows)[number]>();
  for (const r of res.rows) {
    const k = String(r.key);
    const target = String(r.scope) === scope ? own : global;
    if (!target.has(k)) target.set(k, r);
  }
  return keysOf.map((key) => {
    const def = CONFIG_KEYS[key];
    const meta = CONFIG_META[key];
    const row = own.get(key) ?? global.get(key);
    return {
      key,
      label: meta.label,
      area: meta.area,
      unit: def.unit,
      default: def.default,
      bounds: meta.bounds,
      editable: def.editable,
      ref: def.ref,
      input: meta.input,
      value: row ? JSON.parse(String(row.value_json)) : def.default,
      source: row ? "stored" : "default",
      lastChange: row ? { at: String(row.changed_at), versionId: Number(row.id) } : null,
    };
  });
}

export async function listConfigHistory(mainDb: Client, limit = 20): Promise<ConfigHistoryRow[]> {
  const n = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.trunc(limit))) : 20;
  const res = await mainDb.execute({
    sql: `SELECT id, key, scope, value_json, previous_json, changed_at, reason
          FROM config_version ORDER BY id DESC LIMIT ?`,
    args: [n],
  });
  return res.rows.map((r) => {
    const k = String(r.key);
    const fallback = isConfigKey(k) ? CONFIG_KEYS[k].default : null;
    return {
      id: Number(r.id),
      at: String(r.changed_at),
      key: k,
      scope: String(r.scope),
      before: r.previous_json === null ? fallback : JSON.parse(String(r.previous_json)),
      after: JSON.parse(String(r.value_json)),
      reason: r.reason === null ? null : String(r.reason),
    };
  });
}

// ---- parsing and formatting -----------------------------------------------------------------

const INT_RE = /^-?\d{1,15}$/;
const NUM_RE = /^-?\d{1,15}(\.\d{1,15})?$/;

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Turns the text typed in the form into a value of the key's shape. Returns an error text for
// text that is not of that shape; range checks stay with the registry validators.
export function parseConfigInput(
  input: ConfigInput,
  raw: unknown,
): { value: unknown } | { error: string } {
  if (typeof raw !== "string") return { error: "is missing" };
  const text = raw.trim();
  if (text === "" || text.length > 500) return { error: "is missing or too long" };
  if (input === "int") {
    return INT_RE.test(text) ? { value: Number(text) } : { error: "must be a whole number" };
  }
  if (input === "number") {
    return NUM_RE.test(text) ? { value: Number(text) } : { error: "must be a number" };
  }
  if (input === "list") {
    const parts: unknown = text.startsWith("[") ? safeJson(text) : text.split(/[\s,]+/);
    const nums = Array.isArray(parts)
      ? parts.map((p) =>
          typeof p === "number" ? p : typeof p === "string" && INT_RE.test(p) ? Number(p) : NaN,
        )
      : [];
    return nums.length > 0 && nums.every((n) => Number.isInteger(n))
      ? { value: nums }
      : { error: "must be a list of whole numbers such as 14, 7, 2" };
  }
  const obj = safeJson(text);
  return typeof obj === "object" && obj !== null && !Array.isArray(obj)
    ? { value: obj }
    : { error: 'must be JSON such as {"a": 1}' };
}

function scalar(v: unknown): string {
  return typeof v === "number"
    ? v.toLocaleString("en-AU", { maximumFractionDigits: 6 })
    : String(v);
}

// Plain-English display of a value with its unit, e.g. "30 days", "14, 7, 2 days".
export function formatConfigValue(v: unknown, unit: string): string {
  if (Array.isArray(v)) return `${v.map(scalar).join(", ")} ${unit}`;
  if (typeof v === "object" && v !== null) {
    return Object.entries(v)
      .map(([k, x]) => `${k.replace(/_/g, " ")}: ${scalar(x)}`)
      .join(", ");
  }
  return scalar(v) + (unit === "fraction" ? "" : ` ${unit}`);
}

// The text an edit form starts from: parseConfigInput(input, editText(v)) gives v back.
export function editText(v: unknown): string {
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "object" && v !== null) return JSON.stringify(v);
  return String(v);
}

// ---- update ---------------------------------------------------------------------------------

export async function updateConfig(p: UpdateInput): Promise<UpdateResult> {
  const meta = p.meta ?? NO_META;
  const now = (p.now ?? new Date()).toISOString();

  // Defence in depth: the caller passed requireUser("admin"); the actor must still be an active Owner.
  try {
    const r = await p.authDb.execute({
      sql: "SELECT 1 FROM app_user WHERE id = ? AND role = 'owner' AND status = 'active'",
      args: [p.actorId],
    });
    if (r.rows.length !== 1) return fail("forbidden");
  } catch {
    return fail("unavailable");
  }

  if (typeof p.key !== "string" || !isConfigKey(p.key)) return fail("unknown");
  const key = p.key;
  const def = CONFIG_KEYS[key];
  if (def.editable === "fixed") return fail("fixed", "This setting is fixed by the spec.");
  const scope = p.scope === undefined ? "global" : p.scope;
  if (typeof scope !== "string" || !SCOPE_RE.test(scope)) return fail("invalid", "Invalid scope.");
  const reason = typeof p.reason === "string" ? p.reason.trim() : "";
  if (reason.length < 1 || reason.length > 200) {
    return fail("invalid", "Give a reason of 1 to 200 characters.");
  }

  const parsed = parseConfigInput(CONFIG_META[key].input, p.rawValue);
  if ("error" in parsed) return fail("invalid", `Value ${parsed.error}.`);

  let before: unknown;
  try {
    const problem = await def.validate(parsed.value, (k) => getConfig(p.mainDb, k, scope));
    if (problem) return fail("invalid", `Value ${problem}.`);
    before = await getConfig(p.mainDb, key, scope);
  } catch {
    return fail("unavailable");
  }

  const base = { at: now, actorUserId: p.actorId, targetType: "config", targetId: key };
  try {
    await audit(p.authDb, p.env, meta, {
      ...base,
      action: "config.change",
      detail: { key, scope, before, after: parsed.value, reason },
    });
  } catch {
    return fail("unavailable"); // nothing has changed
  }

  try {
    const res = await setConfig(p.mainDb, {
      key,
      scope,
      value: parsed.value,
      userId: p.actorId,
      reason,
      now,
    });
    invalidateConfigCache();
    return { ok: true, versionId: res.versionId };
  } catch {
    try {
      await audit(p.authDb, p.env, meta, {
        ...base,
        action: "config.change_failed",
        detail: { key, scope },
      });
    } catch {
      // best effort: the change did not happen either way
    }
    return fail("unavailable");
  }
}
