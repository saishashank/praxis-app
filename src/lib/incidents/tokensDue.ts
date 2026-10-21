// Tokens due (M5 T11, design 4.8, NFR-006, SEC-021; credential dates from D-097): once a day at
// the evening heartbeat, credentials whose `expires_on` is exactly `token_warning_days` (14, 7, 2)
// ahead are listed in ONE combined `tokens:<d>` email (names and dates, never values). Nothing due
// = no email. `d` is the Melbourne date, so a repeat the same day is a no-op.
import type { Client } from "@libsql/client";
import { getConfig } from "@/lib/config/store";
import { emailKeys, melbourneDate } from "@/lib/email/keys";
import { LiveSendBlockedError } from "@/lib/email/provider";
import { sendEmail, type SendStatus } from "@/lib/email/send";
import { CREDENTIAL_NAMES } from "@/lib/sentinel/schema";
import type { NotifyCtx } from "./notify";

export const DEFAULT_WARNING_DAYS = [14, 7, 2]; // threshold-ok: registry default token_warning_days

const dayNumber = (d: string): number => Date.parse(`${d}T00:00:00Z`) / 86_400_000;

export interface DueToken {
  name: string;
  expiresOn: string;
  daysLeft: number;
  where: string;
}

export async function dueTokens(db: Pick<Client, "execute">, today: string): Promise<DueToken[]> {
  const cfg = await getConfig(db as Client, "token_warning_days");
  const windows =
    Array.isArray(cfg) && cfg.length > 0 && cfg.every((x) => Number.isInteger(x))
      ? (cfg as number[])
      : DEFAULT_WARNING_DAYS;
  const r = await db.execute({ sql: "SELECT name, expires_on FROM credential_expiry", args: [] });
  const out: DueToken[] = [];
  for (const row of r.rows) {
    const expiresOn = String(row.expires_on);
    const daysLeft = dayNumber(expiresOn) - dayNumber(today);
    if (!windows.includes(daysLeft)) continue;
    const name = String(row.name);
    out.push({
      name: (CREDENTIAL_NAMES as Record<string, string>)[name] ?? name,
      expiresOn,
      daysLeft,
      where: "Renew where it was issued, then enter the new date in System Health",
    });
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft || a.name.localeCompare(b.name));
}

export async function sendTokensDue(ctx: NotifyCtx): Promise<SendStatus | null> {
  if (!ctx.env) return null;
  const now = (ctx.now ?? (() => new Date()))();
  const today = melbourneDate(now);
  const tokens = await dueTokens(ctx.db, today);
  if (tokens.length === 0) return null;
  try {
    const out = await sendEmail(
      { db: ctx.db, env: ctx.env, now: ctx.now, provider: ctx.provider, sleep: ctx.sleep },
      "tokens",
      emailKeys.tokens(today),
      { date: today, tokens },
    );
    return out.status;
  } catch (e) {
    if (e instanceof LiveSendBlockedError) throw e;
    return "failed";
  }
}
