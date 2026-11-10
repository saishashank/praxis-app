// Evening Review renderer (M5 T4; design 2.6 and 4.6; EML-010...014, EML-035...037, UXN-163;
// rebuilt in plain words by D-922, Owner 2026-11-10). Pure: typed facts in, { subject, html, text }
// out. Every number comes from the facts (LLM-034). No internal codes: strategies by name, companies
// as "Name (CODE)", money as A$ with a sign, dates through formatDay.
//
// Variants: full, partial (EML-011 box), minimal (watchdog fallback, NFR-006), non-trading
// (trading sections replaced, DAT-022). Size ladder (design 4.6 step 2): level 0 = full tables;
// 1 = section 2 per-order tables become counts + link; 2 = section 7 tables become a headline + link.

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
import { dateLabel, plural, toneOf, truncate } from "./format";
import { formatDay } from "@/lib/view/format";
import { displayTitle } from "@/lib/view/displayText";
import type { DailyLearning } from "@/lib/learning/daily";
import {
  type ClosedTradeFact,
  aud,
  audWithPct,
  companyLabel,
  pctPpm,
  sortClosed,
  workedHeadline,
} from "./reviewWords";

export type { ClosedTradeFact };
export type ReviewVariant = "full" | "partial" | "minimal" | "nonTrading";

export interface ExecutionFact {
  id: string; // "E01" (never shown)
  label: string;
  /** The strategy name ("Follow the trend"); absent in old facts and the watchdog fallback. */
  name?: string;
  /** "U" plain shares, "L" leverage twin (never listed). Absent = listed. */
  variant?: "U" | "L";
  currency: string;
  navCents: number;
  dayPlCents: number;
  /** Day result as parts per million of yesterday's value (null when unknown). */
  dayPlPpm?: number | null;
  /** Value now minus the starting money, and as parts per million of it. */
  sinceStartCents?: number;
  sinceStartPpm?: number | null;
  /** Progress towards the target, 0..100 (no longer shown). */
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
  /** Strategy name of the order's execution. */
  strategy?: string;
  state: "filled" | "created";
  side: "buy" | "sell";
  code: string;
  /** Company name (display form). */
  companyName?: string | null;
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
  /** Company name (display form). */
  company?: string | null;
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
  successPct: number | null;
  n: number;
}

export interface NarrativeFacts {
  /** Plain lists behind sections 4-6, built by the readers (read by the masked in-app view). */
  kind: "llm" | "rules";
  s4: string[];
  s5: string[];
  s6: string[];
}

/** M17 EML-042: pick-alert lines of the alerts section and the optional candidate list. */
export interface PickReviewFacts {
  /** "Buy-price alerts today: ..." and "Intraday candidates today: ..." (only lines with content). */
  lines: string[];
  /** Null = the candidate list is switched off (`intraday_candidate_emails`) or empty. */
  candidates: { code: string; name?: string | null; trigger: string; outcome: string }[] | null;
  /** Pick mail the cap suppressed or quiet hours held (EML-041), one line each. */
  held: string[];
}

/** D-909 (fallback when the daily learning is missing): last night's picks graded and the biggest movers. */
export interface MoverFactRow {
  code: string;
  name?: string | null;
  movePpm: number;
  seen: string;
  news: string;
}
export interface MissedMoversReviewFacts {
  lines: string[];
  gainers: MoverFactRow[];
  losers: MoverFactRow[];
}

export interface StatsFacts {
  headline: string;
  rows: StatRow[];
  /** One line per strategy measured against its random-pick twins (empty until measured). */
  comparisons?: string[];
  /** Old facts only; no longer shown. */
  agents?: AgentSuccess[];
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
  /** Section 1 (the best/worst fields of earlier versions are no longer shown). */
  scorecard: {
    best?: { id: string; label: string; currency: string; dayPlCents: number };
    worst?: { id: string; label: string; currency: string; dayPlCents: number };
    healthyComponents: number;
    totalComponents: number;
    /** Actionable items only (a halted share that may resume). */
    attention: AttentionItem[];
  };
  orders: OrderFact[];
  /** Positions finished today (section 5). */
  closedTrades?: ClosedTradeFact[];
  /** Orders queued for the next session (section 6). */
  queuedOrders?: number;
  /** The daily learning of the date; null/absent = the step did not run. */
  learning?: DailyLearning | null;
  narrative: NarrativeFacts | null;
  stats: StatsFacts | null;
  alerts: AlertFact[];
  regimeNotice?: string;
  breakerHits: { execution: string; company?: string | null; breaker: string; effect: string }[];
  /** No longer shown (the system-health section was removed, D-922). */
  health: HealthLine[];
  suppressedEmails: number;
  nextTradingNote?: string;
  pickAlerts?: PickReviewFacts;
  /** D-909: shown only when `learning` is null. */
  missedMovers?: MissedMoversReviewFacts;
}

const SECTION_NAMES = [
  "Headline scorecard",
  "Investments made today",
  "Profit / loss",
  "What we learned today",
  "What worked better and why",
  "What needs improving for tomorrow",
  "Overall picture — success %",
  "Today's alerts",
  "Footer",
];

const MAX_LADDER = 2;

/** formatDay anchored to the review date: deterministic, the year only when it differs. */
function dayOf(f: Pick<ReviewFacts, "date">, d: string): string {
  return formatDay(d, new Date(`${f.date}T00:00:00.000Z`));
}

/** The listed strategies: plain shares only, never the leverage twins. */
function live(ex: ExecutionFact[]): ExecutionFact[] {
  return ex.filter((e) => e.variant !== "L");
}

function nameOf(e: ExecutionFact): string {
  return e.name ?? e.label;
}

function tone(cents: number): Tone | undefined {
  return toneOf(cents);
}

function subjectFor(f: ReviewFacts): string {
  const label = dayOf(f, f.date);
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

const sum = (xs: number[]): number => xs.reduce((a, x) => a + x, 0);

function kpiBlock(f: ReviewFacts): Block {
  const tiles: Extract<Block, { t: "kpis" }>["tiles"] = [];
  const ex = live(f.executions);
  const trading = f.variant !== "nonTrading" && f.arenaActive;
  if (trading) {
    const day = sum(ex.map((e) => e.dayPlCents));
    tiles.push({
      label: "Today, all strategies",
      value: aud(day, true),
      sub: `${ex.length} ${plural(ex.length, "strategy", "strategies")}`,
      tone: tone(day),
    });
    tiles.push({ label: "Value now", value: aud(sum(ex.map((e) => e.navCents))) });
    const closed = (f.closedTrades ?? []).length;
    tiles.push({
      label: "Trades finished today",
      value: String(closed),
      sub: closed === 0 ? "none closed" : undefined,
    });
  } else {
    tiles.push({
      label: f.arenaActive ? "Market" : "Arena",
      value: f.arenaActive ? "Market closed" : "Not active",
      sub: f.arenaActive ? "non-trading day" : "data-only mode",
    });
    if (ex.length > 0) {
      tiles.push({ label: "Value now", value: aud(sum(ex.map((e) => e.navCents))) });
    }
  }
  return { t: "kpis", tiles };
}

function notActive(): Block {
  return { t: "p", text: "Arena not active (data-only mode).", tone: "muted" };
}

function unavailable(): Block {
  return { t: "p", text: "Not ready — see the partial-review box at the top.", tone: "warn" };
}

const TERMINAL_WORDS: Readonly<Record<string, string>> = {
  target: "reached its profit target",
  bust: "lost too much and was stopped",
  stalled: "stalled without enough progress",
  timeout: "ran out of time",
};

function head(n: number, name: string): Block {
  return { t: "h", text: `${n}. ${name}` };
}

function section1(f: ReviewFacts, missing: Set<number>, n: number): Block[] {
  const out: Block[] = [head(n, SECTION_NAMES[0]!)];
  if (!f.arenaActive) out.push(notActive());
  else if (missing.has(1)) out.push(unavailable());
  else if (f.variant === "nonTrading") {
    out.push({ t: "p", text: "Market closed today. Values are carried from the last session." });
    out.push({
      t: "table",
      head: ["Strategy", "Value now"],
      rows: live(f.executions).map((e) => [
        { text: nameOf(e), href: joinUrl(f.appUrl, e.path) },
        aud(e.navCents),
      ]),
      right: [1],
    });
  } else {
    out.push({
      t: "table",
      head: ["Strategy", "Today (A$)", "Today (%)", "Value now"],
      rows: live(f.executions).map((e) => [
        { text: nameOf(e), href: joinUrl(f.appUrl, e.path) },
        { text: aud(e.dayPlCents, true), tone: tone(e.dayPlCents) },
        {
          text: e.dayPlPpm === null || e.dayPlPpm === undefined ? "-" : pctPpm(e.dayPlPpm),
          tone: tone(e.dayPlPpm ?? 0),
        },
        aud(e.navCents),
      ]),
      right: [1, 2, 3],
    });
    const terminal = live(f.executions).filter((e) => e.terminal);
    if (terminal.length) {
      out.push({
        t: "ul",
        items: terminal.map(
          (e) => `${nameOf(e)} ${TERMINAL_WORDS[e.terminal!] ?? `ended: ${e.terminal}`} today.`,
        ),
      });
    }
  }
  if (f.scorecard.attention.length) {
    out.push({
      t: "ul",
      items: f.scorecard.attention.map((a) => `${a.name}: ${a.fix}`),
    });
  }
  return out;
}

function orderRow(o: OrderFact, appUrl: string): Cell[] {
  const stop = o.stopCents !== undefined ? `stop ${aud(o.stopCents)}` : "";
  const target = o.targetCents !== undefined ? `target ${aud(o.targetCents)}` : "";
  return [
    o.strategy ?? o.executionId,
    `${o.side === "buy" ? "Buy" : "Sell"} ${companyLabel(o.companyName, o.code)}`,
    String(o.qty),
    aud(o.priceCents),
    aud(o.costsCents),
    stop || target ? [stop, target].filter(Boolean).join(", ") : "-",
    { text: truncate(o.reason, 90), href: joinUrl(appUrl, o.cardPath) },
  ];
}

function section2(f: ReviewFacts, level: number, missing: Set<number>, n: number): Block[] {
  const out: Block[] = [head(n, SECTION_NAMES[1]!)];
  if (!f.arenaActive) return [...out, notActive()];
  if (missing.has(2)) return [...out, unavailable()];
  if (f.variant === "nonTrading") {
    return [...out, { t: "p", text: "No trading today.", tone: "muted" }];
  }
  const filled = f.orders.filter((o) => o.state === "filled");
  const created = f.orders.filter((o) => o.state === "created");
  if (f.orders.length === 0) return [...out, { t: "p", text: "No paper orders today." }];
  const cols = ["Strategy", "Order", "Qty", "Price", "Costs", "Stop / target", "Reason (card)"];
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
      head: cols,
      rows: filled.map((o) => orderRow(o, f.appUrl)),
      right: [2, 3, 4],
    });
  }
  if (created.length) {
    out.push({ t: "p", text: `Created for the next session (${created.length})`, bold: true });
    out.push({
      t: "table",
      head: cols,
      rows: created.map((o) => orderRow(o, f.appUrl)),
      right: [2, 3, 4],
    });
  }
  return out;
}

function section3(f: ReviewFacts, missing: Set<number>, n: number): Block[] {
  const out: Block[] = [head(n, SECTION_NAMES[2]!)];
  if (!f.arenaActive) return [...out, notActive()];
  if (missing.has(3)) return [...out, unavailable()];
  const ex = live(f.executions);
  if (ex.length === 0) return [...out, { t: "p", text: "No strategies.", tone: "muted" }];
  const carried = f.variant === "nonTrading";
  out.push({
    t: "table",
    head: ["Strategy", "Value now", "Today", "Since start"],
    rows: ex.map((e) => [
      { text: nameOf(e), href: joinUrl(f.appUrl, e.path) },
      aud(e.navCents),
      {
        text: carried ? "-" : audWithPct(e.dayPlCents, e.dayPlPpm),
        tone: carried ? undefined : tone(e.dayPlCents),
      },
      e.sinceStartCents === undefined
        ? "-"
        : {
            text: audWithPct(e.sinceStartCents, e.sinceStartPpm),
            tone: tone(e.sinceStartCents),
          },
    ]),
    right: [1, 2, 3],
  });
  return out;
}

const LEARNING_MISSING = "The learning step did not run tonight.";

function section4(f: ReviewFacts, missing: Set<number>, n: number): Block[] {
  const out: Block[] = [head(n, SECTION_NAMES[3]!)];
  if (!f.arenaActive) return [...out, notActive()];
  if (missing.has(4)) return [...out, unavailable()];
  const l = f.learning ?? null;
  if (l === null) return [...out, { t: "p", text: LEARNING_MISSING, tone: "muted" }];
  if (l.summary.length) out.push({ t: "ul", items: l.summary });
  if (l.lessons.length) {
    out.push({
      t: "table",
      head: ["Feature", "Cases (n)", "Next day vs market", "Verdict", "Change"],
      rows: l.lessons.map((x) => [
        x.feature,
        String(x.n),
        `${pctPpm(x.nextDayAvgPpm)} vs ${pctPpm(x.baseAvgPpm)}`,
        x.verdict,
        x.change,
      ]),
      right: [1],
    });
  }
  if (l.hypothesesOpened.length) {
    out.push({ t: "p", text: "New ideas being tested", bold: true });
    out.push({ t: "ul", items: l.hypothesesOpened });
  }
  if (!l.summary.length && !l.lessons.length && !l.hypothesesOpened.length) {
    out.push({ t: "p", text: "Nothing new was learned today.", tone: "muted" });
  }
  return out;
}

function section5(f: ReviewFacts, missing: Set<number>, n: number): Block[] {
  const out: Block[] = [head(n, SECTION_NAMES[4]!)];
  if (!f.arenaActive) return [...out, notActive()];
  if (missing.has(5)) return [...out, unavailable()];
  if (f.variant === "nonTrading") {
    return [...out, { t: "p", text: "No trading today.", tone: "muted" }];
  }
  const closed = sortClosed(f.closedTrades ?? []);
  const h = workedHeadline(closed);
  out.push({ t: "p", text: h.text, tone: h.worked ? "pos" : "warn" });
  if (closed.length) {
    out.push({
      t: "table",
      head: ["Strategy", "Company", "Result", "How it ended"],
      rows: closed.map((c) => [
        c.strategy,
        companyLabel(c.company, c.code),
        { text: aud(c.resultCents, true), tone: tone(c.resultCents) },
        c.exit,
      ]),
      right: [2],
    });
  }
  return out;
}

function moverCaught(m: DailyLearning["movers"][number]): string {
  if (m.caughtBy) return `Caught by ${m.caughtBy}`;
  if (m.nearMiss) return `Near miss: ${m.nearMiss}`;
  return "Not caught";
}

function section6(f: ReviewFacts, missing: Set<number>, n: number): Block[] {
  const out: Block[] = [head(n, SECTION_NAMES[5]!)];
  if (!f.arenaActive) return [...out, notActive()];
  if (missing.has(6)) return [...out, unavailable()];
  const l = f.learning ?? null;
  if (l === null) {
    out.push({
      t: "p",
      text: "No improvement ideas tonight: the learning step did not run.",
      tone: "muted",
    });
  } else if (l.improvements.length === 0) {
    out.push({ t: "p", text: "No improvements are proposed for tomorrow.", tone: "muted" });
  } else {
    out.push({
      t: "ul",
      items: l.improvements.map((i) => `${i.title}: ${i.evidence} Next step: ${i.action}`),
    });
  }
  if (f.queuedOrders !== undefined && f.variant !== "nonTrading") {
    out.push({
      t: "p",
      text:
        f.queuedOrders === 0
          ? "No orders are queued for the next session."
          : `${f.queuedOrders} ${plural(f.queuedOrders, "order")} queued for the next session.`,
    });
  }
  out.push(...moversBlocks(f));
  return out;
}

/** Biggest gainers and losers: the daily learning's explanations, else the descriptive fallback. */
function moversBlocks(f: ReviewFacts): Block[] {
  const l = f.learning ?? null;
  const out: Block[] = [];
  const fb = f.missedMovers;
  if (fb && fb.lines.length) {
    out.push({ t: "p", text: "What we missed today", bold: true }, { t: "ul", items: fb.lines });
  }
  if (l !== null && l.movers.length > 0) {
    const table = (title: string, side: "gainer" | "loser") => {
      const rows = l.movers.filter((m) => m.side === side);
      if (rows.length === 0) return;
      out.push({ t: "p", text: title, bold: true });
      out.push({
        t: "table",
        head: ["Company", "Move", "Why it moved", "Setup before", "Caught by / near miss"],
        rows: rows.map((m) => [
          companyLabel(m.name === null ? null : m.name, m.code),
          { text: pctPpm(m.movePpm), tone: m.movePpm >= 0 ? "pos" : "neg" },
          truncate(m.causeText, 160),
          m.setupBefore.length ? truncate(m.setupBefore.join("; "), 140) : "none seen",
          moverCaught(m),
        ]),
        right: [1],
      });
    };
    table("Biggest gainers", "gainer");
    table("Biggest losers", "loser");
    return out;
  }
  if (fb) {
    const table = (title: string, rows: MoverFactRow[]) => {
      if (rows.length === 0) return;
      out.push({ t: "p", text: title, bold: true });
      out.push({
        t: "table",
        head: ["Company", "Move", "What we saw", "News"],
        rows: rows.map((r) => [
          companyLabel(r.name, r.code),
          { text: pctPpm(r.movePpm), tone: r.movePpm >= 0 ? "pos" : "neg" },
          truncate(r.seen, 100),
          truncate(r.news, 120),
        ]),
        right: [1],
      });
    };
    table("Biggest gainers", fb.gainers);
    table("Biggest losers", fb.losers);
  }
  return out;
}

function section7(f: ReviewFacts, level: number, missing: Set<number>, n: number): Block[] {
  const out: Block[] = [head(n, SECTION_NAMES[6]!)];
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
  const cmp = f.stats.comparisons ?? [];
  if (cmp.length) out.push({ t: "ul", items: cmp });
  else {
    out.push({
      t: "p",
      text: "Comparison with random-pick twins starts after 3 finished rounds.",
      tone: "muted",
    });
  }
  return out;
}

const CANDIDATE_OUTCOME: Readonly<Record<string, string>> = {
  night_pick: "carried into tonight's picks",
  "not yet decided": "not decided yet",
};

/** Today's alerts (D-922): only what has content; null when there is nothing to show. */
function section8(f: ReviewFacts, n: number): Block[] | null {
  const out: Block[] = [head(n, SECTION_NAMES[7]!)];
  let any = false;
  if (f.regimeNotice) {
    out.push({ t: "box", title: "Market mood changed", lines: [f.regimeNotice], tone: "warn" });
    any = true;
  }
  if (f.alerts.length > 0) {
    any = true;
    out.push({
      t: "table",
      head: ["Company", "What", "Time", "Effect"],
      rows: f.alerts.map((a) => [
        a.code === "-" || a.code === "" ? "-" : companyLabel(a.company, a.code),
        { text: truncate(displayTitle(a.title), 100), href: a.url },
        a.time,
        truncate(a.effect, 120),
      ]),
    });
  }
  if (f.breakerHits.length) {
    any = true;
    out.push({ t: "p", text: "Held or queued shares with a warning", bold: true });
    out.push({
      t: "ul",
      items: f.breakerHits.map((b) => `${companyLabel(b.company, b.execution)}: ${b.effect}`),
    });
  }
  const pa = f.pickAlerts;
  if (pa && pa.lines.length) {
    any = true;
    out.push({ t: "ul", items: pa.lines });
  }
  if (pa?.candidates && pa.candidates.length) {
    any = true;
    out.push({
      t: "p",
      text: "Intraday candidates (delayed prices, unvalidated stream)",
      bold: true,
    });
    out.push({
      t: "table",
      head: ["Company", "Trigger", "Outcome"],
      rows: pa.candidates.map((c) => [
        companyLabel(c.name, c.code),
        truncate(c.trigger.replace(/_/g, " "), 100),
        CANDIDATE_OUTCOME[c.outcome] ?? c.outcome.replace(/_/g, " "),
      ]),
    });
  }
  if (pa && pa.held.length) {
    any = true;
    out.push({ t: "p", text: "Pick alerts not e-mailed today", bold: true });
    out.push({ t: "ul", items: pa.held });
  }
  return any ? out : null;
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
  const ex = live(f.executions);
  out.push(
    ex.length
      ? {
          t: "table",
          head: ["Strategy", "Value now", "Today"],
          rows: ex.map((e) => [
            { text: nameOf(e), href: joinUrl(f.appUrl, e.path) },
            aud(e.navCents),
            { text: aud(e.dayPlCents, true), tone: tone(e.dayPlCents) },
          ]),
          right: [1, 2],
        }
      : { t: "p", text: "No strategy data available.", tone: "muted" },
  );
  if (f.scorecard.attention.length) {
    out.push({ t: "ul", items: f.scorecard.attention.map((a) => `${a.name}: ${a.fix}`) });
  }
  return out;
}

function buildDoc(f: ReviewFacts, level: number): Doc {
  const missing = new Set((f.missing ?? []).map((m) => m.n));
  const label = dayOf(f, f.date);
  const blocks: Block[] = [
    { t: "h", text: "Praxis Evening Review", level: 1 },
    { t: "p", text: label, tone: "muted" },
    ...partialBox(f),
  ];
  let next = 1;
  if (f.variant === "minimal") {
    blocks.push(...minimalDoc(f));
  } else {
    blocks.push(
      kpiBlock(f),
      ...section1(f, missing, next++),
      ...section2(f, level, missing, next++),
      ...section3(f, missing, next++),
      ...section4(f, missing, next++),
      ...section5(f, missing, next++),
      ...section6(f, missing, next++),
      ...section7(f, level, missing, next++),
    );
    const alerts = section8(f, next);
    if (alerts !== null) {
      blocks.push(...alerts);
      next += 1;
    }
  }
  blocks.push({
    t: "link",
    label: "Read this review in the app",
    href: joinUrl(f.appUrl, `/reviews/${f.date}`),
  });
  if (f.nextTradingNote) blocks.push({ t: "small", text: f.nextTradingNote });
  const footer: Block[] = [
    {
      t: "p",
      text: `${f.variant === "minimal" ? SECTION_NAMES.length : next}. ${SECTION_NAMES[8]}`,
      bold: true,
    },
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
  dateLabel(facts.date); // a malformed review date throws (never printed: dates go through formatDay)
  const subject = subjectFor(facts);
  return fitLadder((level) => renderEmail(subject, buildDoc(facts, level)), MAX_LADDER, maxBytes);
}
