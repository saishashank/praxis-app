// UXN-030 readability: Flesch-Kincaid grade <= 8 over headings, labels, buttons and [data-summary]
// text of every owner-visible registry page, rendered with the POPULATED seed (E2E_SCENARIO=populated).
// Glossary terms (UXN-031/032) and numbers are excluded; Owner-reviewed exceptions are listed in
// e2e/readability-exceptions.json and printed with the report.
import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { GLOSSARY } from "../src/app/(app)/reviews/glossary/entries";
import { TERMS } from "../src/lib/view/terms";
import type { Exception, Item, PageItems } from "../scripts/ci/readability.mjs";
import { importEsm } from "./esm";
import { PAGES, allowedRoles } from "./pages";
import { signIn } from "./helpers";
import exceptionsFile from "./readability-exceptions.json";

test.skip(
  process.env.E2E_SCENARIO !== "populated",
  "readability runs on the populated seed (E2E_SCENARIO=populated)",
);

const splitTerms = (s: string) => s.split(/\s+\/\s+/);
const TERM_LIST = [
  ...TERMS.flatMap((t) => [...splitTerms(t.shown), ...splitTerms(t.official)]),
  ...GLOSSARY.flatMap((g) => [g.term, ...(g.official ? splitTerms(g.official) : [])]),
];

async function collect(page: import("@playwright/test").Page): Promise<Item[]> {
  return page.evaluate(() => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    const clean = (s: string | null) => (s ?? "").replace(/\s+/g, " ").trim();
    const out: { kind: "heading" | "label" | "button" | "summary"; text: string }[] = [];
    const add = (sel: string, kind: "heading" | "label" | "button" | "summary") => {
      for (const el of Array.from(document.querySelectorAll(sel))) {
        if (!visible(el)) continue;
        let raw: string | null;
        if (kind === "button" && el.getAttribute("aria-label")) raw = el.getAttribute("aria-label");
        else if (kind === "label") {
          // The label's own words, not the options of a select it wraps.
          const copy = el.cloneNode(true) as HTMLElement;
          copy.querySelectorAll("select, option, textarea, input").forEach((n) => n.remove());
          raw = copy.textContent;
        } else raw = (el as HTMLElement).innerText;
        const text = clean(raw);
        if (text) out.push({ kind, text });
      }
    };
    add("h1, h2, h3, h4, h5, h6", "heading");
    add("label", "label");
    add("button, [role='button']", "button");
    add("[data-summary]", "summary");
    return out;
  });
}

test("headings, labels, buttons and summaries read at grade 8 or below", async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  const { analyse, report } = await importEsm<typeof import("../scripts/ci/readability.mjs")>(
    "scripts/ci/readability.mjs",
  );
  await signIn(context, "owner");
  const pages: PageItems[] = [];
  for (const entry of PAGES) {
    if (entry.needsData || entry.path === "/signin") continue;
    if (!allowedRoles(entry).includes("owner")) continue;
    const res = await page.goto(entry.path);
    if (!res || res.status() !== 200) continue;
    await page.waitForLoadState("networkidle").catch(() => {});
    const items = await collect(page);
    const seen = new Set<string>();
    const unique = items.filter((i) => {
      const k = `${i.kind}|${i.text}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    pages.push({ path: entry.path, items: unique });
  }
  expect(pages.length).toBeGreaterThan(5);

  const outDir = path.join("test-results");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "readability-collected.json"),
    JSON.stringify({ terms: TERM_LIST, pages }, null, 2),
  );

  const result = analyse(pages, {
    terms: TERM_LIST,
    exceptions: (exceptionsFile.exceptions ?? []) as Exception[],
  });
  console.log(report(result));
  expect(result.failures, report(result)).toEqual([]);
});
