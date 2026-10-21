// Attention reminder (EML-023) and Morning Brief (EML-016) templates (M5 T4; design 4.7).
// Fixed templates, no LLM text, <= 20 KB (SMALL_MAX_BYTES). Size ladder: drop the "resolved since
// yesterday" list, then cap the item lists with a "+n more" line and a link.

import {
  type Block,
  type EnvName,
  SMALL_MAX_BYTES,
  type SizedEmailOut,
  fitLadder,
  joinUrl,
  renderEmail,
  standardFooter,
  withEnvPrefix,
} from "./core";
import { dateLabel, plural, truncate } from "./format";

export interface ReminderItem {
  name: string;
  status: "attention" | "down";
  daysOpen: number;
  /** Pre-formatted deadline (e.g. credential expiry) or undefined. */
  deadline?: string;
  fix: string;
  /** App path of the Control Room anchor. */
  fixPath: string;
}

export interface ReminderInput {
  env: EnvName;
  appUrl: string;
  /** Local date (Melbourne), YYYY-MM-DD. */
  date: string;
  items: ReminderItem[];
  resolvedSinceYesterday: string[];
}

const LIST_CAP = [Infinity, Infinity, 10];

export function renderReminder(i: ReminderInput): SizedEmailOut {
  const first = i.items[0];
  const n = i.items.length;
  const subject = withEnvPrefix(
    i.env,
    first
      ? `Praxis: ${n} ${plural(n, "item")} ${n === 1 ? "needs" : "need"} attention — ${truncate(first.name, 60)} (day ${first.daysOpen})`
      : "Praxis: nothing needs attention",
  );
  const render = (level: number) => {
    const cap = LIST_CAP[level] ?? 10;
    const shown = i.items.slice(0, cap);
    const blocks: Block[] = [
      { t: "h", text: "Needs attention", level: 1 },
      {
        t: "p",
        text: `${dateLabel(i.date)}: ${n} ${plural(n, "item")} in the Control Room ${n === 1 ? "is" : "are"} amber or red.`,
      },
      {
        t: "table",
        head: ["Item", "State", "Days open", "Deadline", "Fix"],
        rows: shown.map((it) => [
          { text: it.name, href: joinUrl(i.appUrl, it.fixPath) },
          {
            text: it.status === "down" ? "Down" : "Needs attention",
            tone: it.status === "down" ? "neg" : "warn",
            bold: true,
          },
          String(it.daysOpen),
          it.deadline ?? "-",
          truncate(it.fix, 140),
        ]),
        right: [2],
      },
    ];
    if (n > shown.length) {
      blocks.push({
        t: "p",
        text: `${n - shown.length} more ${plural(n - shown.length, "item")} in the Control Room.`,
        tone: "warn",
      });
    }
    if (level === 0 && i.resolvedSinceYesterday.length) {
      blocks.push({ t: "p", text: "Resolved since yesterday", bold: true });
      blocks.push({ t: "ul", items: i.resolvedSinceYesterday });
    }
    blocks.push({
      t: "link",
      label: "Open the Control Room",
      href: joinUrl(i.appUrl, "/system-health"),
    });
    return renderEmail(subject, {
      title: subject,
      preheader: first ? `${first.name}: ${first.fix}` : "Nothing needs attention",
      blocks,
      footer: standardFooter(
        i.appUrl,
        i.env,
        "Sent daily at the reminder time while an item is amber or red; amber items can be snoozed in the Control Room.",
      ),
    });
  };
  return fitLadder(render, 2, SMALL_MAX_BYTES);
}

export interface BriefInput {
  env: EnvName;
  appUrl: string;
  date: string;
  overnight: { code: string; title: string; time: string; url?: string }[];
  events: { label: string; detail: string }[];
  plan: string[];
}

export function renderBrief(i: BriefInput): SizedEmailOut {
  const subject = withEnvPrefix(i.env, `Praxis Morning Brief — ${dateLabel(i.date)}`);
  const render = (level: number) => {
    const cap = level === 0 ? Infinity : level === 1 ? 20 : 8;
    const blocks: Block[] = [
      { t: "h", text: "Morning Brief", level: 1 },
      { t: "p", text: dateLabel(i.date), tone: "muted" },
      { t: "h", text: "Overnight announcements" },
      i.overnight.length
        ? {
            t: "table",
            head: ["Code", "Announcement", "Time"],
            rows: i.overnight
              .slice(0, cap)
              .map((a) => [a.code, { text: truncate(a.title, 110), href: a.url }, a.time]),
          }
        : { t: "p", text: "Nothing overnight on held or watched codes.", tone: "muted" },
      { t: "h", text: "Today's known events" },
      i.events.length
        ? { t: "ul", items: i.events.slice(0, cap).map((e) => `${e.label}: ${e.detail}`) }
        : { t: "p", text: "No known events.", tone: "muted" },
      { t: "h", text: "Tonight's plan" },
      i.plan.length
        ? { t: "ul", items: i.plan.slice(0, cap) }
        : { t: "p", text: "No orders pending.", tone: "muted" },
    ];
    const total = i.overnight.length + i.events.length + i.plan.length;
    if (
      cap !== Infinity &&
      (i.overnight.length > cap || i.events.length > cap || i.plan.length > cap)
    ) {
      blocks.push({
        t: "p",
        text: `Lists shortened (${total} items in total); the rest is in the app.`,
        tone: "warn",
      });
    }
    blocks.push({ t: "link", label: "Open Praxis", href: i.appUrl });
    return renderEmail(subject, {
      title: subject,
      preheader: `Morning Brief for ${dateLabel(i.date)}`,
      blocks,
      footer: standardFooter(
        i.appUrl,
        i.env,
        "Optional brief, template text only; trading days of the active market.",
      ),
    });
  };
  return fitLadder(render, 2, SMALL_MAX_BYTES);
}
