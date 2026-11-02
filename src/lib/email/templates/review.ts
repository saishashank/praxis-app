// Evening Review renderer (M5 T4; design 2.6 and 4.6; EML-010...014, EML-035...037, UXN-163).
// Pure: typed facts in, { subject, html, text } out. Every number comes from the facts (LLM-034);
// the narrative is either supplied (R5 wording) or the facts-only "Written without AI today" list.
//
// Variants: full, partial (EML-011 box), minimal (watchdog fallback, NFR-006), non-trading
// (all 10 headings, trading sections replaced, DAT-022). Size ladder (design 4.6 step 2): level 0 =
// one line per execution; 1 = section 2 per-order tables become counts + link; 2 = section 7
// tables become a headline + link.

import {
  type Block,
  type Cell,
  type Doc,
  type EnvName,
  REVIEW_MAX_BYTES,
  type SizedEmailOut,
  type Tone,
  fitLadder,
  joinUrl,
  renderEmail,
  standardFooter,
  withEnvPrefix,
} from "./core";
import { dateLabel, glyphBar, money, pct, plural, toneOf, truncate } from "./format";
import { displayTitle } from "@/lib/view/displayText";

export type ReviewVariant = "full" | "partial" | "minimal" | "nonTrading";

export interface ExecutionFact {
  id: string; // "E01"
  label: string;
  currency: string;
  navCents: number;
  dayPlCents: number;
  /** Progress towards the target, 0..100 (glyph bar). */
  progressPct: number;
  distanceToTargetCents: number;
  realisedCents: number;
  unrealisedCents: number;
  costsCents: number;
  sleevePlCents: number;
  sleeve: "locked" | "unlocked" | "none";
  sleeveRecoveryPct?: number;
  terminal?: "target" | "bust" | "stalled" | "timeout";
  /** App path of the execution page, e.g. "/executions/E01". */
  path: string;
}

export interface OrderFact {
  executionId: string;
  state: "filled" | "created";
  side: "buy" | "sell";
  code: string;
  qty: number;
  priceCents: number;
  costsCents: number;
  currency: string;
  stopCents?: number;
  targetCents?: number;
  reason: string;
  cardPath: string;
}

export interface HealthLine {
  label: string;
  status: "ok" | "attention" | "down";
  detail: string;
}

export interface AttentionItem {
  name: string;
  status: "attention" | "down";
  daysOpen: number;
  fix: string;
}

export interface AlertFact {
  tier: "P0" | "P1" | "P2";
  code: string;
  title: string;
  time: string; // pre-formatted Australia/Melbourne time
  effect: string;
  url?: string;
}

export interface StatRow {
  label: string;
  value: string;
  detail?: string;
}

export interface AgentSuccess {
  agent: string;
  successPct: number | null; // null -> "n/a" (ARN-075)
  n: number;
}

export interface NarrativeFacts {
  /** "llm" = R5 wording; "rules" = deterministic facts-only fallback (EML-014). */
  kind: "llm" | "rules";
  s4: string[];
  s5: string[];
  s6: string[];
}

/** M17 EML-042: pick-alert lines of section 8, the optional candidate list, section 9's held/suppressed mail. */
export interface PickReviewFacts {
  /** "Buy-price alerts today: ..." and "Intraday candidates today: ..." */
  lines: string[];
  /** Null = the candidate list is switched off (`intraday_candidate_emails`) or empty. */
  candidates: { code: string; trigger: string; outcome: string }[] | null;
  /** Pick mail the cap suppressed or quiet hours held (EML-041), one line each. */
  held: string[];
}

export interface ReviewFacts {
  variant: ReviewVariant;
  env: EnvName;
  /** Review date (Melbourne calendar date, YYYY-MM-DD). Passed in; no clock reads. */
  date: string;
  appUrl: string;
  /** Consecutive unread days (EML-036): 3 or more prefixes the subject "UNREAD 3 DAYS". */
  unreadDays?: number;
  /** data-only mode: the arena did not run (sections 1-7 show a notice, not partial). */
  arenaActive: boolean;
  /** Partial review: sections still missing at 20:30 (EML-011). */
  missing?: { n: number; name: string }[];
  /** Minimal review: why the fallback was used. */
  minimalReason?: string;
  executions: ExecutionFact[];
  /** Section 1. */
  scorecard: {
    best?: { id: string; label: string; currency: string; dayPlCents: number };
    worst?: { id: string; label: string; currency: string; dayPlCents: number };
    healthyComponents: number;
    totalComponents: number;
    attention: AttentionItem[];
  };
  orders: OrderFact[];
  narrative: NarrativeFacts | null;
  stats: { headline: string; rows: StatRow[]; agents: AgentSuccess[] } | null;
  alerts: AlertFact[];
  regimeNotice?: string;
  breakerHits: { execution: string; breaker: string; effect: string }[];
  health: HealthLine[];
  suppressedEmails: number;
  nextTradingNote?: string;
  pickAlerts?: PickReviewFacts;
}

const SECTION_NAMES = [
  "Headline scorecard",
  "Investments made today",
  "Profit / loss",
  "What was learned today",
  "What worked better and why",
  "What needs improving for tomorrow",
  "Overall picture — success %",
  "Sentinel recap",
  "System & quota health",
  "Footer",
];

const MAX_LADDER = 2;

function currencies(ex: ExecutionFact[]): string[] {
  return [...new Set(ex.map((e) => e.currency))].sort();
}

function dayPlByCurrency(ex: ExecutionFact[]): { currency: string; cents: number; n: number }[] {
  return currencies(ex).map((currency) => {
    const rows = ex.filter((e) => e.currency === currency);
    return { currency, cents: rows.reduce((a, r) => a + r.dayPlCents, 0), n: rows.length };
  });
}

function tone(cents: number): Tone | undefined {
  return toneOf(cents);
}

function statusTone(s: HealthLine["status"]): Tone | undefined {
  return s === "ok" ? "pos" : s === "attention" ? "warn" : "neg";
}

function statusWord(s: HealthLine["status"]): string {
  return s === "ok" ? "OK" : s === "attention" ? "Needs attention" : "Down";
}

function subjectFor(f: ReviewFacts): string {
  const label = dateLabel(f.date);
  const tag =
    f.variant === "partial"
      ? " (partial)"
      : f.variant === "minimal"
        ? " (minimal)"
        : f.variant === "nonTrading"
          ? " (non-trading day)"
          : "";
  const unread = f.unreadDays !== undefined && f.unreadDays >= 3 ? "UNREAD 3 DAYS " : "";
  return withEnvPrefix(f.env, `${unread}Praxis Evening Review${tag} — ${label}`);
}

function kpiBlock(f: ReviewFacts): Block {
  const tiles: Extract<Block, { t: "kpis" }>["tiles"] = [];
  const trading = f.variant !== "nonTrading" && f.arenaActive;
  if (trading) {
    for (const c of dayPlByCurrency(f.executions)) {
      tiles.push({
        label: `Day P/L ${c.currency}`,
        value: money(c.cents, c.currency, true),
        sub: `${c.n} ${plural(c.n, "execution")}`,
        tone: tone(c.cents),
      });
    }
    const { best, worst } = f.scorecard;
    if (best) {
      tiles.push({
        label: "Best execution",
        value: `${best.id} ${money(best.dayPlCents, best.currency, true)}`,
        sub: "single-day result — noise",
        tone: tone(best.dayPlCents),
      });
    }
    if (worst) {
      tiles.push({
        label: "Worst execution",
        value: `${worst.id} ${money(worst.dayPlCents, worst.currency, true)}`,
        sub: "single-day result — noise",
        tone: tone(worst.dayPlCents),
      });
    }
  } else {
    tiles.push({
      label: f.arenaActive ? "Market" : "Arena",
      value: f.arenaActive ? "Market closed" : "Not active",
      sub: f.arenaActive ? "non-trading day" : "data-only mode",
    });
    for (const c of currencies(f.executions)) {
      const nav = f.executions.filter((e) => e.currency === c).reduce((a, e) => a + e.navCents, 0);
      tiles.push({ label: `Carried NAV ${c}`, value: money(nav, c) });
    }
  }
  const p0 = f.alerts.filter((a) => a.tier === "P0").length;
  tiles.push({ label: "P0 alerts", value: String(p0), tone: p0 > 0 ? "warn" : undefined });
  // 3-4 tiles (UXN-163): keep the P0 tile and at most three others.
  const p0Tile = tiles[tiles.length - 1]!;
  return { t: "kpis", tiles: [...tiles.slice(0, 3), p0Tile].slice(-4) };
}

function notActive(): Block {
  return { t: "p", text: "Arena not active (data-only mode).", tone: "muted" };
}

function unavailable(): Block {
  return { t: "p", text: "Not ready — see the partial-review box at the top.", tone: "warn" };
}

function section1(f: ReviewFacts, missing: Set<number>): Block[] {
  const out: Block[] = [{ t: "h", text: `1. ${SECTION_NAMES[0]}` }];
  if (!f.arenaActive) out.push(notActive());
  else if (missing.has(1)) out.push(unavailable());
  else if (f.variant === "nonTrading") {
    out.push({ t: "p", text: "Market closed today. Carried NAV and system health are shown." });
  } else {
    out.push({
      t: "table",
      head: ["Currency", "Day P/L", "Executions"],
      rows: dayPlByCurrency(f.executions).map((c) => [
        c.currency,
        { text: money(c.cents, c.currency, true), tone: tone(c.cents) },
        String(c.n),
      ]),
      right: [1, 2],
    });
    const { best, worst } = f.scorecard;
    const kv: [string, Cell][] = [];
    if (best)
      kv.push(["Best", `${best.id} ${best.label}: ${money(best.dayPlCents, best.currency, true)}`]);
    if (worst)
      kv.push([
        "Worst",
        `${worst.id} ${worst.label}: ${money(worst.dayPlCents, worst.currency, true)}`,
      ]);
    if (kv.length)
      out.push(
        { t: "kv", rows: kv },
        { t: "small", text: "Best and worst are a single-day result — noise." },
      );
    const terminal = f.executions.filter((e) => e.terminal);
    out.push(
      terminal.length
        ? {
            t: "ul",
            items: terminal.map(
              (e) => `${e.id} ${e.label} reached a terminal state today: ${e.terminal}.`,
            ),
          }
        : { t: "p", text: "No execution reached a terminal state today.", tone: "muted" },
    );
  }
  out.push({
    t: "p",
    text: `System health: ${f.scorecard.healthyComponents} of ${f.scorecard.totalComponents} components healthy.`,
    tone: f.scorecard.healthyComponents === f.scorecard.totalComponents ? "pos" : "warn",
  });
  if (f.scorecard.attention.length) {
    out.push({
      t: "ul",
      items: f.scorecard.attention.map(
        (a) =>
          `${a.name} (${a.status === "down" ? "down" : "needs attention"}, day ${a.daysOpen}): ${a.fix}`,
      ),
    });
  }
  return out;
}

function orderRow(o: OrderFact, appUrl: string): Cell[] {
  return [
    o.executionId,
    `${o.side.toUpperCase()} ${o.code}`,
    String(o.qty),
    money(o.priceCents, o.currency),
    money(o.costsCents, o.currency),
    o.stopCents !== undefined || o.targetCents !== undefined
      ? `${o.stopCents !== undefined ? `stop ${money(o.stopCents, o.currency)}` : ""}${o.stopCents !== undefined && o.targetCents !== undefined ? ", " : ""}${o.targetCents !== undefined ? `target ${money(o.targetCents, o.currency)}` : ""}`
      : "-",
    { text: truncate(o.reason, 90), href: joinUrl(appUrl, o.cardPath) },
  ];
}

function section2(f: ReviewFacts, level: number, missing: Set<number>): Block[] {
  const out: Block[] = [{ t: "h", text: `2. ${SECTION_NAMES[1]}` }];
  if (!f.arenaActive) return [...out, notActive()];
  if (missing.has(2)) return [...out, unavailable()];
  if (f.variant === "nonTrading") {
    return [...out, { t: "p", text: "No trading today.", tone: "muted" }];
  }
  const filled = f.orders.filter((o) => o.state === "filled");
  const created = f.orders.filter((o) => o.state === "created");
  if (f.orders.length === 0) return [...out, { t: "p", text: "No paper orders today." }];
  const head = ["Exec", "Order", "Qty", "Price", "Costs", "Stop / target", "Reason (card)"];
  const reviewLink: Block = {
    t: "link",
    label: "All orders and Decision Cards in the app",
    href: joinUrl(f.appUrl, `/reviews/${f.date}`),
  };
  if (level >= 1) {
    out.push({
      t: "p",
      text: `${filled.length} ${plural(filled.length, "order")} filled today; ${created.length} ${plural(created.length, "order")} created for the next session.`,
    });
    out.push(reviewLink);
    return out;
  }
  if (filled.length) {
    out.push({ t: "p", text: `Filled today (${filled.length})`, bold: true });
    out.push({
      t: "table",
      head,
      rows: filled.map((o) => orderRow(o, f.appUrl)),
      right: [2, 3, 4],
    });
  }
  if (created.length) {
    out.push({ t: "p", text: `Created for the next session (${created.length})`, bold: true });
    out.push({
      t: "table",
      head,
      rows: created.map((o) => orderRow(o, f.appUrl)),
      right: [2, 3, 4],
    });
  }
  return out;
}

function sleeveText(e: ExecutionFact): string {
  if (e.sleeve === "none") return "no sleeve";
  const lock = e.sleeve === "locked" ? "locked" : "unlocked";
  const rec = e.sleeveRecoveryPct !== undefined ? `, recovery ${pct(e.sleeveRecoveryPct, 0)}` : "";
  return `sleeve ${money(e.sleevePlCents, e.currency, true)} ${lock}${rec}`;
}

function section3(f: ReviewFacts, missing: Set<number>): Block[] {
  const out: Block[] = [{ t: "h", text: `3. ${SECTION_NAMES[2]}` }];
  if (!f.arenaActive) return [...out, notActive()];
  if (missing.has(3)) return [...out, unavailable()];
  if (f.executions.length === 0) return [...out, { t: "p", text: "No executions.", tone: "muted" }];
  const carried = f.variant === "nonTrading";
  out.push({
    t: "table",
    head: ["Execution", "NAV", carried ? "Day P/L" : "Day P/L", "To target", "Detail"],
    rows: f.executions.map((e) => [
      { text: `${e.id} ${e.label}`, href: joinUrl(f.appUrl, e.path) },
      money(e.navCents, e.currency),
      {
        text: carried ? "-" : money(e.dayPlCents, e.currency, true),
        tone: carried ? undefined : tone(e.dayPlCents),
      },
      `${glyphBar(e.progressPct)} ${pct(e.progressPct, 0)} (${money(e.distanceToTargetCents, e.currency)} to go)`,
      `realised ${money(e.realisedCents, e.currency, true)}; unrealised ${money(e.unrealisedCents, e.currency, true)}; costs ${money(e.costsCents, e.currency)}; ${sleeveText(e)}`,
    ]),
    right: [1, 2],
  });
  return out;
}

function narrativeSection(n: 4 | 5 | 6, f: ReviewFacts, missing: Set<number>): Block[] {
  const out: Block[] = [{ t: "h", text: `${n}. ${SECTION_NAMES[n - 1]}` }];
  if (!f.arenaActive) return [...out, notActive()];
  if (missing.has(n)) return [...out, unavailable()];
  const nar = f.narrative;
  const items = nar ? (n === 4 ? nar.s4 : n === 5 ? nar.s5 : nar.s6) : [];
  if (!nar || nar.kind === "rules") {
    out.push({ t: "small", text: "Written without AI today — facts only." });
  }
  out.push(
    items.length
      ? { t: "ul", items }
      : {
          t: "p",
          text:
            n === 6 && f.variant === "nonTrading"
              ? "No items queued for the next session."
              : "Nothing to report.",
          tone: "muted",
        },
  );
  return out;
}

function section7(f: ReviewFacts, level: number, missing: Set<number>): Block[] {
  const out: Block[] = [{ t: "h", text: `7. ${SECTION_NAMES[6]}` }];
  if (!f.arenaActive) return [...out, notActive()];
  if (missing.has(7)) return [...out, unavailable()];
  if (!f.stats) return [...out, { t: "p", text: "No statistics available yet.", tone: "muted" }];
  out.push({ t: "p", text: f.stats.headline, bold: true });
  if (level >= 2) {
    out.push({
      t: "link",
      label: "Full tables in the app",
      href: joinUrl(f.appUrl, `/reviews/${f.date}`),
    });
    return out;
  }
  if (f.stats.rows.length) {
    out.push({
      t: "table",
      head: ["Measure", "Value", "Detail"],
      rows: f.stats.rows.map((r) => [r.label, r.value, r.detail ?? ""]),
      right: [1],
    });
  }
  if (f.stats.agents.length) {
    out.push({ t: "p", text: "Signal success % by agent", bold: true });
    for (const a of f.stats.agents) {
      out.push({
        t: "bar",
        label: a.agent,
        percent: a.successPct ?? 0,
        valueText: a.successPct === null ? "n/a" : `${pct(a.successPct, 0)} (n = ${a.n})`,
      });
    }
  }
  return out;
}

function section8(f: ReviewFacts): Block[] {
  const out: Block[] = [{ t: "h", text: `8. ${SECTION_NAMES[7]}` }];
  if (f.regimeNotice)
    out.push({ t: "box", title: "Regime notice", lines: [f.regimeNotice], tone: "warn" });
  if (f.alerts.length === 0)
    out.push({ t: "p", text: "No significant alerts today.", tone: "muted" });
  else {
    out.push({
      t: "table",
      head: ["Tier", "Code", "What", "Time", "Effect"],
      rows: f.alerts.map((a) => [
        {
          text: a.tier,
          tone: a.tier === "P0" ? "neg" : a.tier === "P1" ? "warn" : undefined,
          bold: true,
        },
        a.code,
        { text: truncate(displayTitle(a.title), 100), href: a.url },
        a.time,
        truncate(a.effect, 120),
      ]),
    });
  }
  if (f.breakerHits.length) {
    out.push({ t: "p", text: "Thesis-breaker hits", bold: true });
    out.push({
      t: "ul",
      items: f.breakerHits.map((b) => `${b.execution}: ${b.breaker} — ${b.effect}`),
    });
  }
  const pa = f.pickAlerts;
  if (pa && pa.lines.length) out.push({ t: "ul", items: pa.lines });
  if (pa?.candidates && pa.candidates.length) {
    out.push({
      t: "p",
      text: "Intraday candidates (delayed prices, unvalidated stream)",
      bold: true,
    });
    out.push({
      t: "table",
      head: ["Code", "Trigger", "18:10 outcome"],
      rows: pa.candidates.map((c) => [c.code, truncate(c.trigger, 100), c.outcome]),
    });
  }
  return out;
}

function section9(f: ReviewFacts): Block[] {
  const out: Block[] = [{ t: "h", text: `9. ${SECTION_NAMES[8]}` }];
  out.push({
    t: "table",
    head: ["Check", "Status", "Detail"],
    rows: f.health.map((h) => [
      h.label,
      { text: statusWord(h.status), tone: statusTone(h.status), bold: true },
      h.detail,
    ]),
  });
  if (f.pickAlerts && f.pickAlerts.held.length) {
    out.push({ t: "p", text: "Pick alerts not e-mailed today", bold: true });
    out.push({ t: "ul", items: f.pickAlerts.held });
  }
  if (f.suppressedEmails > 0) {
    out.push({
      t: "p",
      text: `${f.suppressedEmails} ${plural(f.suppressedEmails, "email")} suppressed by the daily cap (EML-004).`,
      tone: "warn",
    });
  }
  return out;
}

function partialBox(f: ReviewFacts): Block[] {
  if (f.variant !== "partial") return [];
  const m = f.missing ?? [];
  return [
    {
      t: "box",
      title: "Partial review — not ready by 20:30:",
      lines: m.length
        ? m.map((x) => `Section ${x.n}: ${x.name}`)
        : ["Some inputs were still missing."],
      tone: "warn",
    },
    {
      t: "small",
      text: "The completed review is stored in the app when the pipeline finishes; it is not emailed again.",
    },
  ];
}

function minimalDoc(f: ReviewFacts): Block[] {
  const out: Block[] = [
    {
      t: "box",
      title: "Minimal review",
      lines: [
        f.minimalReason ??
          "The normal review could not be sent, so this short version was sent directly.",
        "Numbers are from the last completed data for this date.",
      ],
      tone: "warn",
    },
    kpiBlock(f),
    { t: "h", text: `3. ${SECTION_NAMES[2]}` },
  ];
  out.push(
    f.executions.length
      ? {
          t: "table",
          head: ["Execution", "NAV", "Day P/L"],
          rows: f.executions.map((e) => [
            { text: `${e.id} ${e.label}`, href: joinUrl(f.appUrl, e.path) },
            money(e.navCents, e.currency),
            { text: money(e.dayPlCents, e.currency, true), tone: tone(e.dayPlCents) },
          ]),
          right: [1, 2],
        }
      : { t: "p", text: "No execution data available.", tone: "muted" },
  );
  out.push(
    { t: "h", text: `9. ${SECTION_NAMES[8]}` },
    {
      t: "p",
      text: `System health: ${f.scorecard.healthyComponents} of ${f.scorecard.totalComponents} components healthy.`,
    },
  );
  if (f.scorecard.attention.length) {
    out.push({ t: "ul", items: f.scorecard.attention.map((a) => `${a.name}: ${a.fix}`) });
  }
  return out;
}

function buildDoc(f: ReviewFacts, level: number): Doc {
  const missing = new Set((f.missing ?? []).map((m) => m.n));
  const label = dateLabel(f.date);
  const blocks: Block[] = [
    { t: "h", text: "Praxis Evening Review", level: 1 },
    { t: "p", text: label, tone: "muted" },
    ...partialBox(f),
  ];
  if (f.variant === "minimal") {
    blocks.push(...minimalDoc(f));
  } else {
    blocks.push(
      kpiBlock(f),
      ...section1(f, missing),
      ...section2(f, level, missing),
      ...section3(f, missing),
      ...narrativeSection(4, f, missing),
      ...narrativeSection(5, f, missing),
      ...narrativeSection(6, f, missing),
      ...section7(f, level, missing),
      ...section8(f),
      ...section9(f),
    );
  }
  blocks.push({
    t: "link",
    label: "Read this review in the app",
    href: joinUrl(f.appUrl, `/reviews/${f.date}`),
  });
  if (f.nextTradingNote) blocks.push({ t: "small", text: f.nextTradingNote });
  const footer: Block[] = [
    { t: "p", text: `10. ${SECTION_NAMES[9]}`, bold: true },
    ...standardFooter(f.appUrl, f.env),
  ];
  const unread = f.unreadDays !== undefined && f.unreadDays >= 3;
  if (unread) {
    blocks.splice(2, 0, {
      t: "box",
      title: "UNREAD 3 DAYS",
      lines: [
        "No Evening Review has been marked read for 3 days. Open one and press Mark as read.",
      ],
      tone: "warn",
    });
  }
  return {
    title: `Praxis Evening Review ${label}`,
    preheader:
      `Evening Review for ${label}. ${f.variant === "partial" ? "Partial review." : ""}`.trim(),
    blocks,
    footer,
  };
}

/** Renders the Evening Review. Deterministic: no clock, no randomness. */
export function renderReview(
  facts: ReviewFacts,
  maxBytes: number = REVIEW_MAX_BYTES,
): SizedEmailOut {
  const subject = subjectFor(facts);
  return fitLadder((level) => renderEmail(subject, buildDoc(facts, level)), MAX_LADDER, maxBytes);
}
