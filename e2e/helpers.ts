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
  const r = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  return r.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    nodes: v.nodes.map((n) => n.target.join(" ")),
  }));
}
