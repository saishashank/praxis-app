"use server";
// Users & roles server actions (UX-111, ROL-101..107). Owner only: every action starts with
// requireUser("admin") (a refusal is a 403 and is audit-logged by the guard, AT-02). Origin /
// rate limits (SEC-011/014) are applied by the proxy gate. Inputs are validated again in the
// service (SEC-013). Results are codes only; no internals leave the server.
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requireUser } from "@/lib/auth/guard";
import { requestMeta } from "@/lib/auth/audit";
import type { CurrentUser } from "@/lib/auth/session";
import { getConfig } from "@/lib/config/store";
import { authDb, mainDb } from "@/lib/db/client";
import { ACK_TEXT_VERSION } from "@/lib/users/ack";
import type { ActionResult } from "@/lib/users/messages";
import {
  addUser,
  changeRole,
  DEFAULT_MARKET,
  grantUnmask,
  recordSharingAck,
  revokeUnmask,
  revokeUser,
  signOutEverywhere,
  type Ctx,
  type Done,
} from "@/lib/users/service";

const PATH = "/users";

function text(fd: FormData, name: string): string | undefined {
  const v = fd.get(name);
  return typeof v === "string" ? v : undefined;
}

function id(fd: FormData, name: string): number {
  const v = text(fd, name);
  return v !== undefined && /^[1-9][0-9]{0,15}$/.test(v) ? Number(v) : 0; // 0 is rejected as invalid
}

async function run(user: CurrentUser, fn: (c: Ctx) => Promise<Done>): Promise<ActionResult> {
  try {
    const result = await fn({
      db: authDb(),
      env: process.env,
      actorId: user.id,
      meta: requestMeta(await headers()),
    });
    if (!result.ok) return { error: result.error };
  } catch {
    return { error: "unavailable" };
  }
  revalidatePath(PATH);
  return { ok: true };
}

export async function recordSharingAckAction(fd: FormData): Promise<ActionResult> {
  const user = await requireUser("admin", PATH);
  if (text(fd, "acknowledge") !== "on") return { error: "invalid" };
  return run(user, (c) => recordSharingAck(c, DEFAULT_MARKET, ACK_TEXT_VERSION));
}

export async function addUserAction(fd: FormData): Promise<ActionResult> {
  const user = await requireUser("admin", PATH);
  return run(user, (c) => addUser(c, text(fd, "email"), text(fd, "role")));
}

export async function changeRoleAction(fd: FormData): Promise<ActionResult> {
  const user = await requireUser("admin", PATH);
  return run(user, (c) => changeRole(c, id(fd, "userId"), text(fd, "role")));
}

export async function revokeUserAction(fd: FormData): Promise<ActionResult> {
  const user = await requireUser("admin", PATH);
  return run(user, (c) => revokeUser(c, id(fd, "userId")));
}

export async function signOutEverywhereAction(fd: FormData): Promise<ActionResult> {
  const user = await requireUser("admin", PATH);
  return run(user, (c) => signOutEverywhere(c, id(fd, "userId")));
}

// Unmask grants (UX-009, ROL-107). The length is the form's `days` (whole days, validated again in
// the service) or, when the field is empty, the `unmask_expiry` configuration key (30 days).
async function grantDays(fd: FormData): Promise<number> {
  const v = text(fd, "days");
  if (v !== undefined && v.trim() !== "")
    return /^[0-9]{1,3}$/.test(v.trim()) ? Number(v.trim()) : 0;
  return Number(await getConfig(mainDb(), "unmask_expiry"));
}

export async function grantUnmaskAction(fd: FormData): Promise<ActionResult> {
  const user = await requireUser("admin", PATH);
  return run(user, async (c) => grantUnmask(c, id(fd, "userId"), await grantDays(fd)));
}

export async function revokeUnmaskAction(fd: FormData): Promise<ActionResult> {
  const user = await requireUser("admin", PATH);
  return run(user, (c) => revokeUnmask(c, id(fd, "grantId")));
}
