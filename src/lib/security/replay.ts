// Replay protection for signed calls (SEC-017). Single use per nonce.

export interface NonceStore {
  // true = first use of this nonce; false = already used. Throws on store failure.
  claim(nonce: string, expiresAtSec: number): Promise<boolean>;
}

const TIMEOUT_MS = 15000;

// Turso HTTP /v2/pipeline, same format as scripts/smoke/checks.mjs (tursoRoundTrip):
// https://docs.turso.tech/sdk/http/reference
// D-721 (V1-S11): the table is created by main migration 0001_core.sql, so a signed call no longer
// runs DDL; the expiry prune runs at most once a minute per process instead of on every call.
const PRUNE_EVERY_SEC = 60;
export class TursoNonceStore implements NonceStore {
  private lastPruneSec = -Infinity;

  constructor(
    private readonly url: string | undefined,
    private readonly token: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly nowSec: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async claim(nonce: string, expiresAtSec: number): Promise<boolean> {
    const m = /^(?:libsql|https):\/\/([^/\s]+)\/?$/.exec((this.url ?? "").trim());
    if (!m || !this.token) throw new Error("store misconfigured");
    const now = this.nowSec();
    const prune = now - this.lastPruneSec >= PRUNE_EVERY_SEC;
    const requests = [
      ...(prune
        ? [
            {
              type: "execute",
              stmt: {
                sql: "DELETE FROM request_nonce WHERE expires_at < ?",
                args: [{ type: "integer", value: String(now) }],
              },
            },
          ]
        : []),
      {
        type: "execute",
        stmt: {
          sql: "INSERT INTO request_nonce (nonce, expires_at) VALUES (?, ?) ON CONFLICT DO NOTHING",
          args: [
            { type: "text", value: nonce },
            { type: "integer", value: String(expiresAtSec) },
          ],
        },
      },
      { type: "close" },
    ];
    const res = await this.fetchImpl(`https://${m[1]}/v2/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requests }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status !== 200) throw new Error("store error");
    const json = (await res.json()) as {
      results?: { type?: string; response?: { result?: { affected_row_count?: number } } }[];
    };
    const results = json.results;
    if (!Array.isArray(results) || results.length !== requests.length) {
      throw new Error("store error");
    }
    if (!results.every((r) => r && r.type === "ok")) throw new Error("store error");
    if (prune) this.lastPruneSec = now;
    const affected = results[requests.length - 2].response?.result?.affected_row_count;
    if (affected !== 0 && affected !== 1) throw new Error("store error");
    return affected === 1;
  }
}
