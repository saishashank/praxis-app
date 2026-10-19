"use server";
// System Health server actions for the M5 email and alert controls (docs/M5_design.md 4.12, 4.7, 3):
// the production email switch and its one-off review test date, the Owner watch-list, credential
// expiry dates and the attention snooze. Owner only: requireUser("admin") runs first (a refusal is a
// 403 and is audit-logged by the guard, AT-02). The service re-checks the Owner, writes the audit
// event first and refuses what the rules refuse (src/lib/data/controls.ts). The actor is always the
// signed-in Owner; for the snooze the item's state comes from the server's own health snapshot,
// never from the form.
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requestMeta } from "@/lib/auth/audit";
import { requireUser } from "@/lib/auth/guard";
import {
  addWatchListCode,
  removeWatchListCode,
  setCredentialExpiry,
  setEmailMode,
  setEmailReviewTestDate,
  snoozeAttention,
  type ControlResult,
} from "@/lib/data/controls";
import { authDb, mainDb } from "@/lib/db/client";
import { findAttentionItem } from "@/lib/health/attention";

const PATH = "/health";

export type EmailControlActionResult = { ok: true; changed: boolean } | { error: string };

type Base = {
  mainDb: ReturnType<typeof mainDb>;
  authDb: ReturnType<typeof authDb>;
  env: NodeJS.ProcessEnv;
  meta: ReturnType<typeof requestMeta>;
  actorId: number;
};

async function control(
  run: (base: Base) => Promise<ControlResult>,
): Promise<EmailControlActionResult> {
  const user = await requireUser("admin", PATH);
  try {
    const result = await run({
      mainDb: mainDb(),
      authDb: authDb(),
      env: process.env,
      meta: requestMeta(await headers()),
      actorId: user.id,
    });
    if (!result.ok) return { error: result.error };
    revalidatePath(PATH);
    return { ok: true, changed: result.changed };
  } catch {
    return { error: "unavailable" };
  }
}

const text = (v: FormDataEntryValue | null): string | undefined =>
  typeof v === "string" ? v.trim() : undefined;

/** A whole number typed in a form field; undefined when empty, NaN when not a whole number. */
const whole = (v: FormDataEntryValue | null): number | undefined => {
  const t = text(v);
  if (t === undefined || t === "") return undefined;
  return /^\d{1,6}$/.test(t) ? Number(t) : Number.NaN;
};

export async function setEmailModeAction(fd: FormData): Promise<EmailControlActionResult> {
  return control((b) => setEmailMode({ ...b, mode: text(fd.get("mode")) }));
}

/** An empty date clears the one-off test date. */
export async function setEmailReviewTestDateAction(
  fd: FormData,
): Promise<EmailControlActionResult> {
  const date = text(fd.get("date"));
  return control((b) => setEmailReviewTestDate({ ...b, date: date === "" ? null : date }));
}

export async function addWatchListCodeAction(fd: FormData): Promise<EmailControlActionResult> {
  const code = text(fd.get("code"));
  return control((b) =>
    addWatchListCode({
      ...b,
      market: text(fd.get("market")),
      code: code === undefined ? undefined : code.toUpperCase(),
      days: whole(fd.get("days")),
    }),
  );
}

export async function removeWatchListCodeAction(fd: FormData): Promise<EmailControlActionResult> {
  return control((b) =>
    removeWatchListCode({ ...b, market: text(fd.get("market")), code: text(fd.get("code")) }),
  );
}

export async function setCredentialExpiryAction(fd: FormData): Promise<EmailControlActionResult> {
  return control((b) =>
    setCredentialExpiry({
      ...b,
      name: text(fd.get("name")),
      expiresOn: text(fd.get("expires_on")),
    }),
  );
}

export async function snoozeAttentionAction(fd: FormData): Promise<EmailControlActionResult> {
  const component = text(fd.get("component"));
  const itemKey = text(fd.get("item_key"));
  return control(async (b) =>
    snoozeAttention({
      ...b,
      component,
      itemKey,
      days: whole(fd.get("days")),
      item:
        component !== undefined && itemKey !== undefined
          ? await findAttentionItem(b.mainDb, component, itemKey)
          : null,
    }),
  );
}
