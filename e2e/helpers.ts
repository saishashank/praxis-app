import type { BrowserContext, Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { encode } from "next-auth/jwt";
import { createClient } from "@libsql/client";

export type Role = "owner" | "editor" | "viewer";
export const EMAIL: Record<Role, string> = {
  owner: "owner@praxis.test",
  editor: "editor@praxis.test",
  viewer: "viewer@praxis.test",
};

// Mirrors src/app/api/test-identity/login/handler.ts: the same JWT claims and cookie name Auth.js
// uses on http. The HTTP login route cannot be used here: its replay store speaks only the Turso
// HTTP protocol (no file: databases), so the cookie is minted in-process from the per-run secret.
export async function signIn(context: BrowserContext, role: Role): Promise<void> {
  const authDb = createClient({ url: process.env.TURSO_AUTH_URL! });
  try {
    const res = await authDb.execute({
      sql: "SELECT id, session_version FROM app_user WHERE email = ?",
      args: [EMAIL[role]],
    });
    const name = "authjs.session-token";
    const value = await encode({
      token: {
        uid: Number(res.rows[0].id),
        sv: Number(res.rows[0].session_version),
        si: Math.floor(Date.now() / 1000),
        rec: false,
      },
      secret: process.env.AUTH_SECRET!,
      salt: name,
      maxAge: 86400,
    });
    await context.addCookies([{ name, value, url: process.env.APP_BASE_URL! }]);
  } finally {
    authDb.close();
  }
}

export async function setTheme(role: Role, theme: string): Promise<void> {
  const db = createClient({ url: process.env.TURSO_AUTH_URL! });
  try {
    const u = await db.execute({
      sql: "SELECT id FROM app_user WHERE email = ?",
      args: [EMAIL[role]],
    });
    const prefs = JSON.stringify({
      theme,
      default_market: "AU",
      time_format: "24h",
      alert_p1: "immediate",
      alert_p2: "digest",
    });
    await db.execute({
      sql: `INSERT INTO user_preference (user_id, prefs_json, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET prefs_json = excluded.prefs_json`,
      args: [Number(u.rows[0].id), prefs, new Date().toISOString()],
    });
  } finally {
    db.close();
  }
}

export async function axeViolations(page: Page) {
  // The Control Room boot fades its readouts in (<= 1.2 s, UXN-285 a); axe measures contrast through
  // opacity, so check the settled page, not a frame mid-fade.
  await page
    .locator('[data-boot="on"]')
    .waitFor({ state: "detached", timeout: 5_000 })
    .catch(() => {});
  const r = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  return r.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    nodes: v.nodes.map((n) => n.target.join(" ")),
  }));
}

export const THEMES = ["dark", "light", "system", "midnight", "dim", "high_contrast"] as const;

export const ROLE_LIST: readonly Role[] = ["owner", "editor", "viewer"];

/** UXN-017 / AT-26: no horizontal page scroll (call at phone width). */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  if (scrollWidth > innerWidth) {
    throw new Error(`horizontal scroll: scrollWidth ${scrollWidth} > innerWidth ${innerWidth}`);
  }
}

/** axe (WCAG 2.2 AA) on one path as `role` in every theme; returns violations per theme. */
export async function axeAllThemes(
  page: Page,
  context: BrowserContext,
  role: Role,
  path: string,
  themes: readonly string[] = THEMES,
): Promise<Record<string, Awaited<ReturnType<typeof axeViolations>>>> {
  await signIn(context, role);
  const out: Record<string, Awaited<ReturnType<typeof axeViolations>>> = {};
  for (const theme of themes) {
    await setTheme(role, theme);
    await page.goto(path);
    out[theme] = await axeViolations(page);
  }
  return out;
}

// ---- AT-25 / AT-26 / AT-27 shared helpers (M7 T20c) ----

/** Sample values that make the dynamic registry paths concrete on the populated seed (else null). */
const SAMPLES: Record<string, string> = { "/market/[code]": "/market/ZZAA" };

/** The URL to open for a registry path; null when it needs a seeded row the E2E seed lacks. */
export function concretePath(path: string, role: Role = "owner"): string | null {
  if (!path.includes("[")) return path;
  // Editors and Viewers never see a stock code, so they cannot open a company by code.
  if (process.env.E2E_SCENARIO !== "populated" || role !== "owner") return null;
  return SAMPLES[path] ?? null;
}

/** Fixture instrument codes (ZZAA...) and names ("ZZ Synthetic n Ltd"). */
export const CODE_RE = /\bZZ[A-Z]{2}\b/;
export const NAME_RE = /ZZ Synthetic/i;
/** Exact calendar dates (UX-009 masks trade dates for Editors and Viewers). */
export const EXACT_DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/;

/** Visible text of the page's main region. */
export async function mainText(page: Page): Promise<string> {
  return page.locator("main").first().innerText();
}

/** Money values whose card, row or section has no "Simulated" label (AT-27); returns snippets. */
export async function moneyWithoutSimulated(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bad: string[] = [];
    for (const el of Array.from(document.querySelectorAll("[data-money]"))) {
      let node: Element | null = el.parentElement;
      let ok = false;
      while (node && node.tagName !== "MAIN" && node.tagName !== "BODY") {
        if (/simulated/i.test(node.textContent ?? "")) {
          ok = true;
          break;
        }
        node = node.parentElement;
      }
      if (!ok) bad.push((el.textContent ?? "").trim().slice(0, 40));
    }
    return bad;
  });
}
