// System notice emails (M5 T4; NFR-006, EML-021, EML-034; design 4.8, 4.10): incident open or
// escalation, combined "tokens due", Evening Review unread for 7 days, and the test email.
// Template text only. Credential values never appear: tokens-due lists names and dates only.

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

// ----------------------------------------------------------------------------------------------
// Incident (open / escalated)
// ----------------------------------------------------------------------------------------------

export interface IncidentInput {
  env: EnvName;
  appUrl: string;
  incidentId: string;
  /** "open" = incident opened; "escalated" = escalated to S1 (NFR-006: one email each). */
  event: "open" | "escalated";
  severity: "S1" | "S2";
  /** Component label, e.g. "Sentinel". */
  component: string;
  summary: string;
  /** Pre-formatted Melbourne time the incident opened. */
  since: string;
  /** What is affected and what happens next, one or two sentences. */
  impact: string;
  fix: string;
  /** App path of the Control Room / System Health anchor. */
  fixPath: string;
}

export function renderIncident(i: IncidentInput): SizedEmailOut {
  const lead = i.event === "escalated" ? "ESCALATED to S1" : i.severity;
  const subject = withEnvPrefix(i.env, `Praxis incident ${lead}: ${truncate(i.summary, 90)}`);
  const blocks: Block[] = [
    {
      t: "h",
      text:
        i.event === "escalated" ? "Incident escalated to S1" : `Incident opened (${i.severity})`,
      level: 1,
    },
    {
      t: "kv",
      rows: [
        ["Component", i.component],
        ["What", i.summary],
        ["Since", i.since],
        ["Impact", i.impact],
        ["What to do", i.fix],
        ["Incident", i.incidentId],
      ],
    },
    { t: "link", label: "Open System Health", href: joinUrl(i.appUrl, i.fixPath) },
  ];
  const doc = {
    title: subject,
    preheader: `${i.component}: ${i.summary}`,
    blocks,
    footer: standardFooter(
      i.appUrl,
      i.env,
      "One email per incident open and one per escalation; later updates appear in the Evening Review section 9.",
    ),
  };
  return fitLadder(() => renderEmail(subject, doc), 0, SMALL_MAX_BYTES);
}

// ----------------------------------------------------------------------------------------------
// Tokens due (combined, 14 / 7 / 2 days)
// ----------------------------------------------------------------------------------------------

export interface TokensDueInput {
  env: EnvName;
  appUrl: string;
  /** Warning date (Melbourne), YYYY-MM-DD. */
  date: string;
  tokens: { name: string; expiresOn: string; daysLeft: number; where: string }[];
}

export function renderTokensDue(i: TokensDueInput): SizedEmailOut {
  const sorted = [...i.tokens].sort(
    (a, b) => a.daysLeft - b.daysLeft || a.name.localeCompare(b.name),
  );
  const first = sorted[0];
  const n = sorted.length;
  const subject = withEnvPrefix(
    i.env,
    first
      ? `Praxis: ${n} ${plural(n, "token")} due — ${truncate(first.name, 50)} (${first.daysLeft} ${plural(first.daysLeft, "day")})`
      : "Praxis: tokens due",
  );
  const blocks: Block[] = [
    { t: "h", text: "Tokens and credentials due", level: 1 },
    {
      t: "p",
      text: `Warning for ${dateLabel(i.date)}. Renew before the date shown; names only, no values.`,
    },
    {
      t: "table",
      head: ["Name", "Expires", "Days left", "Where to renew"],
      rows: sorted.map((t) => [
        t.name,
        t.expiresOn,
        {
          text: String(t.daysLeft),
          tone: t.daysLeft <= 2 ? "neg" : t.daysLeft <= 7 ? "warn" : undefined,
          bold: true,
        },
        t.where,
      ]),
      right: [2],
    },
    { t: "link", label: "Open System Health", href: joinUrl(i.appUrl, "/system-health") },
  ];
  const doc = {
    title: subject,
    preheader: `${n} ${plural(n, "token")} due`,
    blocks,
    footer: standardFooter(
      i.appUrl,
      i.env,
      "One combined email per warning day (14, 7 and 2 days ahead).",
    ),
  };
  return fitLadder(() => renderEmail(subject, doc), 0, SMALL_MAX_BYTES);
}

// ----------------------------------------------------------------------------------------------
// Evening Review unread for 7 days
// ----------------------------------------------------------------------------------------------

export interface UnreadInput {
  env: EnvName;
  appUrl: string;
  date: string;
  days: number;
  /** Most recent review dates not marked read, newest first. */
  unreadDates: string[];
}

export function renderUnread7(i: UnreadInput): SizedEmailOut {
  const subject = withEnvPrefix(i.env, `Praxis: Evening Review unread for ${i.days} days`);
  const blocks: Block[] = [
    { t: "h", text: `No Evening Review marked read for ${i.days} days`, level: 1 },
    {
      t: "p",
      text: "Reviews are still being sent and stored. Open one and press Mark as read to clear this notice.",
    },
    { t: "ul", items: i.unreadDates.slice(0, 10).map((d) => dateLabel(d)) },
    { t: "link", label: "Open the latest review", href: joinUrl(i.appUrl, `/reviews/${i.date}`) },
  ];
  const doc = {
    title: subject,
    preheader: `${i.days} days without a read review`,
    blocks,
    footer: standardFooter(
      i.appUrl,
      i.env,
      "Sent once when the unread run reaches the incident threshold.",
    ),
  };
  return fitLadder(() => renderEmail(subject, doc), 0, SMALL_MAX_BYTES);
}

// ----------------------------------------------------------------------------------------------
// Test email (EML-034)
// ----------------------------------------------------------------------------------------------

export interface TestInput {
  env: EnvName;
  appUrl: string;
  /** Pre-formatted Melbourne time of the request. */
  requestedAt: string;
}

export function renderTest(i: TestInput): SizedEmailOut {
  const subject = withEnvPrefix(i.env, "[TEST] Praxis test email");
  const doc = {
    title: subject,
    preheader: "Test email: delivery works.",
    blocks: [
      { t: "h" as const, text: "Test email", level: 1 as const },
      {
        t: "p" as const,
        text: `This test email was requested at ${i.requestedAt}. If you can read it, delivery works.`,
      },
      { t: "link" as const, label: "Open Praxis", href: i.appUrl },
    ],
    footer: standardFooter(i.appUrl, i.env),
  };
  return fitLadder(() => renderEmail(subject, doc), 0, SMALL_MAX_BYTES);
}
