// @vitest-environment node
// AT-34 (M11-lite WP6; AGT-133a, UXN-287, PRD-033; D-492): steelman rule suggestions on /review.
// Visible to the Owner only; "Dismiss" is audited and changes nothing but the suggestion row (rule and
// breaker tables byte-equal); an open suggestion expires by trading-session count; no "certain /
// guaranteed / will" wording; the card section is masked for a masked viewer. Synthetic ZZ data on the
// real migrations; no network.
import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditRows, KEY } from "../../auth/helpers";
import { cleanupTempDbs } from "../../db/helpers";
import {
  CARD_UP,
  emptyDbs,
  EDITOR,
  OWNER,
  seedPopulated,
  VIEWER,
  type Both,
} from "../../loaders/seed";
import { BEAR_MON, seedSteelman } from "../../steelman/uiSeed";

const requireUser = vi.hoisted(() => vi.fn());
const mem = vi.hoisted(() => ({ main: null as unknown, auth: null as unknown }));
vi.mock("@/lib/auth/guard", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/db/client", () => ({ mainDb: () => mem.main, authDb: () => mem.auth }));

import ReviewPage from "@/app/(app)/review/page";
import { dismissSuggestionAction } from "@/app/(app)/review/actions";
import { expireSuggestions } from "@/lib/steelman/suggestions";
import { readSuggestion } from "@/lib/steelman/store";

let db: Both;
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

/** Owner on every guard; a non-Owner is refused by the "admin" guard exactly as the real one does. */
const as = (u: { id: number; role: string }) =>
  requireUser.mockImplementation(async (need: string) => {
    if (need === "admin" && u.role !== "owner") throw new Error("NEXT_HTTP_ERROR_FALLBACK;403");
    return { ...u, email: `${u.role}@example.test`, name: null };
  });
const form = (id: string) => {
  const f = new FormData();
  f.set("id", id);
  return f;
};

/** sha256 of the ordered dump of every rule and breaker table (and the label table the editor writes). */
async function ruleBreakerHash(main: Client): Promise<string> {
  const h = createHash("sha256");
  for (const t of ["rule_version", "rule_version_status", "thesis_breaker_eval", "label"]) {
    const r = await main.execute(`SELECT * FROM ${t}`);
    const lines = r.rows.map((x) => JSON.stringify(Object.values(x).map(String))).sort();
    h.update(t + lines.join("|"));
  }
  return h.digest("hex");
}

beforeAll(async () => {
  db = await emptyDbs();
  await seedPopulated(db);
  await seedSteelman(db.main);
});
afterAll(cleanupTempDbs);
beforeEach(() => {
  requireUser.mockReset();
  mem.main = db.main;
  mem.auth = db.auth;
  process.env.PII_HASH_KEY = KEY;
});

describe("AT-34 visibility", () => {
  it("the Owner sees the group: card link, bear point, evidence, rule editor link, Dismiss", async () => {
    as(OWNER);
    const html = renderToStaticMarkup(await ReviewPage());
    expect(requireUser).toHaveBeenCalledWith("admin", "/review");
    expect(html).toContain('data-testid="steelman-suggestion"');
    expect(html).toContain("ZZUP depends on one result that may not repeat.");
    expect(html).toContain("E02");
    expect(html).toContain(`href="/cards/${encodeURIComponent(CARD_UP)}"`);
    expect(html).toContain('href="/reviews/learned/families/F1"');
    expect(html).toContain(">Open rule editor</a>");
    expect(html).toContain("Dismiss");
  });

  it("an Editor and a Viewer get a 403 and nothing of the suggestion", async () => {
    for (const who of [EDITOR, VIEWER]) {
      as(who);
      let html = "";
      await expect(
        (async () => {
          html = renderToStaticMarkup(await ReviewPage());
        })(),
      ).rejects.toThrow(/403/);
      expect(html).not.toContain("ZZUP");
      expect(html).not.toContain("steelman-suggestion");
    }
  });

  it("a non-Owner cannot dismiss: the action is refused and the row stays open", async () => {
    for (const who of [EDITOR, VIEWER]) {
      as(who);
      await expect(dismissSuggestionAction(form(BEAR_MON.pointId))).rejects.toThrow(/403/);
    }
    expect((await readSuggestion(db.main, BEAR_MON.pointId))!.status).toBe("open");
  });

  it("the wording never says certain, guaranteed or will", async () => {
    as(OWNER);
    const html = renderToStaticMarkup(await ReviewPage());
    const at = html.indexOf('aria-label="Rule suggestions"');
    const group = at < 0 ? "" : html.slice(at, html.indexOf("Home", at));
    expect(group).toContain("Open rule editor");
    const t = text(group);
    expect(t).not.toMatch(/\b(certain|certainly|guaranteed|will)\b/i);
  });
});

describe("AT-34 dismiss and expiry", () => {
  it("dismiss writes an audit row and leaves rule and breaker tables byte-equal", async () => {
    as(OWNER);
    const before = await ruleBreakerHash(db.main);
    const auditBefore = (await auditRows(db.auth)).length;
    expect(await dismissSuggestionAction(form(BEAR_MON.pointId))).toEqual({ ok: true });
    expect(await ruleBreakerHash(db.main)).toBe(before);
    const rows = await auditRows(db.auth);
    expect(rows).toHaveLength(auditBefore + 1);
    expect(rows[rows.length - 1]).toMatchObject({
      action: "steelman_suggestion_dismiss",
      target_type: "steelman_suggestion",
      target_id: BEAR_MON.pointId,
      actor_user_id: OWNER.id,
    });
    const s = (await readSuggestion(db.main, BEAR_MON.pointId))!;
    expect(s).toMatchObject({ status: "dismissed", closedBy: String(OWNER.id) });
    expect(s.closedAt).not.toBeNull();
    // the group is gone, and a second dismissal is refused without a second audit row
    expect(renderToStaticMarkup(await ReviewPage())).not.toContain("steelman-suggestion");
    expect(await dismissSuggestionAction(form(BEAR_MON.pointId))).toEqual({ error: "not_open" });
    expect(await auditRows(db.auth)).toHaveLength(auditBefore + 1);
  });

  it("an invalid or unknown id changes nothing", async () => {
    as(OWNER);
    const auditBefore = (await auditRows(db.auth)).length;
    // shape check in the action (D-561): not a suggestion id -> refused before any read
    for (const bad of ["", "nope", "x".repeat(300), `${"c".repeat(64)}:bull:1; DROP TABLE x`]) {
      expect(await dismissSuggestionAction(form(bad))).toEqual({ error: "invalid" });
    }
    // well-formed but unknown -> not found; neither writes an audit row
    expect(await dismissSuggestionAction(form(`${"e".repeat(64)}:bull:1`))).toEqual({
      error: "not_found",
    });
    expect(await auditRows(db.auth)).toHaveLength(auditBefore);
  });

  it("expires by trading-session count, closed by 'system', and never touches rules", async () => {
    const own = await emptyDbs();
    await seedPopulated(own);
    await seedSteelman(own.main);
    const before = await ruleBreakerHash(own.main);
    const cal: never[] = [];
    // created on 2026-10-19 (Mon). Weekday sessions after it: 20,21,22,23 (age 4 on the 23rd).
    expect(
      await expireSuggestions(own.main, "AU", "2026-10-22", cal, 4, "2026-10-22T09:00:00Z"),
    ).toBe(0);
    expect((await readSuggestion(own.main, BEAR_MON.pointId))!.status).toBe("open");
    expect(
      await expireSuggestions(own.main, "AU", "2026-10-23", cal, 4, "2026-10-23T09:00:00Z"),
    ).toBe(1);
    expect(await readSuggestion(own.main, BEAR_MON.pointId)).toMatchObject({
      status: "expired",
      closedBy: "system",
    });
    expect(await ruleBreakerHash(own.main)).toBe(before);
  });
});

describe("AT-34 masking and wording of the card section", () => {
  it("the Owner-only group is never rendered inside the card page for a viewer", async () => {
    const { loadCardPage, cardRef } = await import("@/lib/ui/loaders/cards");
    const r = await loadCardPage(
      { mainDb: db.main, authDb: db.auth, user: VIEWER, now: new Date("2026-10-20T03:00:00.000Z") },
      cardRef(CARD_UP),
    );
    expect(JSON.stringify(r.data.steelman)).not.toMatch(/ZZUP|Zed Upward|suggestion/);
  });
});
