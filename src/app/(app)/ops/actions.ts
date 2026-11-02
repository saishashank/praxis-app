"use server";
// Tick an Ops checklist task as done (UX-118, OPS-020; M7 T19b; docs/M7_design.md decision 55; D-148
// draft). Owner only. Order of work: the role guard FIRST (a refusal is a 403 and is audit-logged by
// the guard), then validation and the audit-first writer in src/lib/ops/service.ts, which appends one
// row to the append-only `ops_task_done`. Origin and rate limits are applied by the proxy gate
// (SEC-011/014). The result is a code only; the page turns it into text.
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requestMeta } from "@/lib/auth/audit";
import { requireUser } from "@/lib/auth/guard";
import { authDb, mainDb } from "@/lib/db/client";
import { requestRunNow } from "@/lib/jobs/runNow";
import { tickOpsTask } from "@/lib/ops/service";
import type { RunNowResult, TickResult } from "./messages";

const PATH = "/ops";

const field = (fd: FormData, name: string): string | undefined => {
  const v = fd.get(name);
  return typeof v === "string" ? v : undefined;
};

export async function tickOpsTaskAction(fd: FormData): Promise<TickResult> {
  const user = await requireUser("admin", PATH);
  let result;
  try {
    result = await tickOpsTask(
      { mainDb: mainDb(), authDb: authDb(), env: process.env, meta: requestMeta(await headers()) },
      user,
      { taskId: field(fd, "task"), dueD: field(fd, "due") },
    );
  } catch {
    return { error: "unavailable" };
  }
  if (result.status !== 200) {
    const code = result.body.error;
    return { error: typeof code === "string" ? code : "unavailable" };
  }
  revalidatePath(PATH);
  return { ok: true };
}

/**
 * Ask for a scheduled job to run now (D-840..D-849). Same order of work as above: the role guard FIRST
 * (a refusal is a 403 and is audit-logged by the guard), then the shared Owner writer
 * (src/lib/jobs/runNow.ts: Owner check, registry and parameter checks, confirm, audit event first, ONE
 * request row). It only writes a request; the Worker decides whether it runs and records why not.
 */
export async function requestRunNowAction(fd: FormData): Promise<RunNowResult> {
  const user = await requireUser("admin", PATH);
  const d = field(fd, "d");
  let result;
  try {
    result = await requestRunNow({
      mainDb: mainDb(),
      authDb: authDb(),
      env: process.env,
      meta: requestMeta(await headers()),
      actorId: user.id,
      jobId: field(fd, "job"),
      params: d === undefined || d === "" ? {} : { d },
      confirmed: field(fd, "confirm") === "true",
    });
  } catch {
    return { error: "unavailable" };
  }
  if (!result.ok) return { error: result.error };
  revalidatePath(PATH);
  return { ok: true };
}
