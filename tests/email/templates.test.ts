// @vitest-environment node
// TST-129: email template renderers (M5 T4). Snapshot-compared per template and variant
// (tests/fixtures/email/snapshots), size-ladder boundaries (EML-013), plain-text part, no remote
// images, contrast (D-049), escaping, determinism. Set UPDATE_EMAIL_SNAPSHOTS=1 to rewrite snapshots.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DARK,
  LIGHT,
  REVIEW_MAX_BYTES,
  SMALL_MAX_BYTES,
  SURFACES,
  TEXT_ROLES,
  contrastRatio,
  glyphBar,
  renderBrief,
  renderIncident,
  renderP0,
  renderP0Batch,
  renderReminder,
  renderReview,
  renderTest,
  renderTokensDue,
  renderUnread7,
  type SizedEmailOut,
} from "../../src/lib/email/templates";
import * as fx from "../fixtures/email/facts";

const SNAP_DIR = path.join(import.meta.dirname, "..", "fixtures", "email", "snapshots");
const UPDATE = process.env.UPDATE_EMAIL_SNAPSHOTS === "1";

const CASES: Record<string, { out: SizedEmailOut; max: number }> = {
  "review-full": { out: renderReview(fx.REVIEW_FULL), max: REVIEW_MAX_BYTES },
  "review-partial": { out: renderReview(fx.REVIEW_PARTIAL), max: REVIEW_MAX_BYTES },
  "review-minimal": { out: renderReview(fx.REVIEW_MINIMAL), max: REVIEW_MAX_BYTES },
  "review-non-trading": { out: renderReview(fx.REVIEW_NON_TRADING), max: REVIEW_MAX_BYTES },
  "review-data-only": { out: renderReview(fx.REVIEW_DATA_ONLY), max: REVIEW_MAX_BYTES },
  "review-unread-staging": { out: renderReview(fx.REVIEW_UNREAD), max: REVIEW_MAX_BYTES },
  p0: {
    out: renderP0({ env: "production", appUrl: fx.APP, alert: fx.P0_ALERT }),
    max: SMALL_MAX_BYTES,
  },
  "p0-batch": {
    out: renderP0Batch({
      env: "production",
      appUrl: fx.APP,
      window: "10:42-10:47 AEDT",
      alerts: fx.P0_BATCH_ALERTS,
    }),
    max: SMALL_MAX_BYTES,
  },
  "incident-open": { out: renderIncident(fx.INCIDENT_OPEN), max: SMALL_MAX_BYTES },
  "incident-escalated": { out: renderIncident(fx.INCIDENT_ESCALATED), max: SMALL_MAX_BYTES },
  "tokens-due": { out: renderTokensDue(fx.TOKENS_DUE), max: SMALL_MAX_BYTES },
  "unread-7": { out: renderUnread7(fx.UNREAD7), max: SMALL_MAX_BYTES },
  reminder: { out: renderReminder(fx.REMINDER), max: SMALL_MAX_BYTES },
  brief: { out: renderBrief(fx.BRIEF), max: SMALL_MAX_BYTES },
  test: { out: renderTest(fx.TEST_EMAIL), max: SMALL_MAX_BYTES },
};

function snapshot(file: string, content: string): void {
  const p = path.join(SNAP_DIR, file);
  if (UPDATE || !existsSync(p)) {
    if (!UPDATE) throw new Error(`missing snapshot ${file}; run with UPDATE_EMAIL_SNAPSHOTS=1`);
    mkdirSync(SNAP_DIR, { recursive: true });
    writeFileSync(p, content, "utf8");
    return;
  }
  // autocrlf-safe: a Windows checkout may have converted the snapshot to CRLF.
  expect(content).toBe(readFileSync(p, "utf8").replaceAll("\r\n", "\n"));
}

describe("snapshots (TST-129)", () => {
  for (const [name, { out }] of Object.entries(CASES)) {
    it(`${name}: html, text and subject match the committed snapshots`, () => {
      snapshot(`${name}.html`, out.html);
      snapshot(`${name}.txt`, `Subject: ${out.subject}\n\n${out.text}`);
    });
  }
});

describe("every template", () => {
  for (const [name, { out, max }] of Object.entries(CASES)) {
    describe(name, () => {
      it("has a single-line subject and a non-empty text alternative", () => {
        expect(out.subject.length).toBeGreaterThan(5);
        expect(out.subject).not.toMatch(/[\r\n]/);
        expect(out.text.trim().length).toBeGreaterThan(50);
        expect(out.text).toContain("not financial advice");
      });
      it("is within its size limit without hitting the oversize flag", () => {
        expect(out.sizeHtml).toBe(Buffer.byteLength(out.html, "utf8"));
        expect(out.sizeHtml).toBeLessThanOrEqual(max);
        expect(out.oversize).toBe(false);
      });
      it("has no remote images, scripts, stylesheets, forms or tracking pixels", () => {
        expect(out.html).not.toMatch(
          /<img|<script|<link|<iframe|<form|<object|<embed|<video|<audio/i,
        );
        expect(out.html).not.toMatch(/url\(|@import|background-image|\ssrc=/i);
      });
      it("only links to the app or example.test sources over https", () => {
        const hrefs = [...out.html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!);
        for (const h of hrefs) expect(h).toMatch(/^https:\/\/[a-z]+\.example\.test(\/|$)/);
        for (const h of out.text.match(/https?:\/\/\S+/g) ?? []) expect(h).toMatch(/^https:\/\//);
      });
      it("has inline styles, a viewport meta and a dark-mode block, and a language", () => {
        expect(out.html).toContain('<html lang="en">');
        expect(out.html).toContain('name="viewport"');
        expect(out.html).toContain("prefers-color-scheme: dark");
        expect(out.html).toMatch(/<body class="pg" style="/);
      });
      it("is deterministic", () => {
        const again = CASES[name]!.out;
        expect(again).toEqual(out);
      });
    });
  }
});

describe("Evening Review variants", () => {
  it("full review has its nine headings, the KPI row and no partial box (D-922)", () => {
    const { text, html } = CASES["review-full"]!.out;
    for (const h of [
      "1. Headline scorecard",
      "2. Investments made today",
      "3. Profit / loss",
      "4. What we learned today",
      "5. What worked better and why",
      "6. What needs improving for tomorrow",
      "7. Overall picture",
      "8. Today's alerts",
      "9. Footer",
    ]) {
      expect(text).toContain(h);
    }
    expect(html.match(/data-kpi="1"/g)?.length).toBeGreaterThanOrEqual(3);
    expect(html.match(/data-kpi="1"/g)?.length).toBeLessThanOrEqual(4);
    expect(text).not.toContain("Partial review");
    expect(text).toContain("Simulation for personal information only; not financial advice");
    expect(text).toContain("never ask for keys or passwords");
  });

  it("KPI tiles are single column at phone width and show the listed strategies' total", () => {
    const { html, text } = CASES["review-full"]!.out;
    expect(html).toMatch(
      /max-width:600px[^}]*\{[^}]*\}[^<]*\.kpi\{display:block !important;width:100% !important/,
    );
    expect(text).toContain("Today, all strategies");
    expect(text).toContain("Value now");
    expect(text).not.toContain("Best execution");
    expect(text).not.toContain("Worst execution");
  });

  it("uses no internal codes anywhere (D-922)", () => {
    const { text, html } = CASES["review-full"]!.out;
    // what a reader sees: no link targets, no tags
    const seen = [
      text.replace(/\(https?:\/\/\S+\)/g, "").replace(/https?:\/\/\S+/g, ""),
      html.replace(/<[^>]*>/g, " "),
    ];
    for (const s of seen) {
      expect(s).not.toMatch(/\bE\d{2}\b/);
      expect(s).not.toMatch(/\bF\d-[UL]\b/);
      expect(s).not.toMatch(/\bC\d-F\d\b/);
      expect(s).not.toMatch(/\bARN-\d+/);
      expect(s).not.toMatch(/\bP[012]\b/);
      expect(s).not.toMatch(/\bNAV\b/);
      expect(s).not.toContain("System & quota health");
      expect(s).not.toContain("Sentinel recap");
      expect(s).not.toContain("To target");
      expect(s).not.toContain("█");
    }
  });

  it("lists one line per plain-share strategy and never the leverage twins", () => {
    const { text } = CASES["review-full"]!.out;
    for (const i of [1, 3, 5, 7, 9, 11]) expect(text).toContain(`Strategy ${i}`);
    for (const i of [2, 4, 6, 8, 10, 12]) expect(text).not.toMatch(new RegExp(`Strategy ${i}\\b`));
    expect(text).toMatch(/Strategy 1[^\n]*\+A\$123\.45/);
  });

  it("the profit / loss table has strategy, value, today and since start only", () => {
    const { html } = CASES["review-full"]!.out;
    expect(html).toContain(">Since start<");
    expect(html).not.toContain(">To target<");
    expect(html).not.toContain(">Execution<");
    expect(html).not.toMatch(/realised|unrealised|sleeve/);
  });

  it("orders show the strategy name and the company with its code in brackets", () => {
    const { text } = CASES["review-full"]!.out;
    expect(text).toMatch(/Sell Example Company 1 \(TST01\)/);
    expect(text).toMatch(/Buy Example Company 2 \(TST02\)/);
  });

  it("what we learned: the daily learning, or a plain sentence when it did not run", () => {
    const { text } = CASES["review-full"]!.out;
    expect(text).toContain("Stocks that broke out on heavy volume rose 0.6%");
    expect(text).toContain("Breakout on heavy volume");
    expect(text).toContain("beats the market");
    expect(text).toContain("Gap-ups after results continue for 3 days.");
    const none = renderReview(fx.reviewFacts({ learning: null })).text;
    expect(none).toContain("The learning step did not run tonight.");
    expect(none).not.toContain("Breakout on heavy volume");
  });

  it("D-923: 'What the brain learned' shows the learning Cortex's lines, and is left out when absent", () => {
    const base = fx.REVIEW_FULL.learning!;
    const cortex = {
      lines: [
        "Of the 20 biggest gainers on Tue 10 Nov, the Cortex had 6 in its top tenth the evening before.",
      ],
      numbers: { rows: 6, angles: 3, nextDayOf: 2, nextDayRight: 1, dataBreaks: 0, coverage: null },
    };
    const withBrain = renderReview(fx.reviewFacts({ learning: { ...base, cortex } }));
    expect(withBrain.text).toContain("What the brain learned");
    expect(withBrain.text).toContain(cortex.lines[0]);
    expect(withBrain.html).toContain("What the brain learned");
    expect(CASES["review-full"]!.out.text).not.toContain("What the brain learned");
    // only the brain's lines: they count as something learned
    const only = renderReview(
      fx.reviewFacts({
        learning: { ...base, summary: [], lessons: [], hypothesesOpened: [], cortex },
      }),
    ).text;
    expect(only).toContain(cortex.lines[0]);
    expect(only).not.toContain("Nothing new was learned today.");
  });

  it("D-993: the top-5 gainer target opens the learning section, and is left out when absent", () => {
    const base = fx.REVIEW_FULL.learning!;
    const top5 = {
      d: "2026-11-10",
      liquid: 400,
      named: 8,
      gainers: [
        {
          code: "ZZBHP",
          name: "Zed Big Holdings",
          movePpm: 80_000,
          via: "strategy" as const,
          where: "Balanced #1",
          missed: null,
        },
        {
          code: "ZZB",
          name: null,
          movePpm: 60_000,
          via: null,
          where: null,
          missed: "sector_move" as const,
        },
      ],
      gainersHad: 1,
      losers: [],
      losersHad: 0,
      picks: { n: 8, up: 5, down: 3, meanMovePpm: 4_000 },
      chanceHits: 0.04,
      rolling: { nights: 20, gainers: 100, had: 3, chanceHits: 0.8 },
    };
    const out = renderReview(fx.reviewFacts({ learning: { ...base, top5 } })).text;
    expect(out).toContain("Our target: the day's top 5 gainers");
    expect(out).toContain(
      "Top 2 gainers today: we had one (Zed Big Holdings (ZZBHP) in the picks)",
    );
    expect(out).toContain("the last 20 trading days: 3 of 100 (3%)");
    expect(out.indexOf("Our target")).toBeLessThan(out.indexOf(base.summary[0]!));
    expect(CASES["review-full"]!.out.text).not.toContain("Our target");
  });

  it("what worked: honest when every result is a loss, and when nothing closed", () => {
    const { text } = CASES["review-full"]!.out;
    expect(text).toContain("Nothing worked today: all 2 trades that finished lost money");
    expect(text).toContain("stop-loss hit");
    expect(text).toContain("closing signal");
    const empty = renderReview(fx.reviewFacts({ closedTrades: [] })).text;
    expect(empty).toContain("Nothing worked today: no strategy finished a trade.");
    const won = renderReview(
      fx.reviewFacts({
        closedTrades: [
          {
            strategy: "Strategy 1",
            code: "TST01",
            company: null,
            resultCents: 5_00,
            exit: "closing signal",
          },
        ],
      }),
    ).text;
    expect(won).not.toContain("Nothing worked today");
    expect(won).toContain("1 of 1 finished trade made money");
  });

  it("what needs improving: the improvements, the queued-order line, then the movers", () => {
    const { text } = CASES["review-full"]!.out;
    expect(text).toContain("Look at gap-up news earlier");
    expect(text).toContain("Next step: Add pre-open announcements");
    expect(text).toContain("2 orders queued for the next session.");
    expect(text).toContain("Example Company 11 (TST11)");
    expect(text).toContain("Rose after a results announcement before the open.");
    expect(text).toContain("Near miss: Follow the trend");
    expect(text).toContain("Not caught");
    expect(text).not.toContain("?");
  });

  it("the movers fall back to the descriptive check only when the learning is missing", () => {
    const fb = {
      lines: ["Last night's picks: none were published."],
      gainers: [
        {
          code: "TST21",
          name: "Fallback Co",
          movePpm: 70_000,
          seen: "no strategy signalled it",
          news: "no announcement",
        },
      ],
      losers: [],
    };
    const withLearning = renderReview(fx.reviewFacts({ missedMovers: fb })).text;
    expect(withLearning).not.toContain("Fallback Co");
    const without = renderReview(fx.reviewFacts({ learning: null, missedMovers: fb })).text;
    expect(without).toContain("Fallback Co (TST21)");
    expect(without).toContain("no announcement");
  });

  it("success %: no agent bars and no control rows; a sentence until the twins are measured", () => {
    const { text } = CASES["review-full"]!.out;
    expect(text).toContain("Comparison with random-pick twins starts after 3 finished rounds.");
    expect(text).not.toContain("Sentinel");
    const measured = renderReview(
      fx.reviewFacts({
        stats: {
          headline: "h",
          rows: [],
          comparisons: ["Strategy 1: 2.0 percentage points ahead of its random-pick twin."],
        },
      }),
    ).text;
    expect(measured).toContain("Strategy 1: 2.0 percentage points ahead");
    expect(measured).not.toContain("starts after 3 finished rounds");
  });

  it("today's alerts is dropped when there is nothing to show", () => {
    const quiet = renderReview(
      fx.reviewFacts({ alerts: [], regimeNotice: undefined, breakerHits: [] }),
    ).text;
    expect(quiet).not.toContain("Today's alerts");
    expect(quiet).toContain("8. Footer");
  });

  it("partial review starts with the EML-011 box listing missing sections", () => {
    const { text, subject } = CASES["review-partial"]!.out;
    expect(subject).toContain("(partial)");
    expect(text.indexOf("Partial review — not ready by 20:30:")).toBeGreaterThan(-1);
    expect(text.indexOf("Partial review")).toBeLessThan(text.indexOf("1. Headline scorecard"));
    expect(text).toContain("Section 4: What we learned today");
    expect(text).toContain("Section 7: Overall picture — success %");
    expect(text).toContain("Not ready");
  });

  it("minimal review is short and flagged", () => {
    const { text, subject, sizeHtml } = CASES["review-minimal"]!.out;
    expect(subject).toContain("(minimal)");
    expect(text).toContain("Minimal review");
    expect(text).not.toContain("8. Today's alerts");
    expect(sizeHtml).toBeLessThan(CASES["review-full"]!.out.sizeHtml);
  });

  it("non-trading day keeps its headings and replaces trading content", () => {
    const { text, subject } = CASES["review-non-trading"]!.out;
    expect(subject).toContain("non-trading day");
    expect(text).toContain("9. Footer");
    expect(text).toContain("No trading today.");
    expect(text).toContain("Market closed");
    expect(text).not.toContain("No paper orders today");
  });

  it("trading day with no orders says so", () => {
    const { text } = renderReview(fx.reviewFacts({ orders: [] }));
    expect(text).toContain("No paper orders today.");
  });

  it("data-only mode shows the arena notice and is not marked partial", () => {
    const { text } = CASES["review-data-only"]!.out;
    expect(text).toContain("Arena not active (data-only mode).");
    expect(text).not.toContain("Partial review");
  });

  it("UNREAD 3 DAYS and [STAGING] prefix the subject", () => {
    const { subject, text } = CASES["review-unread-staging"]!.out;
    expect(subject.startsWith("[STAGING] UNREAD 3 DAYS Praxis Evening Review")).toBe(true);
    expect(text).toContain("STAGING environment");
    expect(CASES["review-full"]!.out.subject.startsWith("Praxis Evening Review")).toBe(true);
  });

  it("states there is no unsubscribe (Owner-only transactional mail)", () => {
    expect(CASES["review-full"]!.out.text).toContain("nothing to unsubscribe from");
  });
});

describe("other templates", () => {
  it("P0 states what, why, source, time and has no LLM text", () => {
    const { text, subject } = CASES["p0"]!.out;
    expect(subject).toBe("Praxis P0: TST01 — Trading halt pending an announcement");
    for (const s of [
      "What happened",
      "Why it matters",
      "https://asx.example.test/ann/1",
      "10:42 AEDT",
      "12.5% of NAV",
    ]) {
      expect(text).toContain(s);
    }
  });
  it("P0 batch lists every alert and shortens the list only when it must", () => {
    const { text, subject } = CASES["p0-batch"]!.out;
    expect(subject).toBe("Praxis P0: 3 alerts — TST01 and others");
    for (const c of ["TST01", "TST02", "TST03"]) expect(text).toContain(c);
    const many = Array.from({ length: 60 }, (_, k) => ({
      ...fx.P0_ALERT,
      alertKey: `alert:${k}`,
      code: `TST${k}`,
      why: "x".repeat(300),
    }));
    const big = renderP0Batch({ env: "production", appUrl: fx.APP, window: "w", alerts: many });
    expect(big.sizeHtml).toBeLessThanOrEqual(SMALL_MAX_BYTES);
    expect(big.ladderLevel).toBeGreaterThan(0);
    expect(big.text).toContain("more alerts in the app");
  });
  it("incident subjects distinguish open and escalation", () => {
    expect(CASES["incident-open"]!.out.subject).toBe(
      "Praxis incident S2: Sentinel blind for more than 15 minutes",
    );
    expect(CASES["incident-escalated"]!.out.subject).toContain("ESCALATED to S1");
  });
  it("tokens due is one combined email, soonest first, names only", () => {
    const { text, subject } = CASES["tokens-due"]!.out;
    expect(subject).toBe("Praxis: 3 tokens due — GitHub bot token (2 days)");
    expect(text.indexOf("GitHub bot token")).toBeLessThan(text.indexOf("Cloudflare API token"));
  });
  it("unread-7 subject and test subject", () => {
    expect(CASES["unread-7"]!.out.subject).toBe("Praxis: Evening Review unread for 7 days");
    expect(CASES["test"]!.out.subject).toBe("[TEST] Praxis test email");
    expect(renderTest({ ...fx.TEST_EMAIL, env: "staging" }).subject).toBe(
      "[STAGING] [TEST] Praxis test email",
    );
  });
  it("reminder subject follows EML-023 and the ladder keeps it under 20 KB", () => {
    expect(CASES["reminder"]!.out.subject).toBe("Praxis: 2 items need attention — Backups (day 2)");
    const items = Array.from({ length: 200 }, (_, k) => ({
      ...fx.REMINDER.items[1]!,
      name: `Item ${k}`,
      fix: "f".repeat(130),
    }));
    const big = renderReminder({ ...fx.REMINDER, items });
    expect(big.sizeHtml).toBeLessThanOrEqual(SMALL_MAX_BYTES);
    expect(big.ladderLevel).toBe(2);
    expect(big.text).toContain("190 more items in the Control Room.");
    expect(big.text).not.toContain("Resolved since yesterday");
  });
  it("single reminder item uses the singular", () => {
    const one = renderReminder({ ...fx.REMINDER, items: [fx.REMINDER.items[0]!] });
    expect(one.subject).toBe("Praxis: 1 item needs attention — Backups (day 2)");
  });
  it("brief ladder shortens long lists", () => {
    const overnight = Array.from({ length: 300 }, (_, k) => ({
      code: `TST${k}`,
      title: "t".repeat(100),
      time: "07:00 AEDT",
    }));
    const big = renderBrief({ ...fx.BRIEF, overnight });
    expect(big.sizeHtml).toBeLessThanOrEqual(SMALL_MAX_BYTES);
    expect(big.ladderLevel).toBeGreaterThan(0);
  });
});

describe("size ladder (EML-013)", () => {
  const f = fx.worstReview();
  const l0 = renderReview(f, Number.MAX_SAFE_INTEGER);
  const l1 = renderReview(f, l0.sizeHtml - 1);
  const l2 = renderReview(f, l1.sizeHtml - 1);

  it("level 0 is the default and exceeds 90 KB for the worst fixture", () => {
    expect(l0.ladderLevel).toBe(0);
    expect(l0.sizeHtml).toBeGreaterThan(REVIEW_MAX_BYTES);
  });
  it("boundary: exactly the size fits, one byte less steps down a level", () => {
    expect(renderReview(f, l0.sizeHtml).ladderLevel).toBe(0);
    expect(l1.ladderLevel).toBe(1);
    expect(renderReview(f, l1.sizeHtml).ladderLevel).toBe(1);
    expect(l2.ladderLevel).toBe(2);
    expect(l1.text).toContain("orders filled today");
    expect(l2.text).toContain("Full tables in the app");
  });
  it("the worst fixture fits 90 KB after the ladder", () => {
    const out = renderReview(f);
    expect(out.ladderLevel).toBeGreaterThan(0);
    expect(out.sizeHtml).toBeLessThanOrEqual(REVIEW_MAX_BYTES);
    expect(out.oversize).toBe(false);
  });
  it("below the last level the result is flagged oversize", () => {
    const out = renderReview(f, l2.sizeHtml - 1);
    expect(out.ladderLevel).toBe(2);
    expect(out.oversize).toBe(true);
  });
  it("the normal fixtures never leave level 0", () => {
    expect(CASES["review-full"]!.out.ladderLevel).toBe(0);
  });
});

describe("palette contrast (D-049, WCAG AA)", () => {
  for (const [name, pal] of [
    ["light", LIGHT],
    ["dark", DARK],
  ] as const) {
    for (const role of TEXT_ROLES) {
      for (const surface of SURFACES) {
        it(`${name}: ${role} on ${surface} is at least 4.5:1`, () => {
          expect(contrastRatio(pal[role], pal[surface])).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
    for (const surface of SURFACES) {
      it(`${name}: border on ${surface} is at least 3:1`, () => {
        expect(contrastRatio(pal.border, pal[surface])).toBeGreaterThanOrEqual(3);
      });
    }
  }
  it("contrast helper known answers", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 5);
  });
  it("the HTML uses only palette colours", () => {
    const allowed = new Set([...Object.values(LIGHT), ...Object.values(DARK)]);
    for (const { out } of Object.values(CASES)) {
      for (const m of out.html.matchAll(/#[0-9a-fA-F]{3,8}\b/g))
        expect(allowed.has(m[0].toLowerCase())).toBe(true);
    }
  });
});

describe("escaping", () => {
  const evil = `<script>alert(1)</script> "q" 'a' & <b>x</b>`;
  it("escapes HTML in every fact string and never emits unsafe links", () => {
    const f = fx.reviewFacts({
      alerts: [
        {
          tier: "P0",
          code: evil,
          title: evil,
          time: evil,
          effect: evil,
          url: "javascript:alert(1)",
        },
      ],
      regimeNotice: evil,
      breakerHits: [{ execution: evil, breaker: evil, effect: evil }],
      narrative: { kind: "llm", s4: [evil], s5: [evil], s6: [evil] },
      health: [{ label: evil, status: "ok", detail: evil }],
      closedTrades: [{ strategy: evil, code: evil, company: evil, resultCents: -1, exit: evil }],
      learning: {
        d: fx.DATE,
        summary: [evil],
        movers: [
          {
            code: evil,
            name: evil,
            side: "gainer",
            movePpm: 1,
            cause: "stock_specific",
            causeText: evil,
            indexMovePpm: null,
            sectorName: null,
            sectorMovePpm: null,
            volumeVsUsualPpm: null,
            setupBefore: [evil],
            caughtBy: evil,
            nearMiss: null,
          },
        ],
        lessons: [
          {
            feature: evil,
            sessions: 1,
            n: 1,
            nextDayAvgPpm: 1,
            baseAvgPpm: 1,
            liftPpm: 0,
            hitRatePpm: 0,
            verdict: "no clear edge yet",
            change: "new",
          },
        ],
        improvements: [{ title: evil, evidence: evil, action: evil, area: "picks" }],
        hypothesesOpened: [evil],
      },
      orders: [fx.order(1, { reason: evil, code: evil, cardPath: '/x"onmouseover="y' })],
    });
    const { html } = renderReview(f);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toMatch(/href="javascript/i);
    expect(html).not.toMatch(/onmouseover="y/);
  });
  it("escapes the other templates and the title", () => {
    const outs = [
      renderP0({
        env: "production",
        appUrl: fx.APP,
        alert: { ...fx.P0_ALERT, title: evil, why: evil, sourceUrl: "javascript:x" },
      }),
      renderIncident({ ...fx.INCIDENT_OPEN, summary: evil, fix: evil }),
      renderTokensDue({
        ...fx.TOKENS_DUE,
        tokens: [{ name: evil, expiresOn: evil, daysLeft: 1, where: evil }],
      }),
      renderReminder({
        ...fx.REMINDER,
        items: [{ ...fx.REMINDER.items[0]!, name: evil, fix: evil }],
      }),
      renderBrief({ ...fx.BRIEF, plan: [evil], events: [{ label: evil, detail: evil }] }),
    ];
    for (const o of outs) {
      expect(o.html).not.toContain("<script>");
      expect(o.html).not.toContain("<b>x</b>");
      expect(o.html).not.toMatch(/href="javascript/i);
      expect(o.subject).not.toMatch(/[\r\n]/);
    }
  });
  it("subjects drop control characters", () => {
    const o = renderIncident({ ...fx.INCIDENT_OPEN, summary: "a\r\nBcc: x\u0000b" });
    expect(o.subject).not.toMatch(/[\r\n\u0000]/);
  });
});

describe("helpers", () => {
  it("glyph bars", () => {
    expect(glyphBar(0)).toBe("░".repeat(10));
    expect(glyphBar(100)).toBe("█".repeat(10));
    expect(glyphBar(55)).toBe("█".repeat(6) + "░".repeat(4));
    expect(glyphBar(-5)).toBe(glyphBar(0));
    expect(glyphBar(Number.NaN)).toBe(glyphBar(0));
  });
  it("rejects a malformed review date", () => {
    expect(() => renderReview(fx.reviewFacts({ date: "19/10/2026" }))).toThrow(/bad date/);
  });
});
