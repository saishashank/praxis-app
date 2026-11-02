// @vitest-environment node
// M17 WP10 (SEC-114, ARN-111, UXN-301..311, NFR-041): no broker or trading link and no "buy now" style call
// to action in the pick e-mails, the picks, alerts and intraday UI, or the alerts report; and the NFR-041
// wording check (every intraday price surface says "delayed" and shows a quote time; "real-time" appears
// nowhere in src/). Source scan, no network.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const posix = (p: string) => p.split(path.sep).join("/");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const walk = (dir: string, out: string[] = []): string[] => {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs)$/.test(e.name)) out.push(full);
  }
  return out;
};
const rel = (f: string) => posix(path.relative(ROOT, f));

const SURFACE_DIRS = [
  "src/app/(app)/picks",
  "src/app/(app)/alerts",
  "src/app/(app)/settings/alerts",
  "src/app/(app)/reviews/alerts",
];
const SURFACE_FILES = [
  "src/lib/email/templates/pickAlerts.ts",
  "src/lib/email/pickMail.ts",
  "src/lib/ui/loaders/pickAlerts.ts",
  "src/app/(app)/market/[code]/page.tsx",
  "src/app/(app)/home/HomeContent.tsx",
];
const surfaces = [
  ...SURFACE_DIRS.flatMap((d) => walk(path.join(ROOT, d))).map(rel),
  ...SURFACE_FILES,
].sort();

/** Code and strings only: whole-line and trailing comments are dropped, so prose in a comment cannot trip it. */
function stripComments(src: string): string {
  return src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .map((l) => l.replace(/\s\/\/\s.*$/, ""))
    .join("\n");
}

const BROKERS =
  /commsec|selfwealth|stake\.com|nabtrade|interactivebrokers|interactive brokers|etrade|e\*trade|robinhood|webull|moomoo|tiger brokers|saxo|ig\.com|cmcmarkets|pepperstone|hotcopper|tradingview|brokerage|broker link|open (a|an|your) (broker|trading) (account|app)/i;
// a "buy now" style call to action (the product shows information; it never urges a trade)
const CTA =
  /\b(buy|sell|trade|invest|order|purchase)\s+(it\s+|this\s+|these\s+|them\s+)?(now|today|immediately|asap|before)\b|\bact (now|fast|quickly)\b|\bdon'?t miss\b|\blast chance\b|\bhurry\b|\bplace (an? |your )?(order|trade)\b|\b(click|tap) to (buy|sell|trade|invest)\b/i;

describe("no broker or trading links, no buy-now calls to action", () => {
  it("scans the pick e-mails, the picks, alerts and intraday UI and the alerts report", () => {
    expect(surfaces).toContain("src/lib/email/templates/pickAlerts.ts");
    expect(surfaces).toContain("src/app/(app)/picks/IntradaySection.tsx");
    expect(surfaces).toContain("src/app/(app)/picks/AlertChip.tsx");
    expect(surfaces).toContain("src/app/(app)/alerts/page.tsx");
    expect(surfaces).toContain("src/app/(app)/reviews/alerts/page.tsx");
    expect(surfaces).toContain("src/app/(app)/settings/alerts/page.tsx");
  });

  it("no broker name or trading-site address", () => {
    const bad: string[] = [];
    for (const f of surfaces) {
      const m = stripComments(read(f)).match(BROKERS);
      if (m) bad.push(`${f}: ${m[0]}`);
    }
    expect(bad).toEqual([]);
  });

  it("no external https link at all in the e-mail templates and the pick mail module", () => {
    const bad: string[] = [];
    for (const f of ["src/lib/email/templates/pickAlerts.ts", "src/lib/email/pickMail.ts"]) {
      const m = stripComments(read(f)).match(/https?:\/\/[^\s"'`)]+/g) ?? [];
      for (const u of m) bad.push(`${f}: ${u}`);
    }
    expect(bad).toEqual([]);
  });

  it("every href in the surfaces is an internal path (starts with / or is built with joinUrl)", () => {
    const bad: string[] = [];
    for (const f of surfaces) {
      for (const m of stripComments(read(f)).matchAll(/href=\{?["'`]([^"'`]+)["'`]/g)) {
        if (!m[1].startsWith("/") && !m[1].startsWith("#") && !m[1].startsWith("mailto:")) {
          bad.push(`${f}: ${m[1]}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("no buy-now style call to action in the visible wording", () => {
    const bad: string[] = [];
    for (const f of [...surfaces, "src/app/(app)/picks/text.ts"]) {
      const m = stripComments(read(f)).match(CTA);
      if (m) bad.push(`${f}: ${m[0]}`);
    }
    expect(bad).toEqual([]);
  });

  it("self-test: the patterns catch the things they are meant to catch", () => {
    expect(BROKERS.test("Open in CommSec")).toBe(true);
    expect(BROKERS.test('href="https://www.tradingview.com/chart"')).toBe(true);
    expect(CTA.test("Buy now before it moves")).toBe(true);
    expect(CTA.test("Don't miss this")).toBe(true);
    expect(CTA.test("Buy price hit — ZZ01 (delayed)")).toBe(false);
    expect(CTA.test("Orders are placed by the arena at the next open")).toBe(false);
  });
});

describe("NFR-041 wording: delayed prices, a quote time, never real-time", () => {
  const REAL_TIME = /real[\s\-_]?time/i;

  it("the string real-time (any case or spelling) appears nowhere in src/, except in comments that forbid it", () => {
    const bad: string[] = [];
    for (const f of walk(path.join(ROOT, "src"))) {
      const lines = fs.readFileSync(f, "utf8").split("\n");
      lines.forEach((l, i) => {
        if (!REAL_TIME.test(l)) return;
        const isComment = /^\s*(\/\/|\*|\/\*)/.test(l) || /\s\/\/\s/.test(l);
        const forbids = /\b(never|not|no|nor|without|forbid|forbidden|ban|banned)\b/i.test(l);
        if (!(isComment && forbids)) bad.push(`${rel(f)}:${i + 1}: ${l.trim().slice(0, 100)}`);
      });
    }
    expect(bad).toEqual([]);
  });

  // surface -> files whose text it renders (the page or template plus the shared wording it imports)
  const TEXT = "src/app/(app)/picks/text.ts";
  const SURFACE_TEXT: Array<[string, string[]]> = [
    ["e-mail templates", ["src/lib/email/templates/pickAlerts.ts"]],
    ["IntradaySection", ["src/app/(app)/picks/IntradaySection.tsx", TEXT]],
    ["AlertChip", ["src/app/(app)/picks/AlertChip.tsx"]],
    [
      "company header",
      ["src/app/(app)/market/[code]/page.tsx", "src/app/(app)/picks/AlertChip.tsx", TEXT],
    ],
    ["My alerts", ["src/app/(app)/alerts/page.tsx"]],
  ];
  const QUOTE_TIME = /quote time|quote at|quote\)|quoteTime|hitTime|\(delayed quote\)/i;

  for (const [name, files] of SURFACE_TEXT) {
    it(`${name}: says "delayed" and shows a quote time`, () => {
      const src = files.map((f) => stripComments(read(f))).join("\n");
      expect(src, `${name} must say delayed`).toMatch(/delayed/i);
      expect(src, `${name} must show a quote time`).toMatch(QUOTE_TIME);
    });
  }

  it("the e-mail templates carry the latency line and the quote time on every price", () => {
    const src = read("src/lib/email/templates/pickAlerts.ts");
    expect(src).toMatch(/Prices are delayed/);
    expect(src).toMatch(/\["Quote time"/);
  });

  it("the real-time check catches the spellings it should (self-test)", () => {
    for (const s of ["real-time", "Real time", "REALTIME", "real_time"]) {
      expect(REAL_TIME.test(s)).toBe(true);
    }
    expect(REAL_TIME.test("a delayed quote")).toBe(false);
  });
});
