"use server";
// Pause / resume a strategy and switch a family off / on (UX-050; docs/M7_design.md decision 51;
// D-128 draft). HIGH RISK, Owner only. Order of work: the role guard FIRST (a refusal is a 403 and is
// audit-logged by the guard), then validation, then the shared Owner writer, which refuses in
// data-only mode, appends the audit event BEFORE the change and appends one row to the append-only
// `arena_control` log (src/lib/learning/arenaControl.ts). Origin and rate limits are applied by the
// proxy gate (SEC-011/014). The result is a code only; the page turns it into text.
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requestMeta } from "@/lib/auth/audit";
import { requireUser } from "@/lib/auth/guard";
import { authDb, mainDb } from "@/lib/db/client";
import { clearCohortInvariants } from "@/lib/arena/unfreeze";
import { setArenaControl } from "@/lib/learning/arenaControl";
import type { ControlResult } from "./messages";

const PATH = "/strategies/risk";

const field = (fd: FormData, name: string): string | undefined => {
  const v = fd.get(name);
  return typeof v === "string" ? v : undefined;
};

export async function setArenaControlAction(fd: FormData): Promise<ControlResult> {
  const user = await requireUser("admin", PATH);
  let result;
  try {
    result = await setArenaControl(
      {
        mainDb: mainDb(),
        authDb: authDb(),
        env: process.env,
        meta: requestMeta(await headers()),
      },
      user,
      {
        scope: field(fd, "scope"),
        key: field(fd, "key"),
        state: field(fd, "state"),
        reason: field(fd, "reason"),
        confirm: field(fd, "confirm") === "true",
      },
    );
  } catch {
    return { error: "unavailable" };
  }
  if (result.status !== 200) {
    const code = result.body.error;
    return { error: typeof code === "string" ? code : "unavailable" };
  }
  revalidatePath(PATH);
  revalidatePath("/strategies");
  revalidatePath("/");
  return { ok: true };
}

/**
 * Let a frozen cohort carry on after the cause of a fatal ledger verdict was fixed (V1-S1, D-680..D-682).
 * Same order of work as above: the role guard FIRST, validation, then the shared Owner writer
 * (src/lib/arena/unfreeze.ts): audit event before the change, the skipped sessions replayed for that
 * cohort only, then ONE `cohort_event` row. Nothing is edited or deleted.
 */
export async function clearCohortInvariantsAction(fd: FormData): Promise<ControlResult> {
  const user = await requireUser("admin", PATH);
  let result;
  try {
    result = await clearCohortInvariants(
      {
        mainDb: mainDb(),
        authDb: authDb(),
        env: process.env,
        meta: requestMeta(await headers()),
      },
      user,
      {
        cohortId: field(fd, "cohortId"),
        cause: field(fd, "cause"),
        confirm: field(fd, "confirm") === "true",
      },
    );
  } catch {
    return { error: "unavailable" };
  }
  if (result.status !== 200) {
    const code = result.body.error;
    return { error: typeof code === "string" ? code : "unavailable" };
  }
  revalidatePath(PATH);
  revalidatePath("/strategies");
  revalidatePath("/");
  return { ok: true };
}
