"use server";
// Add a note to a Decision Card (UXN-125 neighbour, ROL-102b, KB-051, UX-071a; D-125). Owner and Editor
// only: the guard runs first. The card is addressed the way the page is: a masked user can only use the
// opaque `ck:` reference, so a real id gets the same "not found" as an unknown one (D-135) and the real
// id never reaches the browser. The note itself is stored and audited by the shared annotation writer
// (audit first, one transaction); note text is never read by anything that builds an LLM context.
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requestMeta } from "@/lib/auth/audit";
import { requireUser } from "@/lib/auth/guard";
import { authDb, mainDb } from "@/lib/db/client";
import { addAnnotation } from "@/lib/learning/ownerActions";
import { isCardRef, resolveCardRef } from "@/lib/ui/loaders/cards";
import { maskContextFor } from "@/lib/view/mask";
import type { NoteResult } from "./messages";

const field = (fd: FormData, name: string): string | undefined => {
  const v = fd.get(name);
  return typeof v === "string" ? v : undefined;
};

export async function addCardNoteAction(fd: FormData): Promise<NoteResult> {
  const user = await requireUser("annotate", "/cards");
  const ref = field(fd, "ref");
  const text = field(fd, "text");
  if (ref === undefined || ref.length === 0 || ref.length > 300 || text === undefined) {
    return { error: "invalid" };
  }
  try {
    const main = mainDb();
    const auth = authDb();
    const ctx = await maskContextFor(user, auth);
    if (ctx.masked && !isCardRef(ref)) return { error: "not_found" };
    const id = await resolveCardRef(main, ref);
    if (id === null) return { error: "not_found" };
    const exists = await main.execute({
      sql: "SELECT 1 FROM decision_card WHERE id = ?",
      args: [id],
    });
    if (exists.rows.length === 0) return { error: "not_found" };
    const out = await addAnnotation(
      { mainDb: main, authDb: auth, env: process.env, meta: requestMeta(await headers()) },
      user,
      { subject_kind: "card", subject_id: id, text },
    );
    if (out.status !== 200) {
      const code = out.body.error;
      return { error: typeof code === "string" ? code : "unavailable" };
    }
  } catch {
    return { error: "unavailable" };
  }
  revalidatePath("/cards/[id]", "page");
  return { ok: true };
}
