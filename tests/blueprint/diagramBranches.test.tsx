// M21 C6 (UXN-324 a): branch coverage for the Blueprint diagram keyboard code: reveal() scrolling a focused node into the
// viewport (all four sides, and the no-op cases), the roving tab stop fallbacks, pointer hover of nodes, edges and
// connection buttons, and keys the nodes ignore.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlueprintDiagram } from "@/components/blueprint/BlueprintDiagram";
import type { BlueprintStatus } from "@/lib/ui/loaders/blueprint";
import type { BpEdge, BpElement, BpModel } from "@/lib/blueprint/types";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const el = (id: string, type: string, name: string, views = ["platform"]): BpElement => ({
  id,
  type,
  name,
  purpose: `Purpose of ${name}`,
  specIds: ["PLT-001"],
  owner: "app",
  schedule: null,
  inputs: [],
  outputs: [],
  configKeys: [],
  tables: [],
  failure: "f",
  runbook: null,
  views,
  source: null,
  attrs: {},
});
const edge = (from: string, to: string, views = ["platform"]): BpEdge => ({
  id: `${from}|data|${to}`,
  from,
  to,
  kind: "data",
  contract: "Carries the rows.",
  views,
});

// Platform: s1, s2 | w1 | t1. The data view holds s1 only, so w1 is not in it.
const MODEL: BpModel = {
  schemaVersion: 1,
  views: [
    { id: "platform", name: "Platform" },
    { id: "data", name: "Data" },
  ],
  elements: [
    el("service:s1", "service", "Alpha service", ["platform", "data"]),
    el("service:s2", "service", "Beta service"),
    el("workflow:w1", "workflow", "Gamma workflow"),
    el("table:t1", "table", "Delta table"),
  ],
  edges: [edge("service:s1", "workflow:w1"), edge("workflow:w1", "table:t1")],
};
const STATUS = {
  statuses: {},
  runs: {},
  licences: {},
  config: {},
  simulatedLine: "Simulated.",
  freshnessLine: "Status as of now",
  asOf: "2026-11-17T00:00:00Z",
} as unknown as BlueprintStatus;

let clientHeight = 0;
beforeEach(() => {
  clientHeight = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => MODEL })),
  );
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => clientHeight,
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // Remove the override so jsdom's own clientHeight is back for any later test in this worker.
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
});

const nodes = () => Array.from(document.querySelectorAll<SVGGElement>("[data-node]"));
const nodeId = (e: Element | null) => e?.getAttribute("data-node") ?? null;
const byId = (id: string) => nodes().find((n) => nodeId(n) === id)!;
const focusNode = (id: string) => act(() => byId(id).focus());
const keyOn = (target: Element, k: string, times = 1) =>
  act(() => {
    for (let i = 0; i < times; i++) fireEvent.keyDown(target, { key: k });
  });
const viewport = () => screen.getByTestId("bp-viewport");
const stage = () => document.querySelector("svg > g")!.getAttribute("transform")!;
const offset = () => {
  const m = /translate\((-?[\d.]+) (-?[\d.]+)\)/.exec(stage())!;
  return { x: Number(m[1]), y: Number(m[2]) };
};
const stops = () =>
  nodes()
    .filter((n) => n.getAttribute("tabindex") === "0")
    .map(nodeId);
async function mount(count = 4) {
  render(
    <BlueprintDiagram
      modelUrl="/api/blueprint/model"
      exportUrl="/api/blueprint/export"
      status={STATUS}
    />,
  );
  await waitFor(() => expect(nodes().length).toBe(count));
}

describe("reveal: a key move brings the node into view", () => {
  it("does not pan when the viewport has no height yet", async () => {
    await mount();
    const before = stage();
    focusNode("service:s1");
    keyOn(byId("service:s1"), "ArrowRight");
    expect(stage()).toBe(before);
  });

  it("does not pan when the node is already fully visible", async () => {
    clientHeight = 100000;
    await mount();
    const before = stage();
    focusNode("service:s1");
    keyOn(byId("service:s1"), "ArrowRight");
    expect(document.activeElement).toBe(byId("workflow:w1"));
    expect(stage()).toBe(before);
  });

  it("pans up when the node is below the bottom edge", async () => {
    clientHeight = 20;
    await mount();
    const before = offset();
    focusNode("service:s1");
    keyOn(byId("service:s1"), "ArrowDown");
    expect(document.activeElement).toBe(byId("service:s2"));
    expect(offset().y).toBeLessThan(before.y);
  });

  it("pans down when the node is above the top edge", async () => {
    clientHeight = 100000;
    await mount();
    keyOn(viewport(), "ArrowDown", 30); // the diagram moves up by 1200
    const before = offset();
    focusNode("service:s1");
    keyOn(byId("service:s1"), "ArrowRight");
    expect(offset().y).toBeGreaterThan(before.y);
  });

  it("pans right when the node is left of the viewport", async () => {
    clientHeight = 100000;
    await mount();
    keyOn(viewport(), "ArrowRight", 40); // the diagram moves left by 1600
    const before = offset();
    focusNode("service:s1");
    keyOn(byId("service:s1"), "ArrowRight");
    expect(offset().x).toBeGreaterThan(before.x);
  });

  it("pans left when the node is right of the viewport", async () => {
    clientHeight = 100000;
    await mount();
    keyOn(viewport(), "ArrowLeft", 40); // the diagram moves right by 1600
    const before = offset();
    focusNode("service:s1");
    keyOn(byId("service:s1"), "ArrowRight");
    expect(offset().x).toBeLessThan(before.x);
  });
});

describe("node keys and the roving stop", () => {
  it("ignores keys that are not navigation keys", async () => {
    await mount();
    focusNode("service:s1");
    const before = stage();
    keyOn(byId("service:s1"), "x");
    keyOn(byId("service:s1"), "Tab");
    expect(document.activeElement).toBe(byId("service:s1"));
    expect(stage()).toBe(before);
    expect(screen.queryByTestId("bp-panel")).toBeNull();
  });

  it("uses the open node as the tab stop, then the first node when it is not in the view", async () => {
    await mount();
    fireEvent.click(byId("workflow:w1"));
    expect(await screen.findByTestId("bp-panel")).toBeTruthy();
    expect(stops()).toEqual(["workflow:w1"]);
    fireEvent.click(screen.getByRole("tab", { name: "Data", hidden: true }));
    await waitFor(() => expect(nodes()).toHaveLength(1));
    expect(stops()).toEqual(["service:s1"]);
  });

  it("drops a stale roving stop when the view changes", async () => {
    await mount();
    focusNode("workflow:w1");
    expect(stops()).toEqual(["workflow:w1"]);
    fireEvent.click(screen.getByRole("tab", { name: "Data", hidden: true }));
    await waitFor(() => expect(nodes()).toHaveLength(1));
    expect(stops()).toEqual(["service:s1"]);
  });

  it("has no tab stop and no nodes in a view with nothing in it", async () => {
    const empty: BpModel = { ...MODEL, elements: [], edges: [] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => empty })),
    );
    await mount(0);
    await screen.findByTestId("bp-viewport");
    expect(stops()).toEqual([]);
  });

  it("keeps the ring on the newly focused node when the previous one blurs", async () => {
    await mount();
    focusNode("service:s1");
    focusNode("workflow:w1");
    expect(document.querySelectorAll("[data-focus-ring]")).toHaveLength(1);
    expect(byId("workflow:w1").querySelector("[data-focus-ring]")).not.toBeNull();
  });
});

describe("pointer hover", () => {
  it("hovering an edge lights it and leaving clears it", async () => {
    await mount();
    const g = document.querySelector<SVGGElement>("[data-edge]")!;
    fireEvent.pointerEnter(g);
    expect(g.getAttribute("data-edge-active")).toBe("true");
    expect(g.querySelector("path")!.getAttribute("stroke-width")).toBe("3");
    fireEvent.pointerLeave(g);
    expect(g.getAttribute("data-edge-active")).toBeNull();
    expect(g.querySelector("path")!.getAttribute("stroke-width")).toBe("1.5");
  });

  it("hovering a node shows its summary and leaving clears it", async () => {
    await mount();
    fireEvent.pointerEnter(byId("service:s2"));
    expect(screen.getByTestId("bp-summary").textContent).toContain("Beta service");
    fireEvent.pointerLeave(byId("service:s2"));
    expect(screen.getByTestId("bp-summary").textContent).not.toContain("Beta service");
  });

  it("hovering or leaving a connection button lights and clears its edge", async () => {
    await mount();
    focusNode("workflow:w1");
    keyOn(byId("workflow:w1"), "Enter");
    const panel = await screen.findByTestId("bp-panel");
    const [b] = within(panel).getAllByTestId("bp-connection");
    fireEvent.pointerEnter(b);
    expect(document.querySelectorAll('[data-edge-active="true"]')).toHaveLength(1);
    fireEvent.pointerLeave(b);
    expect(document.querySelectorAll('[data-edge-active="true"]')).toHaveLength(0);
  });

  it("words connection buttons by direction", async () => {
    await mount();
    focusNode("workflow:w1");
    keyOn(byId("workflow:w1"), "Enter");
    const panel = await screen.findByTestId("bp-panel");
    const texts = within(panel)
      .getAllByTestId("bp-connection")
      .map((b) => b.textContent ?? "");
    expect(texts.some((t) => t.startsWith("from Alpha service"))).toBe(true);
    expect(texts.some((t) => t.startsWith("to Delta table"))).toBe(true);
  });
});

describe("other branches of the changed code", () => {
  it("a blur that is not from the ringed node leaves the ring in place", async () => {
    await mount();
    focusNode("service:s1");
    fireEvent.blur(byId("workflow:w1"));
    expect(byId("service:s1").querySelector("[data-focus-ring]")).not.toBeNull();
  });

  it("names the view by its id when the model does not list it", async () => {
    const odd: BpModel = { ...MODEL, views: [{ id: "other", name: "Other" }] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => odd })),
    );
    render(
      <BlueprintDiagram
        modelUrl="/api/blueprint/model"
        exportUrl="/api/blueprint/export"
        status={STATUS}
      />,
    );
    await screen.findByTestId("bp-viewport");
    expect(screen.getByRole("link", { name: "Export as SVG" }).getAttribute("href")).toContain(
      "view=platform",
    );
  });

  it("shows a placeholder for an edge with no contract text", async () => {
    const bare: BpModel = {
      ...MODEL,
      edges: MODEL.edges.map((g) => ({ ...g, contract: "" })),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => bare })),
    );
    await mount();
    fireEvent.pointerEnter(document.querySelector("[data-edge]")!);
    expect(screen.getByTestId("bp-summary").textContent).toContain("No contract text.");
  });

  it("the Spec tab goes to the spec browser", async () => {
    await mount();
    fireEvent.click(screen.getByRole("tab", { name: "Spec" }));
    expect(push).toHaveBeenCalledWith("?tab=spec");
  });

  it("a search dims the elements that do not match", async () => {
    await mount();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Alpha" } });
    expect(byId("service:s1").getAttribute("opacity")).toBe("1");
    expect(byId("service:s2").getAttribute("opacity")).toBe("0.35");
  });
});
