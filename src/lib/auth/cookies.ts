// Pinned Auth.js host and session-cookie options (PLT-033, V1-I10 / D-783). Pure; no Next imports,
// so src/proxy.ts, the test-identity login and src/lib/auth/config.ts share one definition.
//
// Before this, trustHost was a blanket `true` and the cookie flags were Auth.js defaults that
// happened to satisfy PLT-033. Now the canonical origin comes from APP_BASE_URL (the same value the
// origin gate uses) and is handed to Auth.js as AUTH_URL, which makes Auth.js rewrite every request
// URL to that origin, whatever Host or X-Forwarded-Host says.
export const SESSION_COOKIE_SECURE = "__Secure-authjs.session-token";
export const SESSION_COOKIE_PLAIN = "authjs.session-token";

export type AuthHostEnv = Record<string, string | undefined>;

/** The canonical origin from APP_BASE_URL, or null when absent or not an http(s) URL. */
export function pinnedOrigin(env: AuthHostEnv): string | null {
  const raw = env.APP_BASE_URL?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * Whether Auth.js may derive the host from the request. True only when the origin is pinned, or
 * outside production (local dev, tests). Production without APP_BASE_URL fails closed (Auth.js
 * answers with its UntrustedHost error); the self-check already requires APP_BASE_URL there.
 */
export function trustHostFor(env: AuthHostEnv): boolean {
  return pinnedOrigin(env) !== null || env.NODE_ENV !== "production";
}

/** Session cookie secure flag: the pinned origin's scheme, else production. */
export function cookieSecure(env: AuthHostEnv): boolean {
  const o = pinnedOrigin(env);
  return o !== null ? o.startsWith("https:") : env.NODE_ENV === "production";
}

/** PLT-033: HttpOnly, Secure (on https), SameSite, path "/" - names stay Auth.js's own. */
export function sessionCookieConfig(env: AuthHostEnv) {
  const secure = cookieSecure(env);
  return {
    sessionToken: {
      name: secure ? SESSION_COOKIE_SECURE : SESSION_COOKIE_PLAIN,
      options: { httpOnly: true, sameSite: "lax" as const, path: "/", secure },
    },
  };
}
