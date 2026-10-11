"use server";
// System Health server actions: the Owner's one-click confirmation of a trading calendar year
// (DAT-160, D-057 #11) and the Data controls (M2 T10). Owner only: requireUser("admin") runs first (a refusal is a 403 and is
// audit-logged by the guard, AT-02). The market and year come from the form but are validated by
// the service; the actor is always the signed-in Owner.
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requestMeta } from "@/lib/auth/audit";
import { requireUser } from "@/lib/auth/guard";
import { resetAsxTrip } from "@/lib/data/asxToken";
import { confirmCalendar } from "@/lib/data/calendarAdmin";
import {
  setAsxEnabled,
  setDispatchEnabled,
  setMarketMode,
  setSourceAccepted,
  type ControlResult,
} from "@/lib/data/controls";
import { authDb, mainDb } from "@/lib/db/client";

const PATH = "/health";

export type ConfirmCalendarResult = { ok: true; rows: number } | { error: string };

export async function confirmCalendarAction(fd: FormData): Promise<ConfirmCalendarResult> {
  const user = await requireUser("admin", PATH);
  const market = fd.get("market");
  const yearText = fd.get("year");
  try {
    const result = await confirmCalendar({
      mainDb: mainDb(),
      authDb: authDb(),
      env: process.env,
      meta: requestMeta(await headers()),
      actorId: user.id,
      market: typeof market === "string" ? market : undefined,
      year: typeof yearText === "string" && /^\d{4}$/.test(yearText) ? Number(yearText) : undefined,
    });
    if (!result.ok) return { error: result.error };
    revalidatePath(PATH);
    return { ok: true, rows: result.rows };
  } catch {
    return { error: "unavailable" };
  }
}

// ---- Data controls (M2 T10): Owner only, audit-first (src/lib/data/controls.ts) ----------------

export type ControlActionResult = { ok: true; changed: boolean } | { error: string };

const flag = (v: FormDataEntryValue | null): boolean | undefined =>
  v === "1" ? true : v === "0" ? false : undefined;

async function control(
  run: (base: {
    mainDb: ReturnType<typeof mainDb>;
    authDb: ReturnType<typeof authDb>;
    env: NodeJS.ProcessEnv;
    meta: ReturnType<typeof requestMeta>;
    actorId: number;
  }) => Promise<ControlResult>,
): Promise<ControlActionResult> {
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

export async function setDispatchEnabledAction(fd: FormData): Promise<ControlActionResult> {
  return control((b) => setDispatchEnabled({ ...b, enabled: flag(fd.get("enabled")) }));
}

export async function setAsxEnabledAction(fd: FormData): Promise<ControlActionResult> {
  return control((b) => setAsxEnabled({ ...b, enabled: flag(fd.get("enabled")) }));
}

export async function setSourceAcceptedAction(fd: FormData): Promise<ControlActionResult> {
  const source = fd.get("source");
  return control((b) =>
    setSourceAccepted({
      ...b,
      source: typeof source === "string" ? source : undefined,
      accept: flag(fd.get("accept")),
      acknowledged: fd.get("acknowledged") === "on",
    }),
  );
}

export async function setMarketModeAction(fd: FormData): Promise<ControlActionResult> {
  const market = fd.get("market");
  const mode = fd.get("mode");
  return control((b) =>
    setMarketMode({
      ...b,
      market: typeof market === "string" ? market : undefined,
      mode: typeof mode === "string" ? mode : undefined,
    }),
  );
}

export async function resetAsxTripAction(): Promise<ControlActionResult> {
  const user = await requireUser("admin", PATH);
  try {
    const result = await resetAsxTrip({
      mainDb: mainDb(),
      authDb: authDb(),
      env: process.env,
      meta: requestMeta(await headers()),
      actorId: user.id,
    });
    if (!result.ok) return { error: result.error };
    revalidatePath(PATH);
    return { ok: true, changed: result.reset };
  } catch {
    return { error: "unavailable" };
  }
}
