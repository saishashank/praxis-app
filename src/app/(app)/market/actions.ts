"use server";
// Watchlist star (UXN-047, decision 9 and 56 of docs/M7_design.md; D-128). Owner: the Sentinel
// watch-list `watch_list_owner` through the existing audited Owner writers (they refuse anyone who is
// not the active Owner). Editor: a personal list in the auth database that has no effect on alerts.
// Viewers cannot star (the `watchlist` action is Owner and Editor only).
// Order of work: the role guard FIRST (a refusal is a 403 and is audit-logged by the guard), then input
// validation, the masking check, the `watchlist_max` limit, then the audit event BEFORE the change.
// A request that would change nothing writes nothing. Origin and rate limits are applied by the proxy
// gate (SEC-011/014). The result is a code only; the UI turns it into text.
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { audit, requestMeta, type RequestMeta } from "@/lib/auth/audit";
import { requireUser } from "@/lib/auth/guard";
import { MODE_MARKETS } from "@/lib/config/keys";
import { getConfig } from "@/lib/config/store";
import { marketDate } from "@/lib/data/calendar";
import { addWatchListCode, removeWatchListCode } from "@/lib/data/controls";
import { authDb, mainDb } from "@/lib/db/client";
import { envFor } from "@/lib/ui/loaders/shell";
import type { WatchResult } from "./messages";

const PATH = "/market";
const CODE_RE = /^[A-Z0-9]{2,6}$/;
const DEFAULT_MAX = 50; // threshold-ok: ch.15 default of watchlist_max, used only if the read fails

const field = (fd: FormData, name: string): string | undefined => {
  const v = fd.get(name);
  return typeof v === "string" ? v : undefined;
};

async function limit(): Promise<number> {
  try {
    const v = await getConfig(mainDb(), "watchlist_max");
    return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : DEFAULT_MAX;
  } catch {
    return DEFAULT_MAX;
  }
}

function done(starred: boolean, changed: boolean): WatchResult {
  revalidatePath(PATH);
  revalidatePath("/market/[code]", "page");
  revalidatePath("/");
  return { ok: true, starred, changed };
}

export async function toggleWatchlistAction(fd: FormData): Promise<WatchResult> {
  const user = await requireUser("watchlist", PATH);
  const code = field(fd, "code")?.trim().toUpperCase();
  const market = field(fd, "market") ?? "AU";
  const wanted = field(fd, "state"); // "on" | "off" | absent (flip)
  if (
    code === undefined ||
    !CODE_RE.test(code) ||
    !(MODE_MARKETS as readonly string[]).includes(market) ||
    (wanted !== undefined && wanted !== "on" && wanted !== "off")
  ) {
    return { error: "invalid" };
  }
  try {
    // A masked user never learns or names a code (DAT-124): refuse before touching any data.
    const env = await envFor({ id: user.id, role: user.role });
    if (env.mask.masked) return { error: "masked" };
    const meta = requestMeta(await headers());
    const max = await limit();
    return user.role === "owner"
      ? await ownerToggle(user.id, market, code, wanted, max, meta)
      : await editorToggle(user.id, market, code, wanted, max, meta);
  } catch {
    return { error: "unavailable" };
  }
}

// ---- Owner: the Sentinel watch-list ------------------------------------------------------------------

async function ownerToggle(
  actorId: number,
  market: string,
  code: string,
  wanted: string | undefined,
  max: number,
  meta: RequestMeta,
): Promise<WatchResult> {
  const main = mainDb();
  const today = marketDate(new Date(), "Australia/Sydney");
  const rows = await main.execute({
    sql: `SELECT code FROM watch_list_owner WHERE market = ? AND removed_at IS NULL AND expires_d >= ?`,
    args: [market, today],
  });
  const listed = new Set(rows.rows.map((r) => String(r.code)));
  const on = wanted === undefined ? !listed.has(code) : wanted === "on";
  if (on === listed.has(code)) return done(on, false);
  if (on && listed.size >= max) return { error: "limit" };
  const base = { mainDb: main, authDb: authDb(), env: process.env, meta, actorId, market, code };
  const out = on ? await addWatchListCode(base) : await removeWatchListCode(base);
  if (!out.ok) {
    return { error: mapError(out.error) };
  }
  return done(on, out.changed);
}

function mapError(e: string): "forbidden" | "invalid" | "unknown_code" | "unavailable" {
  return e === "forbidden" || e === "invalid" || e === "unknown_code" ? e : "unavailable";
}

// ---- Editor: the personal list -------------------------------------------------------------------------

async function editorToggle(
  userId: number,
  market: string,
  code: string,
  wanted: string | undefined,
  max: number,
  meta: RequestMeta,
): Promise<WatchResult> {
  const auth = authDb();
  const mine = await auth.execute({
    sql: "SELECT code FROM user_watchlist WHERE user_id = ? AND market = ?",
    args: [userId, market],
  });
  const listed = new Set(mine.rows.map((r) => String(r.code)));
  const on = wanted === undefined ? !listed.has(code) : wanted === "on";
  if (on === listed.has(code)) return done(on, false);
  if (on) {
    if (listed.size >= max) return { error: "limit" };
    const inst = await mainDb().execute({
      sql: "SELECT 1 FROM instrument WHERE market = ? AND code = ? AND delisted_on IS NULL",
      args: [market, code],
    });
    if (inst.rows.length !== 1) return { error: "unknown_code" };
  }
  const action = on ? "watchlist.add" : "watchlist.remove";
  const event = {
    actorUserId: userId,
    targetType: "watchlist",
    targetId: `${market}:${code}`,
    detail: { market, code, personal: true },
  };
  try {
    await audit(auth, process.env, meta, { ...event, action }); // audit first: nothing has changed yet
  } catch {
    return { error: "unavailable" };
  }
  try {
    if (on) {
      await auth.execute({
        sql: `INSERT INTO user_watchlist (user_id, market, code, added_at) VALUES (?, ?, ?, ?)
              ON CONFLICT DO NOTHING`,
        args: [userId, market, code, new Date().toISOString()],
      });
    } else {
      await auth.execute({
        sql: "DELETE FROM user_watchlist WHERE user_id = ? AND market = ? AND code = ?",
        args: [userId, market, code],
      });
    }
  } catch {
    try {
      await audit(auth, process.env, meta, { ...event, action: `${action}_failed` });
    } catch {
      // best effort: the change did not happen either way
    }
    return { error: "unavailable" };
  }
  return done(on, true);
}
