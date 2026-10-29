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
  it("full review has all ten headings, the KPI row and no partial box", () => {
    const { text, html } = CASES["review-full"]!.out;
    for (const h of [
      "1. Headline scorecard",
      "2. Investments made today",
      "3. Profit / loss",
      "4. What was learned today",
      "5. What worked better and why",
      "6. What needs improving for tomorrow",
      "7. Overall picture",
      "8. Sentinel recap",
      "9. System & quota health",
      "10. Footer",
    ]) {
      expect(text).toContain(h);
    }
    expect(html.match(/data-kpi="1"/g)?.length).toBeGreaterThanOrEqual(3);
    expect(html.match(/data-kpi="1"/g)?.length).toBeLessThanOrEqual(4);
    expect(text).not.toContain("Partial review");
    expect(text).toContain("Written without AI today");
    expect(text).toContain("single-day result — noise");
    expect(text).toContain("Simulation for personal information only; not financial advice");
    expect(text).toContain("never ask for keys or passwords");
    expect(text).toContain("n/a");
  });

  it("KPI tiles are single column at phone width and per-currency only", () => {
    const { html, text } = CASES["review-full"]!.out;
    expect(html).toMatch(
      /max-width:600px[^}]*\{[^}]*\}[^<]*\.kpi\{display:block !important;width:100% !important/,
    );
    expect(text).toContain("Day P/L AUD");
    expect(text.toLowerCase()).not.toContain("total across");
  });

  it("partial review starts with the EML-011 box listing missing sections", () => {
    const { text, subject } = CASES["review-partial"]!.out;
    expect(subject).toContain("(partial)");
    expect(text.indexOf("Partial review — not ready by 20:30:")).toBeGreaterThan(-1);
    expect(text.indexOf("Partial review")).toBeLessThan(text.indexOf("1. Headline scorecard"));
    expect(text).toContain("Section 4: What was learned today");
    expect(text).toContain("Section 7: Overall picture — success %");
    expect(text).toContain("Not ready");
  });

  it("minimal review is short and flagged", () => {
    const { text, subject, sizeHtml } = CASES["review-minimal"]!.out;
    expect(subject).toContain("(minimal)");
    expect(text).toContain("Minimal review");
    expect(text).not.toContain("8. Sentinel recap");
    expect(sizeHtml).toBeLessThan(CASES["review-full"]!.out.sizeHtml);
  });

  it("non-trading day keeps all ten headings and replaces trading content", () => {
    const { text, subject } = CASES["review-non-trading"]!.out;
    expect(subject).toContain("non-trading day");
    expect(text).toContain("10. Footer");
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
