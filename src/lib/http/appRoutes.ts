// Is this path an address the app serves? (M21 A2, D-1210.) Built from the generated pattern list
// (scripts/routes/gen-app-routes.mjs). The proxy marks a signed-in request for an unknown path like a hidden one.
import { KNOWN_ROUTE_PATTERNS } from "./appRoutes.generated";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "/market/[code]/overview" -> a RegExp; [x] one segment, [...x] one or more, [[...x]] zero or more. */
export function patternToRegExp(pattern: string): RegExp {
  if (pattern === "/") return /^\/$/;
  let re = "^";
  for (const seg of pattern.split("/").filter(Boolean)) {
    if (/^\[\[\.\.\..+\]\]$/.test(seg)) re += "(?:/.+)?";
    else if (/^\[\.\.\..+\]$/.test(seg)) re += "/.+";
    else if (/^\[.+\]$/.test(seg)) re += "/[^/]+";
    else re += "/" + escape(seg);
  }
  return new RegExp(re + "$");
}

const COMPILED = KNOWN_ROUTE_PATTERNS.map(patternToRegExp);

/**
 * Split on "/" FIRST, then decode each segment (D-1247): an encoded slash stays inside its segment, so /market/BH%2FP is
 * one dynamic segment and not two. A decoded "/" is kept as the literal "%2F" so the segment regexes see one segment.
 */
function segmentsOf(raw: string): string[] | null {
  try {
    return raw
      .split("/")
      .filter(Boolean)
      .map((s) => decodeURIComponent(s).replace(/\//g, "%2F"));
  } catch {
    return null;
  }
}

export function isKnownRoute(raw: string, compiled: readonly RegExp[] = COMPILED): boolean {
  // Next's own internals (webpack-hmr in dev, data routes) are not ours to hide.
  if (raw.startsWith("/_next/")) return true;
  const segs = segmentsOf(raw);
  if (segs === null) return false;
  const p = "/" + segs.join("/");
  return compiled.some((re) => re.test(p));
}
