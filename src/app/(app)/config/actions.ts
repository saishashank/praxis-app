"use server";
// Configuration server action (UX-116, PLT-041). Owner only: requireUser("admin") runs first (a
// refusal is a 403 and is audit-logged by the guard, AT-02). Origin / rate limits (SEC-011/014)
// are applied by the proxy gate. The service validates the input again (SEC-013). The result is a
// code plus safe text only; no internals leave the server.
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requireUser } from "@/lib/auth/guard";
import { updateConfig } from "@/lib/config/admin";
import { audit, requestMeta } from "@/lib/auth/audit";
import { authDb, mainDb } from "@/lib/db/client";
import { sydneyDate } from "@/lib/data/pipeline/rules.mjs";
import { importIndexChanges, importIndustryMap } from "@/lib/data/referenceData";
import { importUniverse } from "@/lib/data/universe/import";
import { errorText } from "@/lib/users/messages";

const PATH = "/config";

export type ConfigActionResult = { ok: true } | { error: string; message?: string };

function text(fd: FormData, name: string): string | undefined {
  const v = fd.get(name);
  return typeof v === "string" ? v : undefined;
}

export async function updateConfigAction(fd: FormData): Promise<ConfigActionResult> {
  const user = await requireUser("admin", PATH);
  try {
    const result = await updateConfig({
      mainDb: mainDb(),
      authDb: authDb(),
      env: process.env,
      meta: requestMeta(await headers()),
      actorId: user.id,
      key: text(fd, "key"),
      scope: "global", // per-market scopes arrive with the markets (ROL-107); never taken from the client
      rawValue: text(fd, "value"),
      reason: text(fd, "reason"),
    });
    if (!result.ok) {
      return result.message === undefined
        ? { error: result.error }
        : { error: result.error, message: result.message };
    }
  } catch {
    return { error: "unavailable" };
  }
  revalidatePath(PATH);
  return { ok: true };
}

// ---- Data files (DAT-234, DAT-236, FAM-006): the Owner's CSV uploads --------------------------
// These are data uploads, not configuration edits, so the page stays read-only for settings (D-174).
// Order: role check (requireUser), the confirmation box, size and type of the file, THEN the audit
// event (auth DB), and only then the write (main DB). A refused file changes nothing. The audit row
// holds counts only, never file text. The universe file goes through the existing importer with
// source `manual`: the same parser and the same shrink guard as the Worker import.

export type UploadResult = { ok: true; message: string } | { error: string; message?: string };

const MAX_UPLOAD_BYTES = 1_000_000;
const CONFIRM_FIELD = "confirm";
const CONFIRM_VALUE = "upload_reference_file";
const UPLOAD_KINDS = ["index_changes", "industry_map", "universe"] as const;
type UploadKind = (typeof UPLOAD_KINDS)[number];

const REFUSED_TEXT: Record<string, string> = {
  empty: "The file is empty.",
  too_large: "The file is too large.",
  unrecognised_format: "The file does not have the expected columns. Check the header row.",
  bad_row: "A row is not valid.",
  suspicious_shrink: "The file lists far fewer companies than we hold, so it was refused.",
};

async function readUpload(fd: FormData): Promise<string | UploadResult> {
  if (fd.get(CONFIRM_FIELD) !== CONFIRM_VALUE) return { error: "confirm_required" };
  const file = fd.get("file");
  if (typeof file === "string" || file === null) return { error: "invalid" };
  if (file.size === 0) return { error: "invalid", message: REFUSED_TEXT.empty };
  if (file.size > MAX_UPLOAD_BYTES) return { error: "invalid", message: REFUSED_TEXT.too_large };
  return await file.text();
}

async function upload(kind: UploadKind, fd: FormData): Promise<UploadResult> {
  const user = await requireUser("admin", PATH);
  try {
    const csv = await readUpload(fd);
    if (typeof csv !== "string") return csv;
    const now = new Date();
    const db = mainDb();
    const base = {
      at: now.toISOString(),
      actorUserId: user.id,
      targetType: "reference_file",
      targetId: kind,
    };
    const meta = requestMeta(await headers());
    // Audit first: if this fails nothing has changed. A refused or failed file leaves a note, not data.
    await audit(authDb(), process.env, meta, {
      ...base,
      action: "reference_file.upload",
      detail: { kind, bytes: csv.length },
    });

    if (kind === "universe") {
      const r = await importUniverse({
        db,
        csv,
        today: sydneyDate(now.getTime()),
        now: () => new Date().toISOString(),
        source: "manual",
        env: process.env,
      });
      if (!r.ok) {
        return { error: "invalid", message: REFUSED_TEXT[r.error] ?? errorText("unavailable") };
      }
      revalidatePath(PATH);
      return {
        ok: true,
        message:
          r.status === "already_applied"
            ? "A listed-companies file has already been applied today. Nothing changed."
            : `Applied: ${r.counts.file} companies read.`,
      };
    }

    const r =
      kind === "index_changes"
        ? await importIndexChanges(db, csv, base.at)
        : await importIndustryMap(db, csv, base.at);
    if (!r.ok) {
      const why = REFUSED_TEXT[r.error] ?? errorText("unavailable");
      return {
        error: "invalid",
        message: r.line === undefined ? why : `${why} (line ${r.line}). Nothing was loaded.`,
      };
    }
    revalidatePath(PATH);
    return {
      ok: true,
      message: `Loaded ${r.inserted} new row${r.inserted === 1 ? "" : "s"}; ${r.ignored} already present.`,
    };
  } catch {
    return { error: "unavailable" };
  }
}

export async function uploadIndexChangesAction(fd: FormData): Promise<UploadResult> {
  return upload("index_changes", fd);
}
export async function uploadIndustryMapAction(fd: FormData): Promise<UploadResult> {
  return upload("industry_map", fd);
}
export async function uploadUniverseAction(fd: FormData): Promise<UploadResult> {
  return upload("universe", fd);
}
