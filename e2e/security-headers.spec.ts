import { expect, test, type APIResponse } from "@playwright/test";
import { signIn } from "./helpers";

// SEC-012 / PLT-036 (M8 T4): the security headers on the local production build, one request for
// every class of response the app gives: a signed-in page, a redirect to sign-in, public pages, a
// JSON API (answered and refused), a 404, a refused cross-origin write, an Auth.js callback, a
// text file and a static asset. Headers only: no cookie value or body is printed.

type Headers = Record<string, string>;
const h = (res: APIResponse): Headers => res.headers();

/** Set by next.config.ts on every path, whatever the response is. */
function expectStaticHeaders(headers: Headers, label: string) {
  expect(headers["strict-transport-security"], `${label}: HSTS`).toMatch(
    /^max-age=(\d{8,}); includeSubDomains/,
  );
  expect(
    Number(/max-age=(\d+)/.exec(headers["strict-transport-security"])![1]),
  ).toBeGreaterThanOrEqual(31_536_000);
  expect(headers["x-content-type-options"], `${label}: nosniff`).toBe("nosniff");
  expect(headers["referrer-policy"], `${label}: Referrer-Policy`).toBe("same-origin");
  expect(headers["x-frame-options"], `${label}: X-Frame-Options`).toBe("DENY");
  expect(headers["x-robots-tag"], `${label}: noindex`).toMatch(/noindex/);
  expect(headers["permissions-policy"], `${label}: Permissions-Policy`).toContain("camera=()");
  expect(headers["x-powered-by"], `${label}: no framework banner`).toBeUndefined();
}

const directive = (csp: string, name: string): string =>
  csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d === name || d.startsWith(`${name} `)) ?? "";

/** Set by the request gate (src/lib/http/gate.ts) on everything it sees. */
function expectCsp(headers: Headers, label: string): string {
  const csp = headers["content-security-policy"];
  expect(csp, `${label}: CSP present`).toBeTruthy();
  const script = directive(csp, "script-src");
  const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(script)?.[1];
  expect(nonce, `${label}: script-src has a nonce`).toBeTruthy();
  expect(script).not.toContain("'unsafe-inline'");
  expect(script).not.toContain("'unsafe-eval'");
  expect(script).toContain("'strict-dynamic'");
  expect(directive(csp, "default-src")).toBe("default-src 'self'");
  expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'none'");
  expect(directive(csp, "object-src")).toBe("object-src 'none'");
  expect(directive(csp, "base-uri")).toBe("base-uri 'self'");
  expect(directive(csp, "form-action")).toContain("'self'");
  expect(directive(csp, "upgrade-insecure-requests")).toBe("upgrade-insecure-requests");
  expect(csp).not.toMatch(/\*|\shttp:/);
  return nonce!;
}

test.describe("security headers on the production build (SEC-012, PLT-036)", () => {
  test("public pages: /signin, /privacy, /terms", async ({ request }) => {
    for (const p of ["/signin", "/privacy", "/terms"]) {
      const res = await request.get(p);
      expect(res.status(), p).toBe(200);
      expectStaticHeaders(h(res), p);
      expectCsp(h(res), p);
      expect(h(res)["content-type"]).toContain("text/html");
    }
  });

  test("a signed-in page", async ({ context }) => {
    await signIn(context, "viewer");
    const res = await context.request.get("/");
    expect(res.status()).toBe(200);
    expectStaticHeaders(h(res), "/");
    expectCsp(h(res), "/");
  });

  test("the redirect to sign-in carries the headers too", async ({ request }) => {
    const res = await request.get("/", { maxRedirects: 0 });
    expect([302, 303, 307, 308]).toContain(res.status());
    expectStaticHeaders(h(res), "redirect");
    expectCsp(h(res), "redirect");
  });

  test("a 404 page (signed in)", async ({ context }) => {
    await signIn(context, "viewer");
    const res = await context.request.get("/no-such-page-for-the-header-test");
    expect(res.status()).toBe(404);
    expectStaticHeaders(h(res), "404");
    expectCsp(h(res), "404");
  });

  test("API: public health, a signed-in read, and an unauthenticated refusal", async ({
    context,
    request,
  }) => {
    const health = await request.get("/api/health");
    expect(health.status()).toBe(200);
    expectStaticHeaders(h(health), "/api/health");
    expectCsp(h(health), "/api/health");
    expect(h(health)["cache-control"]).toContain("no-store");

    const refused = await request.get("/api/alerts", { maxRedirects: 0 });
    expect(refused.status()).toBe(401);
    expectStaticHeaders(h(refused), "401");
    expectCsp(h(refused), "401");
    expect(h(refused)["cache-control"]).toContain("no-store");

    await signIn(context, "viewer");
    const ok = await context.request.get("/api/alerts");
    expect(ok.status()).toBe(200);
    expectStaticHeaders(h(ok), "/api/alerts");
    expectCsp(h(ok), "/api/alerts");
  });

  test("a refused cross-origin write (403) carries the headers", async ({ context }) => {
    await signIn(context, "viewer");
    const res = await context.request.post("/api/alerts/quiet-hours", {
      headers: { origin: "https://evil.example" },
      data: {},
    });
    expect(res.status()).toBe(403);
    expectStaticHeaders(h(res), "403");
    expectCsp(h(res), "403");
  });

  test("an Auth.js callback and sign-in endpoint", async ({ request }) => {
    for (const p of ["/api/auth/callback/google", "/api/auth/csrf", "/api/auth/providers"]) {
      const res = await request.get(p, { maxRedirects: 0 });
      expect(res.status(), p).toBeLessThan(500);
      expectStaticHeaders(h(res), p);
      expectCsp(h(res), p);
    }
  });

  test("robots.txt disallows everything and still carries the headers", async ({ request }) => {
    const res = await request.get("/robots.txt");
    expect(res.status()).toBe(200);
    expect(await res.text()).toMatch(/User-Agent: \*\s+Disallow: \//i);
    expectStaticHeaders(h(res), "/robots.txt");
    expectCsp(h(res), "/robots.txt");
  });

  test("a static asset carries the static headers (the gate does not run for it)", async ({
    request,
  }) => {
    const page = await (await request.get("/signin")).text();
    const src = /<script[^>]+src="(\/_next\/static\/[^"]+\.js[^"]*)"/.exec(page)?.[1];
    expect(src, "the sign-in page loads a static script").toBeTruthy();
    const res = await request.get(src!);
    expect(res.status()).toBe(200);
    expectStaticHeaders(h(res), "static asset");
    expect(h(res)["content-type"]).toMatch(/javascript/);
  });

  test("the nonce is fresh on every request and stamped on every script of the page", async ({
    request,
  }) => {
    const a = await request.get("/signin");
    const b = await request.get("/signin");
    const na = expectCsp(h(a), "first");
    const nb = expectCsp(h(b), "second");
    expect(na).not.toBe(nb);

    const html = await a.text();
    const tags = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
    expect(tags.length).toBeGreaterThan(0);
    for (const attrs of tags) {
      const stamped = /\bnonce="([^"]*)"/.exec(attrs)?.[1];
      // A browser hides the nonce attribute from the DOM, but the HTML source keeps it.
      expect(stamped, `script without nonce: ${attrs.slice(0, 80)}`).toBe(na);
    }
    expect(html).not.toMatch(/\son[a-z]+="/i); // no inline event handlers
  });

  test("the browser blocks an injected inline script (CSP enforced, not just sent)", async ({
    page,
  }) => {
    const violations: string[] = [];
    page.on("console", (m) => {
      if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
    });
    await page.goto("/signin");
    // Injected MARKUP is the threat (stored or reflected HTML): an inline event handler. With a
    // nonce and no 'unsafe-inline' / 'unsafe-hashes' the browser must refuse to run it. (A script
    // element created by already-running code is trusted on purpose under 'strict-dynamic', and
    // Playwright's evaluate counts as running code, so that is not a meaningful check.)
    await page.evaluate(() => {
      const holder = document.createElement("div");
      holder.innerHTML = '<img src="/does-not-exist.png" onerror="window.__injected = true">';
      document.body.appendChild(holder);
    });
    await expect.poll(() => violations.length).toBeGreaterThan(0);
    const ran = await page.evaluate(
      () => (window as unknown as { __injected?: boolean }).__injected === true,
    );
    expect(ran).toBe(false);
  });

  test("the page cannot be framed (frame-ancestors none, X-Frame-Options DENY)", async ({
    page,
  }) => {
    await page.goto("/signin");
    const blocked = await page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          const f = document.createElement("iframe");
          f.src = "/privacy";
          f.onload = () => {
            // A blocked frame loads the browser's error document; its content is not readable.
            try {
              resolve(!f.contentDocument?.body?.innerText?.includes("Privacy"));
            } catch {
              resolve(true);
            }
          };
          document.body.appendChild(f);
          setTimeout(() => resolve(true), 5000);
        }),
    );
    expect(blocked).toBe(true);
  });
});
