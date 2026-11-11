// The market-profile loader: the single reader of a market's facts (M19 A1; MKT-107, DAT-241, D-993).
// A profile is the seed row + the field rows (`market_profile`, `market_profile_field`, migration 0034) + the
// newest `mkt.<CODE>.<field>` configuration value of the Owner-editable keys, typed, frozen and cached per
// database handle for PROFILE_CACHE_MS (60 s); the one writer (profileWrite.ts) calls `invalidateProfiles()`.
// Everything that used to hold a market literal asks this module (or takes a MarketProfile argument). Turso
// cost: three primary-key reads plus one bounded config read per load, then nothing for 60 s; the list query
// `enabledMarkets` reads at most three rows. No OFFSET.
import type { Client } from "@libsql/client";
import { MKT_KEY_FIELDS } from "./fields.mjs";
import { MarketNotEnabled, UnknownMarket } from "./errors.mjs";
import {
  HOME_MARKET,
  profileFromRows,
  type FieldRowInput,
  type MarketProfile,
  type MarketRowInput,
  type ProfileRowInput,
} from "./profileCore.mjs";
import { builtMarkets, seedOf } from "./seed/index.mjs";

export type { MarketProfile } from "./profileCore.mjs";
export { MarketNotEnabled, UnknownMarket, isMarketNotEnabled } from "./errors.mjs";
export { builtMarkets } from "./seed/index.mjs";
export { OWNER_TZ, GLOBAL_INDICES } from "./profileCore.mjs";

type Db = Pick<Client, "execute">;

/** How long a loaded profile is reused (`profile_cache_ms`, D-993). */
export const PROFILE_CACHE_MS = 60_000;

/** The configuration key of a profile field's overlay (`mkt.<CODE>.<field>`). */
export const mktKey = (code: string, field: string): string => `mkt.${code}.${field}`;

/** The legacy global key that stays the authority of the decision cut-off for the market that has it. */
const LEGACY_CUTOFF_KEY = "decision_cutoff";

type Entry = { at: number; profile: MarketProfile };
const caches = new WeakMap<object, Map<string, Entry>>();
let generation = 0;
const generations = new WeakMap<object, number>();

/** Drops every cached profile (the writer calls this after a change; tests call it between cases). */
export function invalidateProfiles(): void {
  generation += 1;
}

function cacheFor(db: object): Map<string, Entry> {
  const g = generations.get(db);
  if (g !== generation) {
    caches.delete(db);
    generations.set(db, generation);
  }
  let m = caches.get(db);
  if (m === undefined) {
    m = new Map();
    caches.set(db, m);
  }
  return m;
}

async function overlayOf(db: Db, code: string): Promise<Record<string, unknown>> {
  const fields = Object.keys(MKT_KEY_FIELDS);
  const keys = fields.map((f) => mktKey(code, f));
  const legacy = code === HOME_MARKET;
  const all = legacy ? [...keys, LEGACY_CUTOFF_KEY] : keys;
  // rows-ok: one row per key (at most 10), by the (key, scope, id) index
  const r = await db.execute({
    sql: `SELECT key, value_json FROM config_version
           WHERE id IN (SELECT MAX(id) FROM config_version
                         WHERE scope = 'global' AND key IN (${all.map(() => "?").join(",")})
                         GROUP BY key)`,
    args: all,
  });
  const byKey = new Map(
    r.rows.map((x) => [String(x.key), JSON.parse(String(x.value_json)) as unknown]),
  );
  const out: Record<string, unknown> = {};
  if (legacy && byKey.has(LEGACY_CUTOFF_KEY)) out.decision_cutoff = byKey.get(LEGACY_CUTOFF_KEY);
  for (const f of fields) {
    const v = byKey.get(mktKey(code, f));
    if (v !== undefined) out[f] = v;
  }
  return out;
}

/**
 * The profile of one market. Throws UnknownMarket for a code without a seed or a profile row. The result is
 * frozen and shared: never mutate it. `now` is the clock (tests pass one).
 */
export async function loadProfile(
  db: Db,
  code: string,
  opts: { now?: number } = {},
): Promise<MarketProfile> {
  const now = opts.now ?? Date.now();
  const cache = cacheFor(db);
  const hit = cache.get(code);
  if (hit !== undefined && now - hit.at < PROFILE_CACHE_MS) return hit.profile;
  // rows-ok: primary-key reads of one market row and one profile row
  const m = await db.execute({
    sql: `SELECT code, tz, open_time, close_time, cutoff_time, currency, mode, enabled, slots_json
            FROM market WHERE code = ?`,
    args: [code],
  });
  const p = await db.execute({
    sql: `SELECT code, work_status, status_changed_at, built_at, evidence_recorded_at, profile_version, updated_at
            FROM market_profile WHERE code = ?`,
    args: [code],
  });
  if (m.rows.length !== 1 || p.rows.length !== 1) throw new UnknownMarket(code);
  // rows-ok: one row per profile field (40), by the primary key
  const f = await db.execute({
    sql: `SELECT field, value_json, verify, verified_at, evidence_ref
            FROM market_profile_field WHERE code = ?`,
    args: [code],
  });
  const overlay = await overlayOf(db, code);
  const profile = profileFromRows({
    market: m.rows[0] as unknown as MarketRowInput,
    profile: p.rows[0] as unknown as ProfileRowInput,
    fieldRows: f.rows as unknown as FieldRowInput[],
    overlay,
    ...(seedOf(code) === undefined ? {} : { name: seedOf(code)!.name }),
  });
  cache.set(code, { at: now, profile });
  return profile;
}

/** Every market that has a profile row (at most the built markets: three). */
export async function loadProfiles(db: Db): Promise<MarketProfile[]> {
  // rows-ok: market_profile holds one row per built market (3)
  const r = await db.execute("SELECT code FROM market_profile ORDER BY code");
  const out: MarketProfile[] = [];
  for (const row of r.rows) out.push(await loadProfile(db, String(row.code)));
  return out;
}

/** The enabled markets (`markets_enabled`, D-994), sorted. Production: AU only. */
export async function enabledMarkets(db: Db): Promise<string[]> {
  // rows-ok: the market table holds one row per built market (3)
  const r = await db.execute("SELECT code FROM market WHERE enabled = 1 ORDER BY code");
  return r.rows.map((x) => String(x.code));
}

/** True when the market is enabled (one primary-key read). */
export async function isMarketEnabled(db: Db, code: string): Promise<boolean> {
  // rows-ok: primary-key probe
  const r = await db.execute({
    sql: "SELECT 1 FROM market WHERE code = ? AND enabled = 1",
    args: [code],
  });
  return r.rows.length === 1;
}

/** Throws MarketNotEnabled unless the market is enabled; returns the code (MKT-110 a). */
export async function requireEnabledMarket(db: Db, code: string): Promise<string> {
  if (!(await isMarketEnabled(db, code))) throw new MarketNotEnabled(code);
  return code;
}

/** What a loader knows about the request: an explicit market, and the user's `default_market` preference. */
export type ProfileEnv = { market?: string | null; defaultMarket?: string | null };

/**
 * The profile a loader works on: `env.market` when given; else the single enabled market; with two or more
 * enabled, the user's default market (when enabled), else the first. Throws MarketNotEnabled when no market is
 * enabled at all.
 */
export async function profileOf(
  db: Db,
  env: ProfileEnv = {},
  opts: { now?: number } = {},
): Promise<MarketProfile> {
  if (env.market !== undefined && env.market !== null) return loadProfile(db, env.market, opts);
  const enabled = await enabledMarkets(db);
  if (enabled.length === 0) throw new MarketNotEnabled("none");
  const pick =
    enabled.length > 1 && env.defaultMarket != null && enabled.includes(env.defaultMarket)
      ? env.defaultMarket
      : enabled[0]!;
  return loadProfile(db, pick, opts);
}

/** The market codes that have a seed (the registry): synchronous, for validators. */
export const seededMarkets = (): string[] => builtMarkets();
