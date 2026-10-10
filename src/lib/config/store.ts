// Versioned configuration store (ch.15). Append-only: every change is a new config_version row.
import type { Client } from "@libsql/client";
import { CONFIG_KEYS, isConfigKey, type ConfigKey, type ConfigKeyDef } from "./keys";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

async function stored(db: Client, key: string, scope: string): Promise<unknown> {
  const res = await db.execute({
    sql: "SELECT value_json FROM config_version WHERE key = ? AND scope = ? ORDER BY id DESC LIMIT 1",
    args: [key, scope],
  });
  return res.rows.length ? JSON.parse(String(res.rows[0].value_json)) : undefined;
}

// Latest value for (key, scope), else for (key, 'global'), else the registry default.
export async function getConfig(db: Client, key: ConfigKey, scope = "global"): Promise<unknown> {
  const own = await stored(db, key, scope);
  if (own !== undefined) return own;
  if (scope !== "global") {
    const g = await stored(db, key, "global");
    if (g !== undefined) return g;
  }
  return CONFIG_KEYS[key].default;
}

export async function setConfig(
  db: Client,
  p: {
    key: string;
    scope?: string;
    value: unknown;
    userId: number | null;
    reason?: string;
    now: string;
  },
): Promise<{ versionId: number; before: unknown; after: unknown }> {
  const scope = p.scope ?? "global";
  if (!isConfigKey(p.key)) throw new ConfigError("unknown setting");
  const def: ConfigKeyDef = CONFIG_KEYS[p.key];
  if (def.editable === "fixed") throw new ConfigError("this setting is fixed");
  if (!/^(global|[A-Z]{2,5})$/.test(scope)) throw new ConfigError("invalid scope");
  const problem = await def.validate(p.value, (k) => getConfig(db, k, scope));
  if (problem) throw new ConfigError(`invalid value: ${problem}`);
  const before = await getConfig(db, p.key, scope);
  const previous = await stored(db, p.key, scope);
  const res = await db.execute({
    sql: `INSERT INTO config_version (key, scope, value_json, previous_json, changed_by_user_id, changed_at, reason)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      p.key,
      scope,
      JSON.stringify(p.value),
      previous === undefined ? null : JSON.stringify(previous),
      p.userId,
      p.now,
      p.reason ?? null,
    ],
  });
  return { versionId: Number(res.lastInsertRowid), before, after: p.value };
}
