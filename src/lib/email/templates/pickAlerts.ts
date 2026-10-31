// Pick-alert emails (M17 WP4; EML-038/039/040, EML-041 batch and digest, NFR-041, SEC-016).
// Template text only: no LLM wording anywhere, no broker links. Every mail says the prices are
// "delayed" and carries the quote time and the latency line; the words "real-time" never appear.
// All numbers arrive pre-formatted from pickMail.ts (no clock reads, no locale APIs here).

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
import { plural, truncate } from "./format";

/** Delay and refresh minutes shown in the latency line (config `intraday_quote_delay_min`, `intraday_refresh_min`). */
export interface Latency {
  delayMin: number;
  refreshMin: number;
}

export const DEFAULT_LATENCY: Latency = { delayMin: 20, refreshMin: 5 }; // threshold-ok: display fallback of the two config defaults

/** NFR-041: the latency statement used in every pick e-mail footer. */
export function latencyLine(l: Latency = DEFAULT_LATENCY): string {
  return `Prices are delayed: up to about ${l.delayMin} + ${l.refreshMin} minutes after the trade. A delayed price can already be out of date.`;
}

const PLACE_STOP =
  "Place your own stop with your broker; Praxis will not e-mail you when it is hit.";

export interface PickHitFacts {
  alertId: string;
  code: string;
  name: string;
  /** Pre-formatted publish time of the night pick. */
  publishedAt: string;
  limit: string;
  last: string;
  /** Pre-formatted quote time, e.g. "Wed 4 Nov 2026 10:42 AEDT". */
  quoteTime: string;
  stop: string;
  /** Distance from the delayed price down to the stop, in percent of the price. */
  stopDistancePct: string;
  parcel: { amount: string; shares: number } | null;
  timeFrame: string | null;
}

export type ClearVariant = "below_stop" | "above_chase_cap";

export interface PickClearedFacts {
  alertId: string;
  code: string;
  name: string;
  variant: ClearVariant;
  limit: string;
  stop: string;
  /** Delayed price; null when the transition row carries none (then only the quote time is shown). */
  last: string | null;
  quoteTime: string;
  /** Pre-formatted chase cap line, e.g. "3% above the limit" (above_chase_cap only). */
  capText?: string;
}

export interface PickCandidateFacts {
  code: string;
  name: string;
  /** "found 11:42" time, pre-formatted. */
  foundAt: string;
  /** Announcement title or headline, with source and publish time. */
  trigger: { title: string; source: string; publishedAt: string };
  movePct: string;
  /** Relative volume text, or null when unknown (shown as "volume unavailable"). */
  relVolume: string | null;
  quoteTime: string;
  gatesPassed: string[];
  limit: string | null;
  stop: string | null;
  /** While the stream is in shadow mode (always in V2 until validated). */
  unvalidated: boolean;
}

export interface PickInput<F> {
  env: EnvName;
  appUrl: string;
  facts: F;
  latency?: Latency;
}

/** One line of a batch or digest. */
export interface PickLine {
  code: string;
  /** "Buy price hit", "Cleared: fell under the stop", ... */
  what: string;
  price: string;
  quoteTime: string;
}

export interface PickBatchInput {
  env: EnvName;
  appUrl: string;
  /** Window text, e.g. "10:45 AEDT". */
  window: string;
  lines: PickLine[];
  latency?: Latency;
}

export interface PickDigestInput {
  env: EnvName;
  appUrl: string;
  /** Quiet-hours window that just ended, e.g. "22:00-07:00". */
  quietWindow: string;
  lines: PickLine[];
  latency?: Latency;
}

function footerFor(env: EnvName, appUrl: string, latency?: Latency): Block[] {
  return standardFooter(
    appUrl,
    env,
    `Template text only; no AI wording in alert emails. ${latencyLine(latency)}`,
  );
}

export function renderPickHit(input: PickInput<PickHitFacts>): SizedEmailOut {
  const f = input.facts;
  const subject = withEnvPrefix(input.env, `[Praxis] Buy price hit — ${f.code} (delayed)`);
  const rows: [string, string][] = [
    ["Pick", `${f.code} ${truncate(f.name, 80)}`],
    ["Published", f.publishedAt],
    ["Buy limit", f.limit],
    ["Delayed last price", `${f.last} at ${f.quoteTime} (delayed)`],
    ["Stop", `${f.stop} (${f.stopDistancePct} below the delayed price)`],
  ];
  if (f.parcel)
    rows.push(["Suggested parcel", `${f.parcel.amount} (${f.parcel.shares} shares at the limit)`]);
  if (f.timeFrame) rows.push(["Time frame", f.timeFrame]);
  const doc = {
    title: subject,
    preheader: `${f.code} reached its buy limit on a delayed price at ${f.quoteTime}.`,
    blocks: [
      { t: "h" as const, text: "Buy price hit (delayed)", level: 1 as const },
      { t: "kv" as const, rows },
      { t: "p" as const, text: PLACE_STOP, bold: true },
      {
        t: "link" as const,
        label: "Open the alert in Praxis",
        href: joinUrl(input.appUrl, "/alerts"),
      },
    ],
    footer: footerFor(input.env, input.appUrl, input.latency),
  };
  return fitLadder(() => renderEmail(subject, doc), 0, SMALL_MAX_BYTES);
}

export function renderPickCleared(input: PickInput<PickClearedFacts>): SizedEmailOut {
  const f = input.facts;
  const below = f.variant === "below_stop";
  const subject = withEnvPrefix(
    input.env,
    `[Praxis] Pick cleared — ${f.code} ${below ? "fell under its stop" : "ran above its limit"} (delayed)`,
  );
  const rows: [string, string][] = [
    ["Pick", `${f.code} ${truncate(f.name, 80)}`],
    ["Buy limit", f.limit],
    ["Stop", f.stop],
    f.last === null
      ? ["Quote time", `${f.quoteTime} (delayed)`]
      : ["Delayed price", `${f.last} at ${f.quoteTime} (delayed)`],
  ];
  if (!below && f.capText) rows.push(["Chase cap", f.capText]);
  const doc = {
    title: subject,
    preheader: below
      ? `${f.code}: idea invalid before entry.`
      : `${f.code}: ran above the limit, do not chase.`,
    blocks: [
      { t: "h" as const, text: "Pick cleared (delayed)", level: 1 as const },
      {
        t: "p" as const,
        text: below
          ? "Idea invalid before entry: price fell under the stop."
          : "Opened or ran above the limit: do not chase.",
        tone: "warn" as const,
        bold: true,
      },
      { t: "kv" as const, rows },
      {
        t: "p" as const,
        text: "No action is needed; Praxis has stopped watching this pick for the buy price.",
      },
      {
        t: "link" as const,
        label: "Open the alert in Praxis",
        href: joinUrl(input.appUrl, "/alerts"),
      },
    ],
    footer: footerFor(input.env, input.appUrl, input.latency),
  };
  return fitLadder(() => renderEmail(subject, doc), 0, SMALL_MAX_BYTES);
}

export function renderPickCandidate(input: PickInput<PickCandidateFacts>): SizedEmailOut {
  const f = input.facts;
  const subject = withEnvPrefix(
    input.env,
    `[Praxis] Attention needed — ${f.code} found ${f.foundAt} (intraday, delayed)`,
  );
  const rows: [string, string][] = [
    [
      "Trigger",
      `${truncate(f.trigger.title, 140)} (${f.trigger.source}, ${f.trigger.publishedAt})`,
    ],
    ["Move", `${f.movePct} at ${f.quoteTime} (delayed)`],
    ["Relative volume", f.relVolume ?? "volume unavailable"],
    ["Gates passed", f.gatesPassed.length ? f.gatesPassed.join(", ") : "none listed"],
    ["Indicative limit", f.limit ?? "not computed"],
    ["Indicative stop", f.stop ?? "not computed"],
  ];
  const blocks: Block[] = [
    { t: "h", text: `Attention needed: ${f.code} ${truncate(f.name, 60)}`, level: 1 },
  ];
  if (f.unvalidated) {
    blocks.push({
      t: "p",
      text: "Unvalidated stream — see §19.5 status",
      tone: "warn",
      bold: true,
    });
  }
  blocks.push({ t: "kv", rows });
  blocks.push({ t: "link", label: "Open Praxis", href: joinUrl(input.appUrl, "/picks") });
  const doc = {
    title: subject,
    preheader: `${f.code} found ${f.foundAt} on a delayed price.`,
    blocks,
    footer: footerFor(input.env, input.appUrl, input.latency),
  };
  return fitLadder(() => renderEmail(subject, doc), 0, SMALL_MAX_BYTES);
}

const LIST_LIMIT = [Infinity, 15, 5]; // threshold-ok: size ladder rows, as the P0 batch

function lineTable(lines: PickLine[], level: number, appUrl: string): Block[] {
  const limit = LIST_LIMIT[level] ?? 5;
  const shown = lines.slice(0, limit);
  const blocks: Block[] = [
    {
      t: "table",
      head: ["Code", "What", "Delayed price", "Quote time"],
      rows: shown.map((l) => [l.code, l.what, l.price, l.quoteTime]),
    },
  ];
  if (lines.length > shown.length) {
    blocks.push({
      t: "p",
      text: `${lines.length - shown.length} more ${plural(lines.length - shown.length, "item")} in the app.`,
      tone: "warn",
    });
  }
  blocks.push({ t: "link", label: "All alerts", href: joinUrl(appUrl, "/alerts") });
  return blocks;
}

export function renderPickBatch(input: PickBatchInput): SizedEmailOut {
  const n = input.lines.length;
  const first = input.lines[0];
  const subject = withEnvPrefix(
    input.env,
    `[Praxis] ${n} pick ${plural(n, "alert")}${first ? ` — ${first.code}${n > 1 ? " and others" : ""}` : ""} (delayed)`,
  );
  const render = (level: number) =>
    renderEmail(subject, {
      title: subject,
      preheader: `${n} pick ${plural(n, "alert")} at ${input.window} (delayed prices)`,
      blocks: [
        { t: "h", text: "Pick alerts, batched (delayed)", level: 1 },
        { t: "p", text: `${n} pick ${plural(n, "alert")} in the poll at ${input.window}.` },
        ...lineTable(input.lines, level, input.appUrl),
        { t: "p", text: PLACE_STOP },
      ],
      footer: footerFor(input.env, input.appUrl, input.latency),
    });
  return fitLadder(render, 2, SMALL_MAX_BYTES);
}

export function renderPickDigest(input: PickDigestInput): SizedEmailOut {
  const n = input.lines.length;
  const subject = withEnvPrefix(
    input.env,
    `[Praxis] Pick alerts held in quiet hours — ${n} ${plural(n, "item")} (delayed)`,
  );
  const render = (level: number) =>
    renderEmail(subject, {
      title: subject,
      preheader: `${n} pick ${plural(n, "alert")} held during quiet hours ${input.quietWindow}.`,
      blocks: [
        { t: "h", text: "Pick alerts held during quiet hours (delayed)", level: 1 },
        {
          t: "p",
          text: `Quiet hours ${input.quietWindow} have ended. These alerts were held; their prices are those at the quote time shown, and may be out of date now.`,
        },
        ...lineTable(input.lines, level, input.appUrl),
        { t: "p", text: PLACE_STOP },
      ],
      footer: footerFor(input.env, input.appUrl, input.latency),
    });
  return fitLadder(render, 2, SMALL_MAX_BYTES);
}
