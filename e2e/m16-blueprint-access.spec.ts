// M16 WP1 / AT-57 (a)(e): /blueprint must be indistinguishable from a missing route for everyone
// except the pinned Owner, at the HTTP layer of a production build (D-371).
// The DB allows one owner row, so a "second owner-role identity" cannot be seeded here; that case is
// covered by the guard unit test. Accepted: a signed-in non-owner costs one extra auth-DB read in the
// proxy, a timing difference we do not hide (no sleeps).
import { expect, test, type APIResponse } from "@playwright/test";
import { signIn, type Role } from "./helpers";

type Shot = { status: number; headers: Record<string, string>; body: string };

const norm = (s: string): string =>
  s
    .replace(/nonce-[A-Za-z0-9+/=_-]+/g, "nonce-N")
    .replace(/nonce="[^"]*"/g, 'nonce="N"')
    .replace(/(\\*"nonce\\*":\\*")[^"\\]+/g, "$1N")
    .replace(/(callbackUrl=)[^&"\s]*/g, "$1X")
    .replace(/\/_next\/static\/[^"'\s)\\]+/g, "/_next/static/H")
    .replace(/"b":"[^"]*"/g, '"b":"B"')
    .replace(/\\*"[A-Za-z0-9_-]{21}[vm]\\*"/g, '"KEY"')
    .replace(/\/(?:api\/)?(?:zz-missing|blueprint)\b/g, "/P")
    .replace(/\b(?:zz-missing|blueprint)\b/g, "P");

async function shot(r: APIResponse): Promise<Shot> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.headers())) {
    if (["date", "etag", "content-length", "x-nextjs-request-id"].includes(k)) continue;
    headers[k] = norm(v);
  }
  return { status: r.status(), headers, body: norm(await r.text()) };
}

const VARIANTS: [string, Record<string, string>][] = [
  ["html", {}],
  ["rsc", { RSC: "1" }],
];

for (const role of [null, "editor", "viewer"] as const) {
  test(`/blueprint equals a missing route for ${role ?? "anonymous"}`, async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({ baseURL });
    if (role) await signIn(context, role as Role);
    for (const [name, headers] of VARIANTS) {
      const opts = { headers, maxRedirects: 0 };
      for (const [h, m] of [
        ["/blueprint", "/zz-missing"],
        ["/api/blueprint/model", "/api/zz-missing/model"],
      ]) {
        const hidden = await shot(await context.request.get(h, opts));
        const missing = await shot(await context.request.get(m, opts));
        // KNOWN RESIDUAL (S4): Next adds x-nextjs-rewritten-path to an RSC response that went
        // through a rewrite, after the proxy has run, so the gate cannot remove it. It appears
        // only for a signed-in non-owner on an RSC request. Everything else must match exactly.
        const leak = hidden.headers["x-nextjs-rewritten-path"];
        if (role && name === "rsc") expect(leak).toBe("/_praxis-absent");
        else expect(leak).toBeUndefined();
        delete hidden.headers["x-nextjs-rewritten-path"];
        expect(hidden, `${role ?? "anonymous"} ${name} ${h}`).toEqual(missing);
      }
    }
    await context.close();
  });
}

test("signed-in non-owner sees a real 404", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  await signIn(context, "editor");
  const r = await context.request.get("/blueprint", { maxRedirects: 0 });
  expect(r.status()).toBe(404);
  await context.close();
});

test("the pinned Owner gets the shell", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  await signIn(context, "owner");
  const page = await context.newPage();
  const res = await page.goto("/blueprint");
  expect(res?.status()).toBe(200);
  await expect(page.getByTestId("blueprint-shell")).toBeAttached();
  const robots = await page.locator('meta[name="robots"]').getAttribute("content");
  expect(robots).toContain("noindex");
  await context.close();
});
