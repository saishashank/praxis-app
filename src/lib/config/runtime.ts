// Runtime configuration reads (PLT-041): the stored value when there is one, else the registry
// default. Never throws: any database problem returns the default, so a config outage cannot take
// a request or job down. Results are cached in-process for 60 s; a failed read is cached for 10 s
// so a database outage does not add a connection attempt to every request.
// Each server instance has its own cache, so an Owner edit reaches other instances within 60 s.
import type { Client } from "@libsql/client";
import { mainDb } from "@/lib/db/client";
import { CONFIG_KEYS, type ConfigKey } from "./keys";
import { getConfig } from "./store";

export const CACHE_TTL_MS = 60_000;
export const FAILURE_TTL_MS = 10_000;

export type ConfigValue<K extends ConfigKey> = (typeof CONFIG_KEYS)[K]["default"];

type Entry = { value: unknown; expires: number };
export type RuntimeDeps = { db?: () => Client; now?: () => number };

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

const cacheKey = (key: string, scope: string) => `${scope}\u0000${key}`;

export function invalidateConfigCache(): void {
  cache.clear();
  inflight.clear();
}

async function load(key: ConfigKey, scope: string, deps: RuntimeDeps): Promise<unknown> {
  const now = deps.now ?? Date.now;
  let db: Client | undefined;
  try {
    db = (deps.db ?? mainDb)();
    const value = await getConfig(db, key, scope);
    cache.set(cacheKey(key, scope), { value, expires: now() + CACHE_TTL_MS });
    return value;
  } catch {
    const value = CONFIG_KEYS[key].default;
    cache.set(cacheKey(key, scope), { value, expires: now() + FAILURE_TTL_MS });
    return value;
  } finally {
    // Only clients this module opened are closed; an injected client belongs to the caller.
    if (db && !deps.db) db.close();
  }
}

export async function getConfigCached<K extends ConfigKey>(
  key: K,
  scope = "global",
  deps: RuntimeDeps = {},
): Promise<ConfigValue<K>> {
  const hit = cache.get(cacheKey(key, scope));
  if (hit && hit.expires > (deps.now ?? Date.now)()) return hit.value as ConfigValue<K>;
  const ck = cacheKey(key, scope);
  let p = inflight.get(ck);
  if (!p) {
    p = load(key, scope, deps).finally(() => inflight.delete(ck));
    inflight.set(ck, p);
  }
  return (await p) as ConfigValue<K>;
}

// For synchronous callers (the proxy gate, Auth.js claim checks): the cached value if fresh, else
// the registry default, and a background refresh so the next call sees the stored value. Eventually
// consistent by design; never blocks and never throws.
export function peekConfig<K extends ConfigKey>(
  key: K,
  scope = "global",
  deps: RuntimeDeps = {},
): ConfigValue<K> {
  const hit = cache.get(cacheKey(key, scope));
  if (hit && hit.expires > (deps.now ?? Date.now)()) return hit.value as ConfigValue<K>;
  void getConfigCached(key, scope, deps).catch(() => undefined);
  return (hit ? hit.value : CONFIG_KEYS[key].default) as ConfigValue<K>;
}
