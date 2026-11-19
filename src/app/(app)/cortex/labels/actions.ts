"use server";
// The labelling form (M21 L1; UXN-318, D-1227). requireUser("admin") is the first await: only the Owner may label. One call
// appends one `golden_label` row (a label, a skip or an unclear flag); nothing is updated or deleted, and the audit event
// names the answer and the item, never the label values or the span.
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { audit, requestMeta } from "@/lib/auth/audit";
import { requireUser } from "@/lib/auth/guard";
import { authDb, mainDb } from "@/lib/db/client";
import {
  appendGolden,
  GOLDEN_ANSWERS,
  type GoldenAnswer,
  type GoldenInput,
} from "@/lib/labels/golden";
import { isMarketEnabled } from "@/lib/market/profile";
import type { OwnerActionResult } from "@/lib/ownerTools/result";

const PATH = "/cortex/labels";
const MAX_FIELD = 200; // threshold-ok: transport bound on a posted id field, not a rule

const text = (fd: FormData, name: string): string => {
  const v = fd.get(name);
  return typeof v === "string" ? v.slice(0, MAX_FIELD * 2) : "";
};

const SORRY: OwnerActionResult = {
  error: "unavailable",
  message: "That answer could not be saved. Try again later.",
};

/** Save one answer: answer = "labelled" (with the three choices), "skip" or "unclear". */
export async function saveGoldenAction(fd: FormData): Promise<OwnerActionResult> {
  const user = await requireUser("admin", PATH);
  const answer = text(fd, "answer");
  if (!(GOLDEN_ANSWERS as readonly string[]).includes(answer)) {
    return { error: "bad_answer", message: "Choose an answer first." };
  }
  const market = text(fd, "market");
  const source = text(fd, "source");
  const annId = text(fd, "ann_id");
  const spanText = text(fd, "span").trim();
  const input: GoldenInput = {
    market,
    source,
    annId,
    actor: `user:${user.id}`,
    answer: answer as GoldenAnswer,
    guidance: (text(fd, "guidance") || null) as GoldenInput["guidance"],
    eventConfirm: (text(fd, "event_confirm") || null) as GoldenInput["eventConfirm"],
    tone: (text(fd, "tone") || null) as GoldenInput["tone"],
    span: answer === "labelled" && spanText !== "" ? spanText : null,
  };
  if (
    answer === "labelled" &&
    (input.guidance === null || input.eventConfirm === null || input.tone === null)
  ) {
    return { error: "incomplete", message: "Answer all three questions, or skip this one." };
  }
  if (answer !== "labelled") {
    // a skip or an unclear flag carries no label, whatever else was ticked on the form
    Object.assign(input, { guidance: null, eventConfirm: null, tone: null });
  }
  try {
    const db = mainDb();
    if (!(await isMarketEnabled(db, market))) return SORRY;
    const now = new Date();
    await appendGolden(db, { ...input, at: now });
    await audit(authDb(), process.env, requestMeta(await headers()), {
      at: now.toISOString(),
      actorUserId: user.id,
      action: "owner.golden_label",
      targetType: "golden_label",
      targetId: `${market}:${annId}`.slice(0, MAX_FIELD),
      detail: { answer },
    });
  } catch (e) {
    if (e instanceof RangeError && /span/.test(e.message)) {
      return {
        error: "bad_span",
        message: "The quoted words must be copied from the headline exactly.",
      };
    }
    return SORRY;
  }
  revalidatePath(PATH);
  return { ok: true };
}
