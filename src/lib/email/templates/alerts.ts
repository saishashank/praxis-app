// P0 alert and P0 batch emails (M5 T4; AGT-115, EML-020, EML-022; design 4.3).
// Template text only: no LLM wording, no money beyond weight % (design 4.3). Each email states what
// happened, why it matters, the source link and the time in Australia/Melbourne (EML-022).

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
import { pct, plural, truncate } from "./format";
import { displayTitle } from "@/lib/view/displayText";

export interface P0AlertFacts {
  alertKey: string;
  code: string;
  title: string;
  /** Announcement type, e.g. "Trading halt". */
  type: string;
  /** Why it matters: tier rule in words (AGT-115). */
  why: string;
  executions: { id: string; label: string; weightPct: number }[];
  sourceUrl: string;
  /** Pre-formatted Australia/Melbourne time, e.g. "Mon 19 Oct 2026 10:42 AEDT". */
  time: string;
}

export interface P0Input {
  env: EnvName;
  appUrl: string;
  alert: P0AlertFacts;
}

export interface P0BatchInput {
  env: EnvName;
  appUrl: string;
  /** Window description, e.g. "10:42-10:47 AEDT". */
  window: string;
  alerts: P0AlertFacts[];
}

function alertBlocks(a: P0AlertFacts, appUrl: string, heading?: string): Block[] {
  const blocks: Block[] = [];
  if (heading) blocks.push({ t: "h", text: heading });
  blocks.push({
    t: "kv",
    rows: [
      ["What happened", `${a.type}: ${displayTitle(a.title)} (${a.code})`],
      ["Why it matters", a.why],
      [
        "Held in",
        a.executions.length
          ? a.executions.map((e) => `${e.id} ${e.label} (${pct(e.weightPct)} of NAV)`).join("; ")
          : "no execution",
      ],
      ["Time", a.time],
      ["Source", { text: a.sourceUrl, href: a.sourceUrl }],
    ],
  });
  blocks.push({
    t: "link",
    label: "Open the alert in Praxis",
    href: joinUrl(appUrl, `/alerts/${encodeURIComponent(a.alertKey)}`),
  });
  return blocks;
}

export function renderP0(input: P0Input): SizedEmailOut {
  const a = input.alert;
  const subject = withEnvPrefix(
    input.env,
    `Praxis P0: ${a.code} — ${truncate(displayTitle(a.title), 80)}`,
  );
  const doc = {
    title: subject,
    preheader: `${a.type} on ${a.code}. ${a.time}`,
    blocks: [
      { t: "h" as const, text: "Critical alert (P0)", level: 1 as const },
      ...alertBlocks(a, input.appUrl),
    ],
    footer: standardFooter(
      input.appUrl,
      input.env,
      "Template text only; no AI wording in alert emails.",
    ),
  };
  return fitLadder(() => renderEmail(subject, doc), 0, SMALL_MAX_BYTES);
}

const BATCH_LIST_LIMIT = [Infinity, 15, 5];

export function renderP0Batch(input: P0BatchInput): SizedEmailOut {
  const first = input.alerts[0];
  const n = input.alerts.length;
  const subject = withEnvPrefix(
    input.env,
    `Praxis P0: ${n} ${plural(n, "alert")}${first ? ` — ${first.code}${n > 1 ? " and others" : ""}` : ""}`,
  );
  const render = (level: number) => {
    const limit = BATCH_LIST_LIMIT[level] ?? 5;
    const shown = input.alerts.slice(0, limit);
    const blocks: Block[] = [
      { t: "h", text: "Critical alerts (P0), batched", level: 1 },
      { t: "p", text: `${n} P0 ${plural(n, "alert")} in the window ${input.window}.` },
    ];
    shown.forEach((a, i) => blocks.push(...alertBlocks(a, input.appUrl, `${i + 1}. ${a.code}`)));
    if (n > shown.length) {
      blocks.push({
        t: "p",
        text: `${n - shown.length} more ${plural(n - shown.length, "alert")} in the app.`,
        tone: "warn",
      });
      blocks.push({ t: "link", label: "All alerts", href: joinUrl(input.appUrl, "/alerts") });
    }
    return renderEmail(subject, {
      title: subject,
      preheader: `${n} P0 ${plural(n, "alert")}, ${input.window}`,
      blocks,
      footer: standardFooter(
        input.appUrl,
        input.env,
        "Template text only; no AI wording in alert emails.",
      ),
    });
  };
  return fitLadder(render, 2, SMALL_MAX_BYTES);
}
