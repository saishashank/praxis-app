import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DOCS_ALLOW,
  buildSpecIndex,
  listSpecDocs,
  loadModel,
  renderMarkdown,
  renderSpecDoc,
  searchSpecIndex,
} from "@/lib/blueprint/specBrowser";

describe("spec browser", () => {
  it("lists only v1 chapters and the allow-listed docs", () => {
    const docs = listSpecDocs();
    const files = docs.map((d) => d.file);
    expect(files).toContain("spec/01_product_goals_and_scope.md");
    expect(files).toContain("docs/07_decision_log.md");
    for (const d of docs) {
      expect(d.file.startsWith("spec/") || Object.values(DOCS_ALLOW).includes(d.file)).toBe(true);
    }
    expect(files.some((f) => /spec\/(17|18|19)_/.test(f))).toBe(false);
  });

  it("renders a v1 chapter", () => {
    const r = renderSpecDoc("01_product_goals_and_scope");
    expect(r).not.toBeNull();
    expect(r!.html).toMatch(/<h1>/);
  });

  it("refuses unlisted keys (path tricks, V2 chapters)", () => {
    expect(renderSpecDoc("../package")).toBeNull();
    expect(renderSpecDoc("18_blueprint_page")).toBeNull();
  });

  it("maps a known ID to its elements and searches", () => {
    const idx = buildSpecIndex(loadModel());
    expect(idx.get("ROL-102a")!.length).toBeGreaterThan(0);
    const hits = searchSpecIndex(idx, "rol-102");
    expect(hits.some((h) => h.id === "ROL-102a")).toBe(true);
    expect(searchSpecIndex(idx, "zzz-none")).toEqual([]);
    expect(searchSpecIndex(idx, "").length).toBe(idx.size);
  });

  it("sanitises: no script tag or link target passes", () => {
    const html = renderMarkdown(
      [
        "# <script>alert(1)</script>",
        "",
        "<img src=x onerror=alert(1)> [x](javascript:alert(1))",
        "",
        "```",
        "<script>y</script>",
        "```",
        "",
        "| a |",
        "|---|",
        "| <b>z</b> |",
      ].join("\n"),
    );
    expect(html).not.toMatch(/<script|<img|<b>|javascript:/i);
    expect(html).toContain("&lt;script&gt;");
  });

  it("publishes no V2 chapter text: loader reads only spec/ and allow-listed docs", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "src/lib/blueprint/specBrowser.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/Requirement[\\/]v2|praxis-app-data/);
    for (const n of fs.readdirSync(path.join(process.cwd(), "spec"))) {
      expect(/^(0\d|1[0-6])_/.test(n)).toBe(true);
    }
  });
});
