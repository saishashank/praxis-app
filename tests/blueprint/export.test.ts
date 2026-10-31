// @vitest-environment node
// AT-59 (b): the drawio writer and SVG serializer; the export route (api/blueprint/export) guard order.
// @ts-expect-error jsdom ships no types in this repo
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import model from "../../docs/architecture/architecture.json";
import { toDrawio, toSvg, type ExportModel } from "@/lib/blueprint/export";
// @ts-expect-error plain .mjs module without types
import { findSecretShapes } from "../../scripts/architecture/schema.mjs";

const guard = vi.hoisted(() => ({ calls: [] as string[], deny: false }));
vi.mock("@/lib/auth/blueprintGuard", () => ({
  NOINDEX_HEADERS: { "X-Robots-Tag": "noindex, nofollow", "Cache-Control": "no-store" },
  requirePinnedOwnerRoute: async (route: string, event: string) => {
    guard.calls.push(`${route}|${event}`);
    if (guard.deny) throw new Error("NEXT_NOT_FOUND");
    return { id: "u1" };
  },
}));

const m = model as unknown as ExportModel;
const parse = (xml: string, type: "application/xml" | "image/svg+xml" = "application/xml") => {
  const dom = new JSDOM("");
  const doc = new dom.window.DOMParser().parseFromString(xml, type);
  expect(doc.getElementsByTagName("parsererror").length).toBe(0);
  return doc;
};

describe("export writers", () => {
  for (const v of m.views) {
    const els = m.elements.filter((e) => e.views.includes(v.id)).length;
    const edges = m.edges.filter((e) => e.views.includes(v.id)).length;
    it(`${v.id}: drawio is valid XML with the view's ${els} nodes and ${edges} edges`, () => {
      const doc = parse(toDrawio(m, v.id));
      expect(doc.documentElement.tagName).toBe("mxfile");
      const cells = [...doc.getElementsByTagName("mxCell")];
      expect(cells.filter((c) => c.getAttribute("vertex") === "1").length).toBe(els);
      const es = cells.filter((c) => c.getAttribute("edge") === "1");
      expect(es.length).toBe(edges);
      const ids = new Set(cells.map((c) => c.getAttribute("id")));
      expect(ids.size).toBe(cells.length);
      for (const e of es) {
        expect(ids.has(e.getAttribute("source"))).toBe(true);
        expect(ids.has(e.getAttribute("target"))).toBe(true);
      }
    });
    it(`${v.id}: svg is standalone with the same counts`, () => {
      const svg = toSvg(m, v.id);
      const doc = parse(svg, "image/svg+xml");
      expect(doc.getElementsByTagName("g").length).toBe(els);
      expect(doc.getElementsByTagName("line").length).toBe(edges);
      expect(svg).not.toMatch(
        /href=|<image|<script|url\((?!#)|@import|https?:\/\/(?!www\.w3\.org)/,
      );
    });
    it(`${v.id}: deterministic, no secret-shaped strings`, () => {
      expect(toDrawio(m, v.id)).toBe(toDrawio(m, v.id));
      expect(toSvg(m, v.id)).toBe(toSvg(m, v.id));
      expect(findSecretShapes(toDrawio(m, v.id))).toEqual([]);
      expect(findSecretShapes(toSvg(m, v.id))).toEqual([]);
    });
  }
  it("rejects an unknown view", () => {
    expect(() => toDrawio(m, "nope")).toThrow();
    expect(() => toSvg(m, "nope")).toThrow();
  });
});

describe("GET /api/blueprint/export", () => {
  const get = async (qs: string) => {
    const { GET } = await import("@/app/api/blueprint/export/route");
    return GET(new Request(`http://localhost/api/blueprint/export${qs}`));
  };
  it("serves an attachment, no-store and noindex, audited as blueprint.export", async () => {
    guard.deny = false;
    guard.calls.length = 0;
    const res = await get("?view=platform&format=drawio");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="blueprint-platform.drawio"',
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    expect(guard.calls).toEqual(["/api/blueprint/export|blueprint.export"]);
    const svg = await get("?view=data&format=svg");
    expect(svg.headers.get("content-type")).toContain("image/svg+xml");
  });
  it("400 on a bad view or format", async () => {
    guard.deny = false;
    expect((await get("?view=x&format=svg")).status).toBe(400);
    expect((await get("?view=platform&format=pdf")).status).toBe(400);
    expect((await get("")).status).toBe(400);
  });
  it("refuses a non-owner through the guard before looking at the query", async () => {
    guard.deny = true;
    await expect(get("?view=bad&format=bad")).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(get("?view=platform&format=svg")).rejects.toThrow("NEXT_NOT_FOUND");
    guard.deny = false;
  });
});
