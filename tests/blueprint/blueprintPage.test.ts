// M16 WP5: layout determinism, search, and the "model is never bundled" rule (D-372).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { layoutView, NODE_H, NODE_W } from "@/lib/blueprint/layout";
import { searchElements } from "@/lib/blueprint/search";
import type { BpEdge, BpElement } from "@/lib/blueprint/types";

const el = (id: string, over: Partial<BpElement> = {}): BpElement => ({
  id,
  type: id.split(":")[0],
  name: id.split(":")[1],
  purpose: "p",
  specIds: ["PLT-001"],
  owner: "app",
  schedule: null,
  inputs: [],
  outputs: [],
  configKeys: [],
  tables: [],
  failure: "f",
  runbook: null,
  views: ["platform"],
  source: null,
  attrs: {},
  ...over,
});
const edge = (from: string, to: string): BpEdge => ({
  id: `${from}|data|${to}`,
  from,
  to,
  kind: "data",
  contract: "c",
  views: ["platform"],
});

const els = [
  el("table:b"),
  el("service:z"),
  el("table:a", { specIds: ["DAT-125a"] }),
  el("page:p", { views: ["data"] }),
  el("service:y", { name: "Ingest worker" }),
];
const edges = [edge("service:z", "table:a"), edge("table:a", "table:b")];

describe("layoutView", () => {
  it("is deterministic and independent of input order", () => {
    const a = layoutView("platform", els, edges);
    const b = layoutView("platform", [...els].reverse(), [...edges].reverse());
    expect(b).toEqual(a);
  });
  it("puts types in columns and sorts rows by id", () => {
    const l = layoutView("platform", els, edges);
    const pos = Object.fromEntries(l.nodes.map((n) => [n.el.id, [n.x, n.y]]));
    expect(pos["service:y"][0]).toBe(pos["service:z"][0]);
    expect(pos["service:y"][1]).toBeLessThan(pos["service:z"][1]);
    expect(pos["table:a"][0]).toBeGreaterThan(pos["service:z"][0]);
    expect(pos["table:a"][1]).toBeLessThan(pos["table:b"][1]);
    expect(l.nodes.some((n) => n.el.id === "page:p")).toBe(false);
  });
  it("connects node sides", () => {
    const l = layoutView("platform", els, edges);
    const z = l.nodes.find((n) => n.el.id === "service:z")!;
    const g = l.edges.find((e) => e.edge.from === "service:z")!;
    expect(g.x1).toBe(z.x + NODE_W);
    expect(g.y1).toBe(z.y + NODE_H / 2);
  });
});

describe("searchElements", () => {
  it("finds by spec id, name and id, spec id first", () => {
    expect(searchElements(els, "dat-125a").map((e) => e.id)).toEqual(["table:a"]);
    expect(searchElements(els, "ingest").map((e) => e.id)).toEqual(["service:y"]);
    expect(searchElements(els, "table:b").map((e) => e.id)).toEqual(["table:b"]);
    expect(searchElements(els, "PLT-001")).toHaveLength(4);
  });
  it("returns nothing for a blank or unknown query and honours the limit", () => {
    expect(searchElements(els, "  ")).toEqual([]);
    expect(searchElements(els, "zzzz")).toEqual([]);
    expect(searchElements(els, "plt", 2)).toHaveLength(2);
  });
});

describe("the model is never bundled (D-372)", () => {
  const walk = (d: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f, out);
      else if (/\.(tsx?|mjs|js)$/.test(e.name)) out.push(f);
    }
    return out;
  };
  const files = walk(path.join(process.cwd(), "src")).filter((f) => !/\.test\.tsx?$/.test(f));
  const rel = (f: string) => path.relative(process.cwd(), f).split(path.sep).join("/");

  it("only the model route names architecture.json, and no client module does", () => {
    const naming = files.filter((f) => fs.readFileSync(f, "utf8").includes("architecture.json"));
    expect(naming.map(rel)).toEqual([
      "src/app/api/blueprint/export/route.ts",
      "src/app/api/blueprint/model/route.ts",
      "src/lib/blueprint/specBrowser.ts",
    ]);
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      if (/^\s*["']use client["']/m.test(src.slice(0, 200)))
        expect(src, rel(f)).not.toMatch(/architecture\.json|docs\/architecture/);
    }
  });
  it("no client module or component imports the docs/architecture folder", () => {
    for (const f of files.filter((x) => rel(x).startsWith("src/components/")))
      expect(fs.readFileSync(f, "utf8"), rel(f)).not.toMatch(/from\s+["'][^"']*docs\/architecture/);
  });
  it("the client diagram carries no blueprint URL literal", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "src/components/blueprint/BlueprintDiagram.tsx"),
      "utf8",
    );
    expect(src).not.toMatch(/["'`]\/(api\/)?blueprint/);
  });
});
