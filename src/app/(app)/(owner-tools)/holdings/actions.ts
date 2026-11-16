"use server";
// The holdings form (M21 B1, UXN-316, D-1220, F). requireOwnerTools first (D-1247). A save, typed or from a CSV file, is
// one NEW `owner_holding` upload for the Owner's market; nothing is updated or deleted and nothing else is written.
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requireOwnerTools } from "@/lib/auth/ownerToolsGuard";
import { mainDb } from "@/lib/db/client";
import {
  HOLDINGS_ERROR_TEXT,
  HOLDINGS_MAX_CHARS,
  parseHoldingsCsv,
  parseManualRows,
  saveHoldings,
  type HoldingsParse,
} from "@/lib/ownerTools/holdings";
import type { OwnerActionResult } from "@/lib/ownerTools/result";
import { envFor } from "@/lib/ui/loaders/shell";

const PATH = "/holdings";
const SUFFIX_LEN = 8; // threshold-ok: length of the random part of an upload id

const strings = (fd: FormData, name: string): string[] =>
  fd.getAll(name).map((v) => (typeof v === "string" ? v : ""));

async function csvText(fd: FormData): Promise<string | null> {
  const file = fd.get("csv_file");
  if (typeof File !== "undefined" && file instanceof File && file.size > 0) {
    if (file.size > HOLDINGS_MAX_CHARS * 4) return null; // far over the limit: never read it
    return await file.text();
  }
  const pasted = fd.get("csv_text");
  return typeof pasted === "string" ? pasted : "";
}

/** Save the typed table (mode "manual") or import the CSV (mode "csv") as a new upload. */
export async function saveHoldingsAction(fd: FormData): Promise<OwnerActionResult> {
  const user = await requireOwnerTools(PATH);
  let parsed: HoldingsParse;
  if (fd.get("mode") === "csv") {
    const text = await csvText(fd);
    parsed = text === null ? { ok: false, error: "too_large" } : parseHoldingsCsv(text);
  } else {
    const codes = strings(fd, "code");
    const qtys = strings(fd, "qty");
    const costs = strings(fd, "cost");
    parsed = parseManualRows(
      codes.map((code, i) => ({ code, qty: qtys[i] ?? "", cost: costs[i] ?? "" })),
    );
  }
  if (!parsed.ok) {
    const where = parsed.line === undefined ? "" : ` (row ${parsed.line})`;
    return { error: parsed.error, message: `${HOLDINGS_ERROR_TEXT[parsed.error]}${where}` };
  }
  try {
    const env = await envFor(user);
    const r = await saveHoldings(
      mainDb(),
      env.market,
      parsed.rows,
      new Date(),
      randomUUID().replace(/-/g, "").slice(0, SUFFIX_LEN),
    );
    if (!r.ok) return { error: r.error, message: HOLDINGS_ERROR_TEXT.unavailable };
  } catch {
    return { error: "unavailable", message: HOLDINGS_ERROR_TEXT.unavailable };
  }
  revalidatePath(PATH);
  return { ok: true };
}
