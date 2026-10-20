// Staging host guard (M8 T9, NFR-040, decision 31): on staging no request may go to ASX or Yahoo.
// `guardFetch` wraps a fetch implementation; `installHostGuard` replaces globalThis.fetch for the
// life of a staging script. Production behaviour is unchanged (the guard is a no-op there).
// The error message is fixed: it never carries the URL (SEC-110).

/** Host suffixes that staging must never reach (the host itself and every subdomain). */
export const BLOCKED_HOST_SUFFIXES = Object.freeze([
  "asx.com.au",
  "asxonline.com",
  "yahoo.com",
  "yahoo.net",
  "yahooapis.com",
  "yimg.com",
]);

/** @param {string} host */
export function isBlockedHost(host) {
  const h = String(host).trim().toLowerCase().replace(/\.$/, "");
  return BLOCKED_HOST_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
}

/** @param {Record<string, string | undefined>} env */
export const isStaging = (env) => env.PRAXIS_ENV === "staging";

export class BlockedHostError extends Error {
  constructor() {
    super("host blocked on staging (NFR-040)");
    this.name = "BlockedHostError";
  }
}

/**
 * Throws BlockedHostError on staging for a blocked or unparseable target.
 * @param {unknown} input @param {Record<string, string | undefined>} env
 */
export function assertAllowedRequest(input, env) {
  if (!isStaging(env)) return;
  let host;
  try {
    const raw =
      typeof input === "string" || input instanceof URL
        ? String(input)
        : String(/** @type {{ url?: unknown }} */ (input)?.url ?? "");
    host = new URL(raw).hostname;
  } catch {
    throw new BlockedHostError();
  }
  if (isBlockedHost(host)) throw new BlockedHostError();
}

/** @param {typeof fetch} fetchImpl @param {Record<string, string | undefined>} env */
export function guardFetch(fetchImpl, env) {
  return /** @type {typeof fetch} */ (
    async (input, init) => {
      assertAllowedRequest(input, env);
      return fetchImpl(input, init);
    }
  );
}

/**
 * Replace `target.fetch` with the guarded one; returns an undo function.
 * @param {Record<string, string | undefined>} env
 */
export function installHostGuard(env, target = globalThis) {
  const original = target.fetch;
  if (typeof original === "function") target.fetch = guardFetch(original.bind(target), env);
  return () => {
    target.fetch = original;
  };
}
