// SEC-016 / UX-008, M8 T4: LLM and third-party text is shown as plain text, and a stored URL is a
// link only when it is https: with a host in the source register; otherwise it is text. Sweeps the
// source for HTML / markdown sinks and unpinned outbound links, then pushes adversarial strings
// through the loaders that read stored text and the components and templates that render it.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NewsAutoSheet } from "@/app/(app)/news/NewsSheet";
import { OverviewSheet } from "@/app/(app)/market/OverviewSheet";
import { renderP0 } from "@/lib/email/templates";
import { isRegisteredSourceHost, safeSourceUrl } from "@/lib/http/safeLink";
import { loadCompany } from "@/lib/ui/loaders/company";
import { loadOverview } from "@/lib/ui/loaders/market";
import { loadNewsItem } from "@/lib/ui/loaders/news";
import { cleanupTempDbs } from "../db/helpers";
import { envOf, fullWorld, type World } from "../loaders/world";
import { ROOT } from "./support";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));

const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
};
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");
const sources = walk(path.join(ROOT, "src")).filter((f) => /\.(ts|tsx)$/.test(f));
const read = (f: string) => fs.readFileSync(f, "utf8");

// ---- static sweep ------------------------------------------------------------------------------

// Hrefs that code supplies (build-time notices file, or a path passed in by page code), never stored text.
const PROP_HREFS = ["{a.href}", "{s.href}", "{c.sortHref}", "{moreHref}", "{href}"];

describe("no code path turns stored text into markup", () => {
  it("has no HTML or markdown sink in src (React escapes every text child)", () => {
    const sink =
      /dangerouslySetInnerHTML|\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write\b|createContextualFragment|DOMParser|ReactMarkdown|react-markdown|markdown-it|\bmarked\(|remark|rehype|sanitize-html|dompurify/i;
    const hits = sources.filter((f) => sink.test(read(f))).map(rel);
    expect(hits).toEqual([]);
  });

  it("depends on no markdown or HTML-rendering library", () => {
    const pkg = JSON.parse(read(path.join(ROOT, "package.json"))) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    const bad = names.filter((n) =>
      /^(marked|markdown-it|react-markdown|remark.*|rehype.*|showdown|snarkdown|micromark.*|mdast.*|html-react-parser|sanitize-html|dompurify)$/.test(
        n,
      ),
    );
    expect(bad).toEqual([]);
  });

  it("every plain <a> in a component is a literal https link, an internal path, or a pinned stored-URL link", () => {
    // The pinned expressions hold a stored third-party URL; their loaders pass it through
    // safeSourceUrl (tested below), so the href is https + registered host or the link is not drawn.
    const PINNED = new Set(["{a.url}", "{item.url}", ...PROP_HREFS]);
    const bad: string[] = [];
    const seenPinned = new Set<string>();
    for (const f of sources.filter((x) => x.endsWith(".tsx"))) {
      for (const m of read(f).matchAll(/<a\b([^>]*?)>/gs)) {
        const attrs = m[1];
        const href = /\bhref=("[^"]*"|\{(?:[^{}]|\{[^{}]*\})*\})/s.exec(attrs)?.[1];
        if (href === undefined) continue;
        const where = `${rel(f)}: <a href=${href}>`;
        const literalHttps = /^"https:\/\/[^"\s]+"$/.test(href);
        const internal = /^"[/#][^"]*"$/.test(href) || /^\{`[/#]/.test(href);
        if (PINNED.has(href)) seenPinned.add(href);
        else if (!literalHttps && !internal) bad.push(where);
        if (
          /target=("_blank"|\{"_blank"\})/.test(attrs) &&
          !/rel="noopener noreferrer"/.test(attrs)
        ) {
          bad.push(`${where} opens a tab without rel="noopener noreferrer"`);
        }
      }
    }
    expect(bad).toEqual([]);
    expect([...seenPinned].sort()).toEqual(["{a.url}", "{item.url}", ...PROP_HREFS].sort());
  });

  it("no stored URL reaches an href except through the loaders that call safeSourceUrl", () => {
    const loadersWithUrl = sources
      .filter((f) => rel(f).startsWith("src/lib/ui/loaders/"))
      .filter((f) => /\burl:\s*(?:string|masked)/.test(read(f)));
    expect(loadersWithUrl.map(rel).sort()).toEqual([
      "src/lib/ui/loaders/company.ts",
      "src/lib/ui/loaders/market.ts",
      "src/lib/ui/loaders/news.ts",
    ]);
    for (const f of loadersWithUrl) expect(read(f), rel(f)).toContain("safeSourceUrl(");
  });
});

// ---- the link rule -----------------------------------------------------------------------------

describe("safeSourceUrl: https + registered host, else not a link", () => {
  const good = [
    "https://www.asx.com.au/asxpdf/20261019/pdf/abc.pdf",
    "https://announcements.asx.com.au/asxpdf/20261019/abc.pdf",
    "https://ASX.COM.AU/x",
    "https://asx.com.au./x",
    "https://news.example.test/doc.pdf",
  ];
  const bad: [string, string][] = [
    ["javascript:alert(1)", "javascript scheme"],
    ["JaVaScRiPt:alert(1)", "mixed-case javascript scheme"],
    ["data:text/html,<script>alert(1)</script>", "data scheme"],
    ["vbscript:msgbox(1)", "vbscript scheme"],
    ["http://www.asx.com.au/x", "plain http"],
    ["//www.asx.com.au/x", "protocol-relative"],
    ["/relative/path", "relative path"],
    ["www.asx.com.au/x", "no scheme"],
    ["https://evil.example/x", "unregistered host"],
    ["https://asx.com.au.evil.example/x", "register host as a prefix of another host"],
    ["https://evilasx.com.au/x", "register host as a suffix of a longer name"],
    ["https://www.asx.com.au@evil.example.test/x", "register host as userinfo"],
    [
      "https://user:pw" + "@www.asx.com.au/x",
      "credentials in the URL",
    ] /* split so the repo-hygiene email scan does not read it as an address */,
    ["https://www.asx.com.au:8443/x", "unusual port"],
    ["https://www.asx.com.au /x", "space"],
    ["https://www.asx.com.au/x\n", "trailing newline"],
    ["https://www.asx.com.au/\tx", "tab inside"],
    ["https://www.asx.com.au/\u0000x", "NUL"],
    ["https://xn--sx-9ka.com.au/x", "punycode look-alike"],
    ["https://www.asx.com.au/" + "a".repeat(2000), "over-long"],
    ["https://", "empty host"],
    ["", "empty string"],
    ["https://localhost/x", "localhost"],
    ["https://127.0.0.1/x", "IP literal"],
    ["https://[::1]/x", "IPv6 literal"],
  ];
  for (const g of good) {
    it(`keeps ${g.slice(0, 60)}`, () => expect(safeSourceUrl(g)).toMatch(/^https:\/\//));
  }
  for (const [b, why] of bad) {
    it(`drops ${why}`, () => expect(safeSourceUrl(b)).toBeNull());
  }
  it("drops anything that is not a string", () => {
    for (const v of [null, undefined, 5, {}, [], ["https://www.asx.com.au/"], true]) {
      expect(safeSourceUrl(v)).toBeNull();
    }
  });
  it("host rule: subdomains of a registered host only", () => {
    expect(isRegisteredSourceHost("a.b.asx.com.au")).toBe(true);
    expect(isRegisteredSourceHost("asx.com.au")).toBe(true);
    expect(isRegisteredSourceHost("com.au")).toBe(false);
    expect(isRegisteredSourceHost("x-asx.com.au")).toBe(false);
    expect(isRegisteredSourceHost("evil.example", ["evil.example"])).toBe(true); // explicit extra host
  });
});

// ---- loaders and components with adversarial stored text ---------------------------------------

const HOSTILE_TITLE = `<img src=x onerror=alert(1)> [click](javascript:alert(1)) ![p](https://evil.example/p.png) <script>alert(2)</script>`;
const HOSTILE_LLM = `**bold** [sign in to verify](https://evil.example/login) <a href="javascript:alert(3)">x</a> &lt;b&gt;`;

describe("stored text goes loader -> component as plain text, and bad URLs lose their link", () => {
  let w: World;
  const ids: Record<string, number> = {};
  const hostileUrls: Record<string, string> = {
    js: "javascript:alert(1)",
    data: "data:text/html,<script>alert(1)</script>",
    http: "http://www.asx.com.au/x",
    other: "https://evil.example/doc.pdf",
    userinfo: "https://www.asx.com.au@evil.example.test/doc.pdf",
    ok: "https://announcements.asx.com.au/asxpdf/x.pdf",
  };

  beforeAll(async () => {
    w = await fullWorld();
    let n = 0;
    for (const [k, url] of Object.entries(hostileUrls)) {
      n++;
      const annId = `h${n}`;
      const r = await w.main.execute({
        sql: `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, price_sensitive, title, url, source)
              VALUES ('AU', 'ZZUP', ?, ?, ?, 'Results', 0, ?, ?, 'src')`,
        args: [
          annId,
          `2026-10-19T03:0${n}:00.000Z`,
          `2026-10-19T03:0${n}:30.000Z`,
          HOSTILE_TITLE,
          url,
        ],
      });
      ids[k] = Number(r.lastInsertRowid);
      await w.main.execute({
        sql: `INSERT INTO item_assessment (source, ann_id, market, code, materiality, rule_version, polarity,
                held, watch, candidate, tracked, assessed_at, text_llm)
              VALUES ('src', ?, 'AU', 'ZZUP', 2, 'materiality-v1', 0, 1, 0, 0, 1, '2026-10-19T04:00:00.000Z', ?)`,
        args: [annId, HOSTILE_LLM],
      });
    }
  });
  afterAll(cleanupTempDbs);
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("loadNewsItem keeps a safe URL and drops every unsafe one", async () => {
    for (const [k, id] of Object.entries(ids)) {
      const item = await loadNewsItem(envOf(w, "owner"), id);
      expect(item, k).not.toBeNull();
      if (k === "ok") expect(item!.url).toBe(hostileUrls.ok);
      else expect(item!.url, k).toBeNull();
    }
  });

  it("loadCompany and loadOverview apply the same rule to every announcement", async () => {
    const company = (await loadCompany(envOf(w, "owner"), "ZZUP"))!;
    const overview = (await loadOverview(envOf(w, "owner"), "ZZUP"))!;
    for (const list of [company.announcements, overview.announcements]) {
      const urls = list.map((a) => a.url).filter((u) => u !== null);
      // the fixture's own https://news.example.test link and the ASX one survive; nothing else
      for (const u of urls) expect(u).toMatch(/^https:\/\/([a-z0-9.-]+\.)?(asx\.com\.au|test)\//);
      expect(urls).toContain(hostileUrls.ok);
      expect(list.some((a) => a.url?.startsWith("javascript:"))).toBe(false);
      expect(list.filter((a) => a.title === HOSTILE_TITLE).length).toBeGreaterThan(0); // kept verbatim
    }
  });

  it("the news pop-up shows title, summary and tag as text; only a safe URL gets a link", async () => {
    for (const [k, id] of Object.entries(ids)) {
      const item = (await loadNewsItem(envOf(w, "owner"), id))!;
      const { container, unmount } = render(
        createElement(NewsAutoSheet, { item, closeHref: "/news" }),
      );
      const dialog = await screen.findByRole("dialog");
      // Nothing from the stored text became an element.
      expect(
        dialog.querySelector("img, script, iframe, style, form, input, object, embed"),
      ).toBeNull();
      expect(document.body.querySelector("script")).toBeNull();
      expect(dialog.textContent).toContain(HOSTILE_TITLE);
      expect(within(dialog).getByTestId("news-sheet-summary").textContent).toBe(HOSTILE_LLM);
      // The only links are the close/original ones; none comes from the stored text.
      const links = [...dialog.querySelectorAll("a")];
      for (const a of links) {
        expect(a.getAttribute("href")).toMatch(/^https:\/\/announcements\.asx\.com\.au\//);
        expect(a.getAttribute("rel")).toBe("noopener noreferrer");
        expect(a.getAttribute("target")).toBe("_blank");
      }
      expect(links.length, k).toBe(k === "ok" ? 1 : 0);
      expect(container.innerHTML).not.toMatch(/javascript:/i);
      unmount();
    }
  });

  it("the overview sheet draws a link only for a safe URL and shows titles as text", async () => {
    const overview = (await loadOverview(envOf(w, "owner"), "ZZUP"))!;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(JSON.parse(JSON.stringify(overview))))),
    );
    render(createElement(OverviewSheet, { slug: "ZZUP", label: "ZZUP" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Company overview for ZZUP" }));
    });
    const dialog = await screen.findByRole("dialog", { name: "Overview: ZZUP" });
    await within(dialog).findAllByText(HOSTILE_TITLE);
    expect(dialog.querySelector("img, script, iframe, style, form, input")).toBeNull();
    const external = [...dialog.querySelectorAll("a")].filter(
      (a) => !(a.getAttribute("href") ?? "").startsWith("/"),
    );
    expect(external.length).toBeGreaterThan(0);
    for (const a of external) {
      expect(a.getAttribute("href")).toMatch(
        /^https:\/\/([a-z0-9.-]+\.)?(announcements\.asx\.com\.au|news\.example\.test)\//,
      );
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    }
  });
});

// ---- email -------------------------------------------------------------------------------------

describe("email HTML comes from templates with escaped fields (SEC-016)", () => {
  const facts = (over: Partial<Parameters<typeof renderP0>[0]["alert"]> = {}) => ({
    env: "production" as const,
    appUrl: "https://praxis.example.test",
    alert: {
      alertKey: "p0:AU:src:n1",
      code: "ZZUP",
      title: HOSTILE_TITLE,
      type: "Trading halt <b>",
      why: HOSTILE_LLM,
      executions: [{ id: "E01", label: "<i>Label</i>", weightPct: 5 }],
      sourceUrl: "https://www.asx.com.au/x",
      time: "Mon 19 Oct 2026 10:42 AEDT",
      ...over,
    },
  });

  it("escapes every field and builds no element from them", () => {
    const out = renderP0(facts());
    for (const body of [out.html]) {
      expect(body).not.toMatch(/<img|<script|<iframe|<b>|<i>|<form/i);
      expect(body).toContain("&lt;img src=x onerror=alert(1)&gt;");
    }
    expect(out.text).toContain("<img src=x onerror=alert(1)>");
  });

  it("never links a javascript: or data: source", () => {
    for (const sourceUrl of ["javascript:alert(1)", "data:text/html,x", "vbscript:x"]) {
      expect(renderP0(facts({ sourceUrl })).html).not.toMatch(/href="(javascript|data|vbscript):/i);
    }
  });
});
