// Synthetic fact objects for the email template tests (TST-129). No real personal or market data:
// codes are made up, the hosts are example.test.
import type {
  AlertFact,
  BriefInput,
  ExecutionFact,
  IncidentInput,
  OrderFact,
  P0AlertFacts,
  ReminderInput,
  ReviewFacts,
  TestInput,
  TokensDueInput,
  UnreadInput,
} from "../../../src/lib/email/templates";

export const APP = "https://praxis.example.test";
export const DATE = "2026-10-19";

export function execution(i: number, over: Partial<ExecutionFact> = {}): ExecutionFact {
  const id = `E${String(i).padStart(2, "0")}`;
  return {
    id,
    label: `Strategy ${i}`,
    currency: "AUD",
    navCents: 100_000_00 + i * 1_234_56,
    dayPlCents: (i % 3 === 0 ? -1 : 1) * i * 12_345,
    progressPct: (i * 7) % 100,
    distanceToTargetCents: 50_000_00 - i * 100_00,
    realisedCents: i * 5_000,
    unrealisedCents: -i * 1_500,
    costsCents: i * 250,
    sleevePlCents: i % 2 === 0 ? i * 100 : 0,
    sleeve: i % 4 === 0 ? "locked" : i % 2 === 0 ? "unlocked" : "none",
    sleeveRecoveryPct: i % 4 === 0 ? 35 : undefined,
    path: `/executions/${id}`,
    ...over,
  };
}

export function order(i: number, over: Partial<OrderFact> = {}): OrderFact {
  return {
    executionId: `E${String((i % 12) + 1).padStart(2, "0")}`,
    state: i % 3 === 0 ? "created" : "filled",
    side: i % 2 === 0 ? "buy" : "sell",
    code: `TST${String(i % 40).padStart(2, "0")}`,
    qty: 100 + i,
    priceCents: 1_000 + i * 7,
    costsCents: 995,
    currency: "AUD",
    stopCents: i % 2 === 0 ? 900 + i : undefined,
    targetCents: i % 2 === 0 ? 1_300 + i : undefined,
    reason: `Signal E0${(i % 9) + 1} fired on volume and trend alignment for example code ${i}`,
    cardPath: `/cards/card:sig${i}:E01`,
    ...over,
  };
}

export const ALERTS: AlertFact[] = [
  {
    tier: "P0",
    code: "TST01",
    title: "Trading halt pending an announcement",
    time: "10:42 AEDT",
    effect: "E03 holds 12.5% of NAV; stop review queued",
    url: "https://asx.example.test/ann/1",
  },
  {
    tier: "P1",
    code: "TST07",
    title: "Quarterly activities report",
    time: "11:05 AEDT",
    effect: "Watch-list item, materiality 3",
  },
  { tier: "P2", code: "TST09", title: "Appendix 3Y", time: "12:30 AEDT", effect: "No effect" },
];

export function reviewFacts(over: Partial<ReviewFacts> = {}): ReviewFacts {
  const executions = Array.from({ length: 12 }, (_, k) => execution(k + 1));
  return {
    variant: "full",
    env: "production",
    date: DATE,
    appUrl: APP,
    arenaActive: true,
    executions,
    scorecard: {
      best: { id: "E12", label: "Strategy 12", currency: "AUD", dayPlCents: 12 * 12_345 },
      worst: { id: "E09", label: "Strategy 9", currency: "AUD", dayPlCents: -9 * 12_345 },
      healthyComponents: 8,
      totalComponents: 9,
      attention: [
        { name: "Backups", status: "attention", daysOpen: 2, fix: "Re-run the backup workflow" },
      ],
    },
    orders: Array.from({ length: 6 }, (_, k) => order(k + 1)),
    narrative: {
      kind: "rules",
      s4: ["Challenger C1 is at n = 12 of 30 required; promotion not yet possible."],
      s5: ["No detectable difference between families (n = 12)."],
      s6: ["2 orders pending for the next session.", "Known event tomorrow: RBA minutes."],
    },
    stats: {
      headline: "P(target) 4.1%, P(bust) 9.8%, P(stalled) 20.0% vs matched controls (n = 12).",
      rows: [
        { label: "Win rate", value: "52.0%", detail: "n = 50" },
        { label: "Expectancy", value: "AUD +4.20", detail: "per trade" },
      ],
      agents: [
        { agent: "A1 Sentinel", successPct: 61, n: 40 },
        { agent: "Patterns", successPct: 48, n: 35 },
        { agent: "Scribe", successPct: null, n: 0 },
      ],
    },
    alerts: ALERTS,
    regimeNotice: "Regime changed from calm to stressed; 4 executions gated.",
    breakerHits: [{ execution: "E03", breaker: "TB-REGIME", effect: "exit queued for next open" }],
    health: [
      { label: "Jobs", status: "ok", detail: "all fresh" },
      { label: "Data", status: "ok", detail: "ASX bars to 2026-10-19" },
      { label: "ASX switch", status: "ok", detail: "on" },
      { label: "LLM budget", status: "attention", detail: "estimate 72% of quota" },
      { label: "Last backup", status: "down", detail: "failed 2026-10-18" },
    ],
    suppressedEmails: 0,
    ...over,
  };
}

export const REVIEW_FULL = reviewFacts();
export const REVIEW_PARTIAL = reviewFacts({
  variant: "partial",
  missing: [
    { n: 4, name: "What was learned today" },
    { n: 7, name: "Overall picture — success %" },
  ],
});
export const REVIEW_MINIMAL = reviewFacts({
  variant: "minimal",
  minimalReason: "The email route was unreachable at 20:40.",
});
export const REVIEW_NON_TRADING = reviewFacts({
  variant: "nonTrading",
  date: "2026-10-17",
  orders: [],
  alerts: [ALERTS[1]!],
  regimeNotice: undefined,
  breakerHits: [],
});
export const REVIEW_DATA_ONLY = reviewFacts({ arenaActive: false, stats: null, narrative: null });
export const REVIEW_UNREAD = reviewFacts({ unreadDays: 3, env: "staging" });

/** A deliberately oversized review that needs size-ladder level 2. */
export function worstReview(): ReviewFacts {
  return reviewFacts({
    orders: Array.from({ length: 400 }, (_, k) => order(k + 1)),
    stats: {
      headline: "Worst-case statistics fixture.",
      rows: Array.from({ length: 700 }, (_, k) => ({
        label: `Measure ${k} with a long descriptive label for padding purposes`,
        value: `${k}.00`,
        detail: "detail text that repeats across rows to inflate the table size",
      })),
      agents: Array.from({ length: 12 }, (_, k) => ({ agent: `Agent ${k}`, successPct: k * 5, n: 30 + k })),
    },
  });
}

export const P0_ALERT: P0AlertFacts = {
  alertKey: "alert:TST01:ann1",
  code: "TST01",
  title: "Trading halt pending an announcement",
  type: "Trading halt",
  why: "A held position with weight of at least 10% of NAV is halted (P0 rule).",
  executions: [
    { id: "E03", label: "Strategy 3", weightPct: 12.5 },
    { id: "E07", label: "Strategy 7", weightPct: 10.4 },
  ],
  sourceUrl: "https://asx.example.test/ann/1",
  time: "Mon 19 Oct 2026 10:42 AEDT",
};

export const P0_BATCH_ALERTS: P0AlertFacts[] = [
  P0_ALERT,
  { ...P0_ALERT, alertKey: "alert:TST02:ann2", code: "TST02", title: "Suspension from quotation", type: "Suspension" },
  { ...P0_ALERT, alertKey: "alert:TST03:ann3", code: "TST03", title: "Trading halt", type: "Trading halt" },
];

export const INCIDENT_OPEN: IncidentInput = {
  env: "production",
  appUrl: APP,
  incidentId: "inc-0042",
  event: "open",
  severity: "S2",
  component: "Sentinel",
  summary: "Sentinel blind for more than 15 minutes",
  since: "Mon 19 Oct 2026 10:20 AEDT",
  impact: "Announcements are not being read; P0 alerts may be late.",
  fix: "Check the Worker poll and the announcement source in System Health.",
  fixPath: "/system-health#sentinel",
};
export const INCIDENT_ESCALATED: IncidentInput = { ...INCIDENT_OPEN, event: "escalated", severity: "S1" };

export const TOKENS_DUE: TokensDueInput = {
  env: "production",
  appUrl: APP,
  date: DATE,
  tokens: [
    { name: "GitHub bot token", expiresOn: "2026-10-21", daysLeft: 2, where: "GitHub developer settings" },
    { name: "Turso database token", expiresOn: "2026-10-26", daysLeft: 7, where: "Turso dashboard" },
    { name: "Cloudflare API token", expiresOn: "2026-11-02", daysLeft: 14, where: "Cloudflare dashboard" },
  ],
};

export const UNREAD7: UnreadInput = {
  env: "production",
  appUrl: APP,
  date: DATE,
  days: 7,
  unreadDates: ["2026-10-19", "2026-10-18", "2026-10-17", "2026-10-16", "2026-10-15", "2026-10-14", "2026-10-13"],
};

export const REMINDER: ReminderInput = {
  env: "production",
  appUrl: APP,
  date: DATE,
  items: [
    {
      name: "Backups",
      status: "down",
      daysOpen: 2,
      deadline: "2026-10-21",
      fix: "Re-run the backup workflow and check the data repository token.",
      fixPath: "/system-health#backups",
    },
    {
      name: "Free-tier limits",
      status: "attention",
      daysOpen: 1,
      fix: "Quota at 72%; no action needed yet.",
      fixPath: "/system-health#limits",
    },
  ],
  resolvedSinceYesterday: ["AI models"],
};

export const BRIEF: BriefInput = {
  env: "production",
  appUrl: APP,
  date: DATE,
  overnight: [
    { code: "TST01", title: "Capital raising announced", time: "07:45 AEDT", url: "https://asx.example.test/ann/9" },
  ],
  events: [
    { label: "Ex-dividend", detail: "TST05 today" },
    { label: "RBA", detail: "minutes released 11:30" },
  ],
  plan: ["2 orders pending at the open", "E03 thesis-breaker amber (TB-REGIME)"],
};

export const TEST_EMAIL: TestInput = { env: "production", appUrl: APP, requestedAt: "Mon 19 Oct 2026 09:00 AEDT" };

// M17 WP4 (EML-038..041): pick-alert facts, all pre-formatted strings, synthetic codes.
export const PICK_HIT = {
  alertId: "a".repeat(64),
  code: "ZZ01",
  name: "Zed Zero Holdings",
  publishedAt: "Tue 3 Nov 2026 18:10 AEDT",
  limit: "A$10.000",
  last: "A$9.950",
  quoteTime: "Wed 4 Nov 2026 10:42 AEDT",
  stop: "A$9.200",
  stopDistancePct: "7.5%",
  parcel: { amount: "A$2,000", shares: 200 },
  timeFrame: "5 sessions",
};
export const PICK_CLEARED_BELOW = {
  alertId: "b".repeat(64),
  code: "ZZ02",
  name: "Zed Two Limited",
  variant: "below_stop" as const,
  limit: "A$5.000",
  stop: "A$4.600",
  last: null,
  quoteTime: "Wed 4 Nov 2026 11:05 AEDT",
};
export const PICK_CLEARED_CAP = {
  alertId: "c".repeat(64),
  code: "ZZ03",
  name: "Zed Three Group",
  variant: "above_chase_cap" as const,
  limit: "A$8.000",
  stop: "A$7.400",
  last: null,
  quoteTime: "Wed 4 Nov 2026 10:15 AEDT",
  capText: "3% above the limit (A$8.240)",
};
export const PICK_CANDIDATE = {
  code: "ZZ04",
  name: "Zed Four Resources",
  foundAt: "11:42",
  trigger: {
    title: "Contract award announced",
    source: "ASX announcement",
    publishedAt: "Wed 4 Nov 2026 11:20 AEDT",
  },
  movePct: "+6.2%",
  relVolume: "2.4x",
  quoteTime: "Wed 4 Nov 2026 11:40 AEDT",
  gatesPassed: ["G01", "G02", "G08"],
  limit: "A$3.100",
  stop: "A$2.850",
  unvalidated: true,
};
export const PICK_LINES = [
  { code: "ZZ01", what: "Buy price hit", price: "A$9.950", quoteTime: "Wed 4 Nov 2026 10:42 AEDT" },
  { code: "ZZ02", what: "Cleared: fell under the stop", price: "n/a", quoteTime: "Wed 4 Nov 2026 10:42 AEDT" },
  { code: "ZZ03", what: "Cleared: ran above the limit", price: "n/a", quoteTime: "Wed 4 Nov 2026 10:42 AEDT" },
];
