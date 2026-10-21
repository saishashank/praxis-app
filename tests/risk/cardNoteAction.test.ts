// @vitest-environment node
// TST-122 for addCardNoteAction (Decision Card notes; ROL-102b, KB-051, UX-071a; M7 T13). Owner and
// Editor only; the guard runs first; a masked user can only address the card by its opaque reference,
// so a real id gets "not_found"; the note is stored against the real card id and audited; text is
// validated; the page is revalidated; failures give a code only.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditRows, KEY } from "../auth/helpers";
import { cleanupTempDbs } from "../db/helpers";
import { CARD_UP, EDITOR, emptyDbs, NOW, OWNER, seedPopulated, VIEWER } from "../loaders/seed";

const requireUser = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());
const mem = vi.hoisted(() => ({ main: null as unknown, auth: null as unknown }));
vi.mock("@/lib/auth/guard", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-real-ip": "9.9.9.9", "user-agent": "agent" }),
}));
vi.mock("@/lib/db/client", () => ({ mainDb: () => mem.main, authDb: () => mem.auth }));

import { addCardNoteAction } from "@/app/(app)/cards/[id]/actions";
import { cardRef } from "@/lib/ui/loaders/cards";

afterEach(() => {
  cleanupTempDbs();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

let auth: Client;
const as = (u: { id: number; role: string }) =>
  requireUser.mockResolvedValue({ ...u, email: `${u.role}@example.test`, name: null });
const form = (o: Record<string, string | undefined>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) if (v !== undefined) fd.set(k, v);
  return fd;
};
const notes = async () =>
  (await auth.execute("SELECT * FROM annotation ORDER BY id")).rows.map((r) => ({ ...r }));

beforeEach(async () => {
  vi.stubEnv("PII_HASH_KEY", KEY);
  // The opaque reference is resolved against the last 120 days: pin the clock to the seed's.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  requireUser.mockReset();
  revalidatePath.mockReset();
  const db = await emptyDbs();
  await seedPopulated(db);
  mem.main = db.main;
  mem.auth = db.auth;
  auth = db.auth;
});

describe("addCardNoteAction", () => {
  it("asks for the annotate action first", async () => {
    as(OWNER);
    await addCardNoteAction(form({ ref: CARD_UP, text: "ok" }));
    expect(requireUser).toHaveBeenCalledWith("annotate", "/cards");
  });

  it("the Owner adds a note by the real id: stored against the real id, audited, page revalidated", async () => {
    as(OWNER);
    expect(await addCardNoteAction(form({ ref: CARD_UP, text: "Looks fragile." }))).toEqual({
      ok: true,
    });
    const n = await notes();
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({
      subject_kind: "card",
      subject_id: CARD_UP,
      author_id: OWNER.id,
      text: "Looks fragile.",
    });
    expect((await auditRows(auth)).at(-1)).toMatchObject({
      action: "annotation.add",
      actor_user_id: OWNER.id,
    });
    expect(revalidatePath).toHaveBeenCalledWith("/cards/[id]", "page");
  });

  it("a masked Editor adds a note by the opaque reference; the stored subject is the real id", async () => {
    as(EDITOR);
    expect(await addCardNoteAction(form({ ref: cardRef(CARD_UP), text: "Check later." }))).toEqual({
      ok: true,
    });
    expect((await notes())[0]).toMatchObject({ subject_id: CARD_UP, author_id: EDITOR.id });
  });

  it("a masked Editor using the real id gets the same answer as an unknown id", async () => {
    as(EDITOR);
    const real = await addCardNoteAction(form({ ref: CARD_UP, text: "x" }));
    const unknown = await addCardNoteAction(form({ ref: "card:sig:none:E01", text: "x" }));
    const badRef = await addCardNoteAction(form({ ref: "ck:0000000000000000", text: "x" }));
    expect(real).toEqual({ error: "not_found" });
    expect(unknown).toEqual({ error: "not_found" });
    expect(badRef).toEqual({ error: "not_found" });
    expect(await notes()).toEqual([]);
  });

  it("an Editor with a live unmask grant may use the real id", async () => {
    await auth.execute({
      sql: `INSERT INTO unmask_grant (user_id, granted_by, granted_at, expires_at)
            VALUES (?, ?, '2026-10-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z')`,
      args: [EDITOR.id, OWNER.id],
    });
    as(EDITOR);
    expect(await addCardNoteAction(form({ ref: CARD_UP, text: "fine" }))).toEqual({ ok: true });
  });

  it("a Viewer is refused by the guard before anything is read or written", async () => {
    requireUser.mockRejectedValue(new Error("NEXT_HTTP_ERROR_FALLBACK;403"));
    void VIEWER;
    await expect(addCardNoteAction(form({ ref: cardRef(CARD_UP), text: "x" }))).rejects.toThrow(
      /403/,
    );
    expect(await notes()).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("validates the text and the reference", async () => {
    as(OWNER);
    for (const bad of [
      { ref: CARD_UP, text: "" },
      { ref: CARD_UP, text: "   " },
      { ref: CARD_UP, text: "x".repeat(1001) },
      { ref: CARD_UP, text: undefined },
      { ref: undefined, text: "x" },
      { ref: "", text: "x" },
      { ref: "y".repeat(301), text: "x" },
    ]) {
      expect(await addCardNoteAction(form(bad))).toEqual({ error: "invalid" });
    }
    expect(await addCardNoteAction(form({ ref: "card:missing", text: "x" }))).toEqual({
      error: "not_found",
    });
    expect(await notes()).toEqual([]);
  });
});
