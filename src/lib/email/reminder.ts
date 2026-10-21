// Attention reminder runner (EML-023, M5 T13, design 4.7). At 08:00 daily: compute the nine health
// components, store the day's `health_snapshot` (purpose `reminder`), list the open items (amber
// or red) minus active snoozes and send ONE `reminder:<d>` email through sendEmail, which applies
// the production switch (`email_mode`), the reserved slot and one-email-per-key. No open item = no
// email. The snapshot is written even while email is off: snooze and the review read it.
import type { Client } from "@libsql/client";
import {
  gatherHealthFacts,
  buildSnapshot,
  loadPreviousSnapshot,
  openItems,
  reminderEnabled,
  resolvedSince,
  writeReminderSnapshot,
} from "@/lib/health/snapshot";
import { computeComponents } from "@/lib/health/components";
import { emailKeys, melbourneDate } from "./keys";
import { LiveSendBlockedError, type EmailEnvVars, type EmailProvider } from "./provider";
import { sendEmail, type SendStatus } from "./send";
import { dateLabel } from "./templates/format";

export interface MorningCtx {
  db: Client;
  env: EmailEnvVars;
  now?: () => Date;
  provider?: EmailProvider;
  sleep?: (ms: number) => Promise<void>;
}

export type ReminderResult =
  | { status: "disabled" | "none" }
  | { status: "sent" | "duplicate" | "suppressed" | "failed"; send: SendStatus; items: number };

export async function runReminder(ctx: MorningCtx, dOverride?: string): Promise<ReminderResult> {
  const now = (ctx.now ?? (() => new Date()))();
  const d = dOverride ?? melbourneDate(now);
  const facts = await gatherHealthFacts(ctx.db, now, d, ctx.env);
  const prev = await loadPreviousSnapshot(ctx.db, d);
  const snap = await writeReminderSnapshot(
    ctx.db,
    d,
    buildSnapshot(computeComponents(facts), prev, d),
  );
  if (!(await reminderEnabled(ctx.db))) return { status: "disabled" };
  const items = await openItems(ctx.db, snap, d);
  if (items.length === 0) return { status: "none" };
  let send: SendStatus;
  try {
    const out = await sendEmail(
      { db: ctx.db, env: ctx.env, now: ctx.now, provider: ctx.provider, sleep: ctx.sleep },
      "reminder",
      emailKeys.reminder(d),
      {
        date: d,
        items: items.map((i) => ({
          name: i.label,
          status: i.state,
          daysOpen: i.daysOpen,
          deadline: i.deadline_d ? dateLabel(i.deadline_d) : undefined,
          fix: i.fix,
          fixPath: i.fix_path,
        })),
        resolvedSinceYesterday: resolvedSince(prev, snap),
      },
    );
    send = out.status;
  } catch (e) {
    if (e instanceof LiveSendBlockedError) throw e;
    return { status: "failed", send: "failed", items: items.length };
  }
  const n = items.length;
  if (send === "sent") return { status: "sent", send, items: n };
  if (send === "duplicate") return { status: "duplicate", send, items: n };
  if (send.startsWith("suppressed") || send === "no_recipient") {
    return { status: "suppressed", send, items: n };
  }
  return { status: "failed", send, items: n };
}
