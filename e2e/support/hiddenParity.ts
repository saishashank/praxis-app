// M21 A2 (D-1210, AT-57, AT-77, AT-82): "a hidden route is a missing route". One snapshot of a response (status, headers,
// body after normalising what legitimately differs per request) and the html and RSC variants, shared by the Blueprint
// and the Owner-tools access specs. D-1210 retired the D-831 residual: x-nextjs-rewritten-path is compared like any
// other header, with no leak branch.
import { expect, type APIResponse, type BrowserContext } from "@playwright/test";

export type Shot = { status: number; headers: Record<string, string>; body: string };

const HIDDEN_NAMES = "zz-missing|blueprint|recommendations|holdings|trades|owner-tools";

export const norm = (s: string): string =>
  s
    .replace(/nonce-[A-Za-z0-9+/=_-]+/g, "nonce-N")
    .replace(/nonce="[^"]*"/g, 'nonce="N"')
    .replace(/(\\*"nonce\\*":\\*")[^"\\]+/g, "$1N")
    .replace(/(callbackUrl=)[^&"\s]*/g, "$1X")
    .replace(/\/_next\/static\/[^"'\s)\\]+/g, "/_next/static/H")
    .replace(/"b":"[^"]*"/g, '"b":"B"')
    .replace(/\\*"[A-Za-z0-9_-]{21}[vm]\\*"/g, '"KEY"')
    .replace(new RegExp(`/(?:api/)?(?:${HIDDEN_NAMES})\\b`, "g"), "/P")
    .replace(new RegExp(`\\b(?:${HIDDEN_NAMES})\\b`, "g"), "P");

export async function shot(r: APIResponse): Promise<Shot> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.headers())) {
    if (["date", "etag", "content-length", "x-nextjs-request-id"].includes(k)) continue;
    headers[k] = norm(v);
  }
  return { status: r.status(), headers, body: norm(await r.text()) };
}

export const VARIANTS: [string, Record<string, string>][] = [
  ["html", {}],
  ["rsc", { RSC: "1" }],
];

/** Each hidden path equals its missing twin for html and RSC, header for header. */
export async function expectHiddenEqualsMissing(
  context: BrowserContext,
  who: string,
  pairs: [hidden: string, missing: string][],
): Promise<void> {
  for (const [name, headers] of VARIANTS) {
    const opts = { headers, maxRedirects: 0 };
    for (const [h, m] of pairs) {
      const hidden = await shot(await context.request.get(h, opts));
      const missing = await shot(await context.request.get(m, opts));
      expect(hidden, `${who} ${name} ${h}`).toEqual(missing);
    }
  }
}
