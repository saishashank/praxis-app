"use server";
// The two forms of /recommendations (M21 B1, UXN-315, UXN-317, D-1217, D-1218, F). Each action calls requireOwnerTools
// FIRST (Next dispatches a server action by its id from any page URL, so the page guard is not enough, D-1247). The target
// is the signed-in pinned Owner; nothing but the two Owner-tool preferences is written, through the audited preferences
// service (the audit detail names the field, never the amount or the address).
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requestMeta } from "@/lib/auth/audit";
import { requireOwnerTools } from "@/lib/auth/ownerToolsGuard";
import { authDb } from "@/lib/db/client";
import { parseBrokerForm } from "@/lib/ownerTools/brokerLinks";
import { parseCapital } from "@/lib/ownerTools/capital";
import type { OwnerActionResult } from "@/lib/ownerTools/result";
import { updatePreferences } from "@/lib/preferences/service";

const PATH = "/recommendations";
const UNAVAILABLE = "The change could not be saved. Try again later.";

async function save(userId: number, patch: Record<string, unknown>): Promise<OwnerActionResult> {
  try {
    // The guard above passed: the user is the pinned Owner with the tools on, so the service may write the Owner fields.
    const r = await updatePreferences(
      authDb(),
      process.env,
      requestMeta(await headers()),
      { id: userId, pinnedOwner: true },
      patch,
    );
    if (!r.ok) return { error: r.error, message: UNAVAILABLE };
  } catch {
    return { error: "unavailable", message: UNAVAILABLE };
  }
  revalidatePath(PATH);
  revalidatePath("/picks");
  return { ok: true };
}

/** The amount sized against: a whole number, 0 to 10,000,000 (0 clears it). */
export async function saveCapitalAction(fd: FormData): Promise<OwnerActionResult> {
  const user = await requireOwnerTools(PATH);
  const n = parseCapital(fd.get("real_capital"));
  if (n === null) {
    return { error: "invalid", message: "Enter a whole number from 0 to 10,000,000." };
  }
  return save(user.id, { real_capital: n });
}

/** Up to five broker address templates: a name and an https address with {code}. */
export async function saveBrokerLinksAction(fd: FormData): Promise<OwnerActionResult> {
  const user = await requireOwnerTools(PATH);
  const rawNames = fd.getAll("broker_name");
  const rawUrls = fd.getAll("broker_template");
  const names = rawNames.filter((v): v is string => typeof v === "string");
  const urls = rawUrls.filter((v): v is string => typeof v === "string");
  if (names.length !== rawNames.length || urls.length !== rawUrls.length) {
    return { error: "invalid", message: "Enter the names and addresses as text." }; // a file is not text
  }
  // The form always posts its five rows; a post with none of them is not this form, so it cannot clear the list.
  if (names.length === 0 && urls.length === 0) {
    return { error: "invalid", message: "The form was not sent. Try again." };
  }
  const form = parseBrokerForm(names, urls);
  if (!form.ok) {
    return { error: "invalid", message: `Row ${form.line}: ${form.reason}.` };
  }
  return save(user.id, { broker_links: form.links });
}
