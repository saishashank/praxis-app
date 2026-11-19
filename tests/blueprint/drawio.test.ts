// @vitest-environment node
// AT-59 (UXN-324 (c), M18 TST-135 (c), D-967): the exported .drawio file, parsed back, IS the model. For every
// view the nodes are exactly the model's elements of that view (same ids, same names), the edges are exactly
// the model's edges whose two ends are in the view (same from, to and kind), and every cell id is unique and
// resolves. The visual look of the diagram is an Owner-run check (docs/owner-guide/owner_checks.md).
// @ts-expect-error jsdom ships no types in this repo
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import model from "../../docs/architecture/architecture.json";
import { toDrawio, type ExportModel } from "@/lib/blueprint/export";

const m = model as unknown as ExportModel;
const parse = (xml: string) => {
  const doc = new new JSDOM("").window.DOMParser().parseFromString(xml, "application/xml");
  expect(doc.getElementsByTagName("parsererror").length).toBe(0);
  return doc;
};

describe("the exported draw.io file equals the model (per view)", () => {
  it("the model is not empty: views, elements and edges exist", () => {
    expect(m.views.length).toBeGreaterThanOrEqual(8);
    expect(m.elements.length).toBeGreaterThan(100);
    expect(m.edges.length).toBeGreaterThan(100);
  });

  for (const v of m.views) {
    it(`${v.id}: node ids and names, edge ends and kinds, and cell ids all match`, () => {
      const doc = parse(toDrawio(m, v.id));
      const cells = [...doc.getElementsByTagName("mxCell")];
      const vertices = cells.filter((c) => c.getAttribute("vertex") === "1");
      const edges = cells.filter((c) => c.getAttribute("edge") === "1");

      const inView = m.elements.filter((e) => e.views.includes(v.id));
      const wantNodes = inView.map((e) => `${e.id}|${e.name}`).sort();
      const gotNodes = vertices
        .map((c) => `${c.getAttribute("tooltip")}|${c.getAttribute("value")}`)
        .sort();
      expect(gotNodes).toEqual(wantNodes);
      expect(vertices.length).toBe(inView.length);

      const ids = new Set(inView.map((e) => e.id));
      const wantEdges = m.edges
        .filter((e) => e.views.includes(v.id) && ids.has(e.from) && ids.has(e.to))
        .map((e) => `${e.from}>${e.to}|${e.kind}`)
        .sort();
      const tooltipOf = new Map(
        vertices.map((c) => [c.getAttribute("id"), c.getAttribute("tooltip")]),
      );
      const gotEdges = edges
        .map(
          (c) =>
            `${tooltipOf.get(c.getAttribute("source"))}>${tooltipOf.get(c.getAttribute("target"))}|${c.getAttribute("value")}`,
        )
        .sort();
      expect(gotEdges).toEqual(wantEdges);
      expect(edges.length).toBe(wantEdges.length);

      const cellIds = cells.map((c) => c.getAttribute("id"));
      expect(new Set(cellIds).size).toBe(cellIds.length);
      for (const e of edges) {
        expect(tooltipOf.has(e.getAttribute("source")), "edge source is a node").toBe(true);
        expect(tooltipOf.has(e.getAttribute("target")), "edge target is a node").toBe(true);
      }
    });
  }

  it("every model element with a view appears in at least one exported file, and none is invented", () => {
    const exported = new Set<string>();
    for (const v of m.views) {
      const doc = parse(toDrawio(m, v.id));
      for (const c of doc.getElementsByTagName("mxCell")) {
        if (c.getAttribute("vertex") === "1") exported.add(c.getAttribute("tooltip")!);
      }
    }
    const want = new Set(m.elements.filter((e) => e.views.length > 0).map((e) => e.id));
    expect(exported).toEqual(want);
  });

  it("a planted extra element changes the count the test reads (the check is not vacuous)", () => {
    const view = m.views[0]!.id;
    const planted: ExportModel = {
      ...m,
      elements: [
        ...m.elements,
        { id: "zz:planted", type: "service", name: "ZZ planted", views: [view] },
      ],
    };
    const before = parse(toDrawio(m, view)).getElementsByTagName("mxCell").length;
    expect(parse(toDrawio(planted, view)).getElementsByTagName("mxCell").length).toBe(before + 1);
  });
});
