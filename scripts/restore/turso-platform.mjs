// Minimal Turso Platform API client for the restore drill (TST-108, OPS-040, SEC-017 (l)).
// Zero dependencies. It creates and deletes THROWAWAY databases and issues a short-lived database
// token with the temporary platform token (l). The token goes only to api.turso.tech (fixed here,
// never taken from a response); redirects are refused. Errors carry the step and HTTP status only:
// never a URL, a token, a database name from the server or a response body.
// [VERIFY] endpoint names, the narrowest "create database" token scope and the free-tier database
// count against the Turso Platform API reference before the first real run.
const API = "https://api.turso.tech";
const ORG_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DB_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const GROUP_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HOST_RE = /^[a-z0-9][a-z0-9.-]*\.turso\.io$/;
const TIMEOUT_MS = 60_000;

export class TursoError extends Error {
  /** @param {string} step @param {number | null} status */
  constructor(step, status) {
    super(`turso ${step} failed${status === null ? "" : ` (HTTP ${status})`}`);
    this.name = "TursoError";
    this.step = step;
    this.status = status;
  }
}

/** Name of a throwaway database: lower-case, valid for Turso, never a live name. */
export function throwawayName(kind, suffix, prefix = "drill") {
  const name = `${prefix}-${kind}-${suffix}`;
  if (
    !DB_NAME_RE.test(name) ||
    !/^[a-z0-9]{4,24}$/.test(suffix) ||
    !/^(drill|restore)$/.test(prefix)
  ) {
    throw new Error("bad throwaway database name");
  }
  return name;
}

/**
 * @param {{ org: string, token: string, group?: string, fetchImpl?: typeof fetch }} cfg
 */
export function createTursoPlatform({ org, token, group = "default", fetchImpl = fetch }) {
  if (
    !ORG_RE.test(String(org)) ||
    !GROUP_RE.test(String(group)) ||
    typeof token !== "string" ||
    token.trim() === ""
  ) {
    throw new Error("turso client misconfigured");
  }
  const base = `${API}/v1/organizations/${encodeURIComponent(org)}/databases`;
  const auth = { Authorization: `Bearer ${token.trim()}` };

  async function call(step, url, init) {
    try {
      return await fetchImpl(url, {
        ...init,
        headers: { ...auth, ...(init.headers ?? {}) },
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new TursoError(step, null);
    }
  }
  const checkName = (name) => {
    if (!DB_NAME_RE.test(String(name))) throw new TursoError("bad_name", null);
  };

  return {
    /**
     * Create an empty database. Returns the name and the libsql URL (a secret-like value: the
     * caller must never print it).
     * @param {string} name
     * @returns {Promise<{ name: string, url: string }>}
     */
    async createDatabase(name) {
      checkName(name);
      const res = await call("create_database", base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, group }),
      });
      if (res.status !== 200 && res.status !== 201) {
        throw new TursoError("create_database", res.status);
      }
      let body;
      try {
        body = await res.json();
      } catch {
        throw new TursoError("create_database", null);
      }
      const host = body?.database?.Hostname;
      if (typeof host !== "string" || !HOST_RE.test(host)) {
        throw new TursoError("create_database", null);
      }
      return { name, url: `libsql://${host}` };
    },

    /** Delete a database. A database that is already gone counts as deleted. */
    async deleteDatabase(name) {
      checkName(name);
      const res = await call("delete_database", `${base}/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      if (res.status !== 200 && res.status !== 204 && res.status !== 404) {
        throw new TursoError("delete_database", res.status);
      }
    },

    /** A short-lived full-access token for ONE database (default expiry 1 hour). */
    async createDatabaseToken(name, expiration = "1h") {
      checkName(name);
      if (!/^\d{1,3}[mhd]$/.test(expiration)) throw new TursoError("bad_expiration", null);
      const res = await call(
        "create_token",
        `${base}/${encodeURIComponent(name)}/auth/tokens?expiration=${expiration}&authorization=full-access`,
        { method: "POST" },
      );
      if (res.status !== 200) throw new TursoError("create_token", res.status);
      let body;
      try {
        body = await res.json();
      } catch {
        throw new TursoError("create_token", null);
      }
      if (typeof body?.jwt !== "string" || body.jwt === "") {
        throw new TursoError("create_token", null);
      }
      return body.jwt;
    },
  };
}
