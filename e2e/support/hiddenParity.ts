// M21 A2 (D-1210, AT-57, AT-77, AT-82): "a hidden route is a missing route". One snapshot of a response (status, headers,
// body after normalising what legitimately differs per request) for every way a request can arrive: html, RSC, RSC
// prefetch, HEAD, and a same-origin POST carrying a Next-Action header (a server action is dispatched from any URL).
// D-1210 retired the D-831 residual: x-nextjs-rewritten-path is compared like any other header, with no leak branch.
// D-1247: the normaliser masks only the two names of the pair under test (the hidden one and its missing twin), so a
// real difference elsewhere in the body (another route name, say) is not hidden by it.
import { expect, type APIResponse, type BrowserContext } from "@playwright/test";

export type Shot = { status: number; headers: Record<string, string>; body: string };

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Masks nonces, hashes and the two route names of one pair. */
export function normaliser(names: string[]): (s: string) => string {
  const alt = names.map(esc).join("|");
  const slashed = new RegExp(`/(?:api/)?(?:${alt})\\b`, "g");
  const bare = new RegExp(`\\b(?:${alt})\\b`, "g");
  return (s) =>
    s
      .replace(/nonce-[A-Za-z0-9+/=_-]+/g, "nonce-N")
      .replace(/nonce="[^"]*"/g, 'nonce="N"')
      .replace(/(\\*"nonce\\*":\\*")[^"\\]+/g, "$1N")
      .replace(/(callbackUrl=)[^&"\s]*/g, "$1X")
      .replace(/\/_next\/static\/[^"'\s)\\]+/g, "/_next/static/H")
      .replace(/"b":"[^"]*"/g, '"b":"B"')
      .replace(/\\*"[A-Za-z0-9_-]{21}[vm]\\*"/g, '"KEY"')
      .replace(slashed, "/P")
      .replace(bare, "P");
}

/** "/api/owner-tools/x?y=1" -> "owner-tools"; "/holdings" -> "holdings". */
export const nameOf = (path: string): string =>
  path
    .split("?")[0]!
    .replace(/^\/(?:api\/)?/, "")
    .split("/")[0]!;

async function shot(r: APIResponse, norm: (s: string) => string): Promise<Shot> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.headers())) {
    if (["date", "etag", "content-length", "x-nextjs-request-id"].includes(k)) continue;
    headers[k] = norm(v);
  }
  return { status: r.status(), headers, body: norm(await r.text()) };
}

type Variant = {
  name: string;
  send: (context: BrowserContext, url: string) => Promise<APIResponse>;
};

const base = (): string => process.env.APP_BASE_URL ?? "";
const get =
  (headers: Record<string, string>): Variant["send"] =>
  (c, url) =>
    c.request.get(url, { headers, maxRedirects: 0 });

export const VARIANTS: Variant[] = [
  { name: "html", send: get({}) },
  { name: "rsc", send: get({ RSC: "1" }) },
  { name: "rsc prefetch", send: get({ RSC: "1", "Next-Router-Prefetch": "1" }) },
  { name: "head", send: (c, url) => c.request.head(url, { maxRedirects: 0 }) },
  {
    name: "server action post",
    send: (c, url) =>
      c.request.post(url, {
        headers: {
          Origin: new URL(base()).origin,
          "Next-Action": "0000000000000000000000000000000000000000",
          "Content-Type": "text/plain;charset=UTF-8",
        },
        data: "[]",
        maxRedirects: 0,
      }),
  },
];

/** Each hidden path equals its missing twin in every variant, header for header. */
export async function expectHiddenEqualsMissing(
  context: BrowserContext,
  who: string,
  pairs: [hidden: string, missing: string][],
): Promise<void> {
  for (const v of VARIANTS) {
    for (const [h, m] of pairs) {
      const norm = normaliser([nameOf(h), nameOf(m)]);
      const hidden = await shot(await v.send(context, h), norm);
      const missing = await shot(await v.send(context, m), norm);
      expect(hidden, `${who} ${v.name} ${h}`).toEqual(missing);
    }
  }
}
