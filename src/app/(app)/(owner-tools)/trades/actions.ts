"use server";
// The trade-log forms (M21 B2, ARN-121, D-1221, D-1275, F). requireOwnerTools first. A typed trade or a CSV import is
// appended as new `owner_trade` rows; "Remove" appends an `owner_trade_void` row with a reason. Nothing is updated or
// deleted, nothing is sent to a broker, and every write is audited with counts only (no code, quantity or price).
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { audit, requestMeta } from "@/lib/auth/audit";
import { requireOwnerTools } from "@/lib/auth/ownerToolsGuard";
import { marketDate } from "@/lib/data/calendar";
import { authDb, mainDb } from "@/lib/db/client";
import { enabledMarkets, loadProfile } from "@/lib/market/profile";
import type { OwnerActionResult } from "@/lib/ownerTools/result";
import {
  parseReason,
  parseTradesCsv,
  parseTypedTrade,
  TRADES_ERROR_TEXT,
  TRADES_MAX_CHARS,
  type RowContext,
  type TradesParse,
} from "@/lib/ownerTools/tradeLog/parse";
import { appendTrades, newUploadId, voidTrade } from "@/lib/ownerTools/tradeLog/store";
import { envFor } from "@/lib/ui/loaders/shell";

const PATH = "/trades";
const SUFFIX_LEN = 8; // threshold-ok: length of the random part of an upload id

const text = (fd: FormData, name: string): string => {
  const v = fd.get(name);
  return typeof v === "string" ? v : "";
};

async function csvText(fd: FormData): Promise<string | null> {
  const file = fd.get("csv_file");
  if (typeof File !== "undefined" && file instanceof File && file.size > 0) {
    if (file.size > TRADES_MAX_CHARS * 4) return null; // far over the limit: never read it
    return await file.text();
  }
  return text(fd, "csv_text");
}

/** Add one typed trade (mode "typed") or import a CSV (mode "csv"). */
export async function addTradesAction(fd: FormData): Promise<OwnerActionResult> {
  const user = await requireOwnerTools(PATH);
  try {
    const env = await envFor(user);
    const now = new Date();
    const tz = (await loadProfile(mainDb(), env.market)).tz;
    const ctx: RowContext = {
      markets: await enabledMarkets(mainDb()),
      today: marketDate(now, tz ?? "UTC"),
    };
    const csv = fd.get("mode") === "csv";
    let parsed: TradesParse;
    if (csv) {
      const body = await csvText(fd);
      parsed = body === null ? { ok: false, error: "too_large" } : parseTradesCsv(body, ctx);
    } else {
      parsed = parseTypedTrade(
        {
          market: text(fd, "market") || env.market,
          code: text(fd, "code"),
          side: text(fd, "side"),
          date: text(fd, "date"),
          qty: text(fd, "qty"),
          price: text(fd, "price"),
          fees: text(fd, "fees"),
          note: text(fd, "note"),
        },
        ctx,
      );
    }
    if (!parsed.ok) {
      const where = parsed.line === undefined ? "" : ` (row ${parsed.line})`;
      return { error: parsed.error, message: `${TRADES_ERROR_TEXT[parsed.error]}${where}` };
    }
    const uploadId = csv
      ? newUploadId(now, randomUUID().replace(/-/g, "").slice(0, SUFFIX_LEN))
      : null;
    const r = await appendTrades(
      mainDb(),
      parsed.rows,
      csv ? "csv" : "typed",
      `user:${user.id}`,
      now,
      uploadId,
    );
    if (!r.ok) return { error: r.error, message: TRADES_ERROR_TEXT.unavailable };
    // The event names the number of rows and the way they came in: no code, quantity, price or note.
    await audit(authDb(), process.env, requestMeta(await headers()), {
      at: now.toISOString(),
      actorUserId: user.id,
      action: "owner.trades_add",
      targetType: "trade_log",
      targetId: uploadId ?? "typed",
      detail: { rows: parsed.rows.length, source: csv ? "csv" : "typed" },
    });
  } catch {
    return { error: "unavailable", message: TRADES_ERROR_TEXT.unavailable };
  }
  revalidatePath(PATH);
  return { ok: true };
}

/** Remove (void) one trade with a reason. The row stays in the log, marked removed. */
export async function voidTradeAction(fd: FormData): Promise<OwnerActionResult> {
  const user = await requireOwnerTools(PATH);
  const idText = text(fd, "trade_id");
  const id = /^[0-9]{1,12}$/.test(idText) ? Number(idText) : 0; // money-float-ok: a row id
  const reason = parseReason(fd.get("reason"));
  if (id <= 0 || reason === null) {
    return {
      error: "bad_row",
      message: "Say why you are removing it, in up to 200 characters.",
    };
  }
  try {
    const now = new Date();
    const r = await voidTrade(mainDb(), id, reason, now);
    if (!r.ok) {
      return {
        error: r.error,
        message:
          r.error === "already"
            ? "That trade is already removed."
            : r.error === "not_found"
              ? "That trade was not found."
              : TRADES_ERROR_TEXT.unavailable,
      };
    }
    await audit(authDb(), process.env, requestMeta(await headers()), {
      at: now.toISOString(),
      actorUserId: user.id,
      action: "owner.trade_void",
      targetType: "trade_log",
      targetId: String(id),
      detail: {},
    });
  } catch {
    return { error: "unavailable", message: TRADES_ERROR_TEXT.unavailable };
  }
  revalidatePath(PATH);
  return { ok: true };
}
