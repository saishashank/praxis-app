// @vitest-environment node
// The Sources page and its Owner action (M22 E2; UXN-296, DAT-229, D-1480): approve, dismiss and snooze 90 days, audited
// before the change; only the Owner (an Editor and a Viewer are a 403 with no audit row and no change); approving respects
// expert_tracked_max; the page reads in plain words, hides snoozed people, and is Owner only. Synthetic ZZ data.
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditRows, ENV, KEY } from "../../auth/helpers";
import { cleanupTempDbs } from "../../db/helpers";
import { zzWorld, type World } from "../uiWorld";
import { licence, rowsOf, setKey } from "./helpers";

const requireUser = vi.hoisted(() => vi.fn());
const mem = vi.hoisted(() => ({
  main: null as unknown,
  auth: null as unknown,
  user: null as unknown,
}));
vi.mock("@/lib/auth/guard", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("@/lib/db/client", () => ({ mainDb: () => mem.main, authDb: () => mem.auth }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

import { candidateAction } from "@/app/(app)/reviews/experts/sources/actions";
import SourcesPage from "@/app/(app)/reviews/experts/sources/page";
import { can, type Role } from "@/lib/auth/permissions";
import { candidateId } from "@/lib/experts/poll/discovery";
import { snoozeUntil } from "@/lib/experts/poll/candidates";

afterAll(cleanupTempDbs);
process.env.PII_HASH_KEY = ENV.PII_HASH_KEY ?? KEY;

let w: World;
beforeEach(async () => {
  requireUser.mockReset();
  process.env.PII_HASH_KEY = KEY;
  w = await zzWorld();
  mem.main = w.main;
  mem.auth = w.auth;
});

const as = (id: number, role: string) =>
  requireUser.mockImplementation(async (need: string) => {
    if (!can(role as Role, need)) throw new Error("NEXT_HTTP_ERROR_FALLBACK;403");
    return { id, role, email: `${role}@example.test`, name: null };
  });
const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const CAND = candidateId("freshvoice");
const addCandidate = (
  id = CAND,
  name = "@freshvoice",
  pollJson: object = { disc: { n: 3, by: ["X-ZZ1", "X-ZZ2"], d: "2030-03-03" } },
) =>
  w.main.execute({
    sql: `INSERT INTO expert (id, name, platforms_json, handles_json, home_urls_json, markets_json, focus_json, licence_status,
            status, tier, no_feed, poll_json, created_at, updated_at)
          VALUES (?, ?, '[]', '{}', '[]', '[]', '[]', 'unchecked', 'candidate', 'discovered', 0, ?, 'x', 'x')`,
    args: [id, name, JSON.stringify(pollJson)],
  });
const audits = async () =>
  (await auditRows(w.auth)).filter((a) => String(a.action).startsWith("expert_candidate"));
const statusOf = async (id = CAND) =>
  String((await rowsOf(w.main, "SELECT status FROM expert WHERE id = ?", [id]))[0]!.status);

describe("candidateAction", () => {
  it("the Owner approves: the expert is tracked and one audit row carries the ids and statuses", async () => {
    await addCandidate();
    as(w.owner, "owner");
    expect(await candidateAction(form({ action: "approve", expert: CAND }))).toEqual({ ok: true });
    expect(await statusOf()).toBe("tracked");
    const a = await audits();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ action: "expert_candidate_approve", target_id: CAND });
    expect(String(a[0]!.detail_json)).toContain('"to":"tracked"');
    expect(String(a[0]!.detail_json)).not.toContain("freshvoice");
  });

  it("dismiss retires the candidate", async () => {
    await addCandidate();
    as(w.owner, "owner");
    expect(await candidateAction(form({ action: "dismiss", expert: CAND }))).toEqual({ ok: true });
    expect(await statusOf()).toBe("retired");
    expect((await audits())[0]).toMatchObject({ action: "expert_candidate_dismiss" });
  });

  it("snooze keeps the candidate and hides it for ninety days; the other state is kept", async () => {
    await addCandidate();
    as(w.owner, "owner");
    const now = new Date();
    expect(await candidateAction(form({ action: "snooze", expert: CAND }))).toEqual({ ok: true });
    expect(await statusOf()).toBe("candidate");
    const st = JSON.parse(
      String(
        (await rowsOf(w.main, "SELECT poll_json FROM expert WHERE id = ?", [CAND]))[0]!.poll_json,
      ),
    );
    expect(st.snz).toBe(snoozeUntil(now));
    expect(st.disc.n).toBe(3);
    const days =
      (Date.parse(`${st.snz}T00:00:00Z`) -
        Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`)) /
      86_400_000;
    expect(days).toBe(90);
    expect((await audits())[0]).toMatchObject({ action: "expert_candidate_snooze" });
  });

  it("an Editor and a Viewer are refused: no change and no audit row", async () => {
    await addCandidate();
    for (const [id, role] of [
      [w.editor, "editor"],
      [w.viewer, "viewer"],
    ] as const) {
      as(id, role);
      await expect(candidateAction(form({ action: "approve", expert: CAND }))).rejects.toThrow(
        /403/,
      );
    }
    expect(await statusOf()).toBe("candidate");
    expect(await audits()).toEqual([]);
  });

  it("the service re-checks the role even when the guard let a non-Owner through", async () => {
    await addCandidate();
    requireUser.mockImplementation(async () => ({
      id: w.editor,
      role: "owner",
      email: "e@example.test",
      name: null,
    }));
    expect(await candidateAction(form({ action: "approve", expert: CAND }))).toEqual({
      error: "forbidden",
    });
    expect(await statusOf()).toBe("candidate");
    expect(await audits()).toEqual([]);
  });

  it("refuses a bad action, a bad id, an unknown expert and an expert that is not a candidate, with no audit row", async () => {
    as(w.owner, "owner");
    expect(await candidateAction(form({ action: "delete", expert: CAND }))).toEqual({
      error: "invalid",
    });
    expect(await candidateAction(form({ action: "approve", expert: "bad id!" }))).toEqual({
      error: "invalid",
    });
    expect(await candidateAction(form({ action: "approve" }))).toEqual({ error: "invalid" });
    expect(await candidateAction(form({ action: "approve", expert: "X-NONE" }))).toEqual({
      error: "not_found",
    });
    expect(await candidateAction(form({ action: "approve", expert: "X-ZZ1" }))).toEqual({
      error: "not_a_candidate",
    });
    expect(await audits()).toEqual([]);
  });

  it("approving respects expert_tracked_max", async () => {
    await setKey(w.main, "expert_tracked_max", 20);
    for (let i = 0; i < 16; i++) await addCandidate(`T-${i}`, `@tracked${i}`);
    await w.main.execute("UPDATE expert SET status = 'tracked' WHERE id LIKE 'T-%'"); // 4 + 16 = 20 tracked
    await addCandidate();
    as(w.owner, "owner");
    expect(await candidateAction(form({ action: "approve", expert: CAND }))).toEqual({
      error: "full",
    });
    expect(await statusOf()).toBe("candidate");
    expect(await audits()).toEqual([]);
    expect(await candidateAction(form({ action: "dismiss", expert: CAND }))).toEqual({ ok: true }); // a dismissal needs no room
  });

  it("a write that fails after the audit row appends a failed row and changes nothing", async () => {
    await addCandidate();
    await w.main.execute(
      `CREATE TRIGGER t_fail BEFORE UPDATE ON expert WHEN NEW.id = '${CAND}' AND NEW.status = 'tracked' BEGIN SELECT RAISE(ABORT, 'no'); END`,
    );
    as(w.owner, "owner");
    expect(await candidateAction(form({ action: "approve", expert: CAND }))).toEqual({
      error: "unavailable",
    });
    expect(await statusOf()).toBe("candidate");
    expect((await audits()).map((a) => a.action)).toEqual([
      "expert_candidate_approve",
      "expert_candidate_approve_failed",
    ]);
  });
});

const text = (html: string) =>
  html
    .replace(/<script.*?<\/script>/gs, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
const page = async () => renderToStaticMarkup(await SourcesPage());

describe("the Sources page", () => {
  it("is Owner only: every other role is refused by the guard", async () => {
    for (const [id, role] of [
      [w.editor, "editor"],
      [w.viewer, "viewer"],
    ] as const) {
      as(id, role);
      await expect(SourcesPage()).rejects.toThrow(/403/);
    }
    expect(requireUser).toHaveBeenCalledWith("admin", "/reviews/experts/sources");
  });

  it("says in words which sources are read and which are not, with the counts, and no internal code", async () => {
    await licence(w.main, "X-ZZ1", "https://zz1.example.test");
    await licence(w.main, "X-ZZ2", "https://zz2.example.test", {
      status: "no",
      robots: "disallows",
    });
    await w.main.execute({
      sql: "UPDATE expert SET poll_json = ? WHERE id = 'X-ZZ1'",
      args: [JSON.stringify({ p: "2030-03-04T09:00:00.000Z" })],
    });
    as(w.owner, "owner");
    const t = text(await page());
    expect(t).toContain("Expert sources");
    expect(t).toContain("zz1.example.test");
    expect(t).toContain("Allowed for titles and links only");
    expect(t).toContain("robots file asks automated readers to stay away");
    expect(t).toContain("Not checked yet. Nothing is read from it until it has been checked.");
    expect(t).toContain("2030-03-04");
    expect(t).not.toMatch(/KB-\d|D-\d{3}|owner-accepted-risk|R1|R2/);
    expect(t).toContain("Nobody is waiting for a decision.");
  });

  it("lists the candidates with their facts and the three buttons; a snoozed one is hidden and counted", async () => {
    await addCandidate();
    await addCandidate(candidateId("later"), "@later", {
      disc: { n: 2, by: ["X-ZZ1", "X-ZZ2"], d: "2030-03-01" },
      snz: "2999-01-01",
    });
    as(w.owner, "owner");
    const html = await page();
    const t = text(html);
    expect(t).toContain("@freshvoice");
    expect(t).toContain("named 3 times by 2 experts, last seen 2030-03-03");
    expect(t).toContain("Red flags: manual check needed.");
    expect(t).not.toContain("@later");
    expect(t).toContain("1 more person is snoozed.");
    for (const b of ["Approve", "Dismiss", "Snooze 90 days"]) expect(html).toContain(b);
    expect(html.match(/name="action"/g)).toHaveLength(3);
  });

  it("an expired snooze brings the person back", async () => {
    await addCandidate(CAND, "@freshvoice", {
      disc: { n: 2, by: ["X-ZZ1"], d: "2030-03-01" },
      snz: "2000-01-01",
    });
    as(w.owner, "owner");
    expect(text(await page())).toContain("@freshvoice");
  });

  it("a hostile name is rendered as text, never as markup", async () => {
    await addCandidate("D-evil", "@x<img src=x onerror=alert(1)>");
    as(w.owner, "owner");
    const html = await page();
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  it("shows the waiting headlines", async () => {
    await w.main.execute({
      sql: `INSERT INTO source_item (id, expert_id, url, platform, title, published_at, ingested_at, content_hash, summary,
              quote, kind, extraction_status) VALUES (?, 'X-ZZ1', 'https://zz1.example.test/w/1', 'site', 't', NULL, ?, NULL, NULL, NULL, 'other', 'pending')`,
      args: ["a".repeat(64), "2030-03-04T00:00:00.000Z"],
    });
    as(w.owner, "owner");
    expect(text(await page())).toContain("1 headline is waiting for a model to look at.");
  });
});
