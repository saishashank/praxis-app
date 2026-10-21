"use server";
// Mark an Evening Review as read (EML-036, design 4.6 step 5). Owner only: requireUser("admin")
// runs first (a refusal is a 403 and is audit-logged by the guard, AT-02). The date and the way it
// was read come from the form but are validated here; the review must exist. A second mark of the
// same date is a no-op (review_read is insert-once). The email link /reviews/<d>?src=email marks
// through this action as a same-origin POST issued by the page after load: a GET never writes
// (decision 34).
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/guard";
import { mainDb } from "@/lib/db/client";
import { loadReview, markRead, type ReadVia } from "@/lib/review/assemble";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type MarkReadResult = { ok: true; firstRead: boolean } | { error: string };

export async function markReviewReadAction(fd: FormData): Promise<MarkReadResult> {
  const dText = fd.get("d");
  const d = typeof dText === "string" ? dText : "";
  await requireUser("admin", DATE_RE.test(d) ? `/reviews/${d}` : "/reviews");
  const viaText = fd.get("via");
  const via: ReadVia | null =
    viaText === "page" || viaText === "email_link" ? (viaText as ReadVia) : null;
  if (!DATE_RE.test(d) || via === null) return { error: "invalid" };
  try {
    const db = mainDb();
    if ((await loadReview(db, d)) === null) return { error: "not_found" };
    const r = await markRead(db, d, via, new Date());
    revalidatePath(`/reviews/${d}`);
    return { ok: true, firstRead: r.firstRead };
  } catch {
    return { error: "unavailable" };
  }
}
