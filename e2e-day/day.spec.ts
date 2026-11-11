import { expect, test } from "@playwright/test";
import { createClient } from "@libsql/client";
import { encode } from "next-auth/jwt";
import { testLogin } from "../scripts/e2e/test-login.mjs";

// The viewer walk of the recorded day (M18 OPS-107 / D-965; was e2e-staging/staging.spec.ts, M8 T12,
// TST-106, TST-132). Read-only: no form is submitted and nothing is changed. Assertions never include
// the address or a cookie value in a message.
//
// Sign-in: on the recorded day the app is the local production build (PRAXIS_ENV=recorded). The HTTP
// test-identity route cannot serve a file: database (its replay store speaks only Turso HTTP) and
// answers 404 outside staging, so the viewer session is minted here with the claims the route issues,
// from the per-run AUTH_SECRET and the seeded viewer. The retired staging workflows (dispatch only) still
// use the HTTP route: PRAXIS_ENV=staging selects it.

const VIEWER = "viewer@praxis.test"; // the seeded test identity (.test addresses only)
const COOKIE_NAME = "authjs.session-token"; // plain-http name (src/lib/auth/cookies.ts)

async function viewerCookie(baseURL: string): Promise<{ name: string; value: string }> {
  if (process.env.PRAXIS_ENV !== "recorded") {
    const secret = process.env.TEST_IDENTITY_SECRET;
    if (!secret) throw new Error("test identity is not configured");
    const pair = await testLogin(baseURL, secret, VIEWER);
    const eq = pair.indexOf("=");
    return { name: pair.slice(0, eq), value: pair.slice(eq + 1) };
  }
  const authSecret = process.env.AUTH_SECRET;
  const authDbUrl = process.env.TURSO_AUTH_URL;
  if (!authSecret || !authDbUrl) throw new Error("the recorded-day auth settings are missing");
  const db = createClient({ url: authDbUrl });
  try {
    const res = await db.execute({
      sql: "SELECT id, session_version FROM app_user WHERE email = ? AND status = 'active'",
      args: [VIEWER],
    });
    if (!res.rows.length) throw new Error("the viewer test identity is not seeded");
    // The app runs on the simulated clock (PRAXIS_SIM_NOW): the session is issued at that instant.
    const sim = process.env.PRAXIS_SIM_NOW ? Date.parse(process.env.PRAXIS_SIM_NOW) : NaN;
    const nowSec = Math.floor((Number.isNaN(sim) ? Date.now() : sim) / 1000);
    const value = await encode({
      token: {
        uid: Number(res.rows[0].id),
        sv: Number(res.rows[0].session_version),
        si: nowSec,
        rec: false,
        iat: nowSec,
      },
      secret: authSecret,
      salt: COOKIE_NAME,
      maxAge: 86400,
    });
    return { name: COOKIE_NAME, value };
  } finally {
    db.close();
  }
}

test.describe("recorded day, signed out", () => {
  test("/ sends a signed-out visitor to sign-in", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/signin/);
    await expect(page.getByRole("button", { name: "Sign in with Google" })).toBeVisible();
  });

  test("the health endpoint answers", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.status()).toBe(200);
  });
});

test.describe("recorded day, test identity (viewer)", () => {
  test.beforeEach(async ({ context, baseURL }) => {
    if (!baseURL) throw new Error("the address is not configured");
    const { name, value } = await viewerCookie(baseURL);
    await context.addCookies([{ name, value, url: baseURL, httpOnly: true }]);
  });

  for (const [path, heading] of [
    ["/", null],
    ["/health", "System Health"],
    ["/market", null],
    ["/reviews", null],
  ] as const) {
    test(`${path} loads for a viewer`, async ({ page }) => {
      const res = await page.goto(path);
      expect(res?.status()).toBe(200);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      if (heading) await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
    });
  }

  test("System Health hides the Owner-only day timeline from a viewer", async ({ page }) => {
    await page.goto("/health");
    await expect(page.getByRole("heading", { name: "Day timeline check" })).toHaveCount(0);
  });
});
