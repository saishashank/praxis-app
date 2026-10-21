// Persistence for the router: response cache (llm_cache), call log (llm_call) and usage queries.
// MemoryStore is for tests and replay; DbStore uses migration 0008's tables. llm_call holds counts
// and outcomes only: no prompt text, no keys (hashes live in the in-memory call record).
import type { Client } from "@libsql/client";
import type { BudgetUsage, Role } from "./budget";

export type CallRow = {
  id: string;
  role: Role;
  provider: string;
  modelId: string | null;
  /** Index in the provider chain, or "rules-only". */
  fallbackDepth: string;
  tokensIn: number;
  tokensOut: number;
  cached: 0 | 1;
  outcome: string;
  injectionFiltered: 0 | 1;
  market: string;
  d: string;
};

export type CacheKey = { role: Role; modelId: string; promptSha: string; kbVersion: string };

export interface LlmStore {
  cacheGet(key: CacheKey, nowIso: string): Promise<string | null>;
  cachePut(key: CacheKey, responseJson: string, expiresAt: string, nowIso: string): Promise<void>;
  recordCall(row: CallRow): Promise<void>;
  usage(role: Role, market: string, d: string): Promise<BudgetUsage>;
  /** Requests made to one provider on `d` (LLM-021 request budget). */
  requestsToday(provider: string, d: string): Promise<number>;
}

const keyText = (k: CacheKey): string =>
  JSON.stringify([k.role, k.modelId, k.promptSha, k.kbVersion]);

export class MemoryStore implements LlmStore {
  readonly rows: CallRow[] = [];
  private readonly cache = new Map<string, { json: string; expiresAt: string }>();
  /** Nightly-batch tokens are tracked separately: rows do not carry the flag. */
  async cacheGet(key: CacheKey, nowIso: string): Promise<string | null> {
    const hit = this.cache.get(keyText(key));
    return hit && hit.expiresAt > nowIso ? hit.json : null;
  }
  async cachePut(key: CacheKey, json: string, expiresAt: string): Promise<void> {
    this.cache.set(keyText(key), { json, expiresAt });
  }
  async recordCall(row: CallRow): Promise<void> {
    this.rows.push(row);
  }
  async usage(role: Role, market: string, d: string): Promise<BudgetUsage> {
    return sumUsage(this.rows, role, market, d);
  }
  async requestsToday(provider: string, d: string): Promise<number> {
    return this.rows.filter((r) => r.provider === provider && r.d === d && r.cached === 0).length;
  }
}

export function sumUsage(rows: readonly CallRow[], role: Role, market: string, d: string) {
  const u: BudgetUsage = { roleDay: 0, totalDay: 0, marketNight: 0 };
  for (const r of rows) {
    if (r.market !== market || r.d !== d || r.cached === 1) continue;
    const t = r.tokensIn + r.tokensOut;
    u.totalDay += t;
    u.marketNight += t; // the nightly batch is the only M4 caller (design 4.6)
    if (r.role === role) u.roleDay += t;
  }
  return u;
}

export class DbStore implements LlmStore {
  constructor(private readonly db: Client) {}

  async cacheGet(key: CacheKey, nowIso: string): Promise<string | null> {
    const r = await this.db.execute({
      sql: "SELECT response_json FROM llm_cache WHERE role = ? AND model_id = ? AND prompt_sha = ? AND kb_version = ? AND expires_at > ?",
      args: [key.role, key.modelId, key.promptSha, key.kbVersion, nowIso],
    });
    return r.rows.length > 0 ? String(r.rows[0].response_json) : null;
  }

  async cachePut(key: CacheKey, json: string, expiresAt: string, nowIso: string): Promise<void> {
    const args = [key.role, key.modelId, key.promptSha, key.kbVersion];
    // The table is append-only; a refresh deletes the expired row first (the trigger allows it).
    await this.db.execute({
      sql: "DELETE FROM llm_cache WHERE role = ? AND model_id = ? AND prompt_sha = ? AND kb_version = ? AND expires_at <= ?",
      args: [...args, nowIso],
    });
    await this.db.execute({
      sql: "INSERT OR IGNORE INTO llm_cache (role, model_id, prompt_sha, kb_version, response_json, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      args: [...args, json, expiresAt],
    });
  }

  async recordCall(row: CallRow): Promise<void> {
    await this.db.execute({
      sql: "INSERT INTO llm_call (id, role, provider, model_id, fallback_depth, tokens_in, tokens_out, cached, outcome, injection_filtered, market, d) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      args: [
        row.id,
        row.role,
        row.provider,
        row.modelId,
        row.fallbackDepth,
        row.tokensIn,
        row.tokensOut,
        row.cached,
        row.outcome,
        row.injectionFiltered,
        row.market,
        row.d,
      ],
    });
  }

  async usage(role: Role, market: string, d: string): Promise<BudgetUsage> {
    const r = await this.db.execute({
      sql: "SELECT role, COALESCE(SUM(tokens_in + tokens_out), 0) AS t FROM llm_call WHERE market = ? AND d = ? AND cached = 0 GROUP BY role",
      args: [market, d],
    });
    const u: BudgetUsage = { roleDay: 0, totalDay: 0, marketNight: 0 };
    for (const row of r.rows) {
      const t = Number(row.t);
      u.totalDay += t;
      u.marketNight += t;
      if (String(row.role) === role) u.roleDay += t;
    }
    return u;
  }

  async requestsToday(provider: string, d: string): Promise<number> {
    const r = await this.db.execute({
      sql: "SELECT COUNT(*) AS n FROM llm_call WHERE provider = ? AND d = ? AND cached = 0",
      args: [provider, d],
    });
    return Number(r.rows[0].n);
  }
}
