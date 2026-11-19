// M21 C6 (UXN-324 a, D-1320 to D-1324; AT-82, AT-59): the Blueprint diagram is operable by keyboard. One tab stop among the
// nodes, arrow keys move between nodes (left and right across columns, up and down within one), Home and End jump to the
// first and last, Enter and Space open the panel, Escape returns to the viewport; each node draws a focus ring; every edge
// is named and the open node's connections are buttons that highlight their edge. Export links point at the existing route.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlueprintDiagram, moveFocus } from "@/components/blueprint/BlueprintDiagram";
import type { BlueprintStatus } from "@/lib/ui/loaders/blueprint";
import type { BpEdge, BpElement, BpModel } from "@/lib/blueprint/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const el = (id: string, type: string, name: string): BpElement => ({
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
  views: ["platform"],
  source: null,
  attrs: {},
});
const edge = (from: string, to: string, kind = "data"): BpEdge => ({
  id: `${from}|${kind}|${to}`,
  from,
  to,
  kind,
  contract: "Carries the rows.",
  views: ["platform"],
});

// Columns: service (s1, s2) | workflow (w1) | table (t1, t2, t3).
const MODEL: BpModel = {
  schemaVersion: 1,
  views: [
    { id: "platform", name: "Platform" },
    { id: "data", name: "Data" },
  ],
  elements: [
    el("service:s1", "service", "Alpha service"),
    el("service:s2", "service", "Beta service"),
    el("workflow:w1", "workflow", "Gamma workflow"),
    el("table:t1", "table", "Delta table"),
    el("table:t2", "table", "Epsilon table"),
    el("table:t3", "table", "Zeta table"),
  ],
  edges: [
    edge("service:s1", "workflow:w1"),
    edge("service:s2", "workflow:w1", "control"),
    edge("workflow:w1", "table:t1"),
    edge("workflow:w1", "table:t2"),
  ],
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

beforeEach(() => {
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
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const nodes = () => Array.from(document.querySelectorAll<SVGGElement>("[data-node]"));
const nodeId = (e: Element | null) => e?.getAttribute("data-node") ?? null;
const active = () => nodeId(document.activeElement);
const key = (k: string, target: Element | null = document.activeElement) =>
  act(() => {
    fireEvent.keyDown(target!, { key: k });
  });
async function mount() {
  render(
    <BlueprintDiagram
      modelUrl="/api/blueprint/model"
      exportUrl="/api/blueprint/export"
      status={STATUS}
    />,
  );
  await waitFor(() => expect(nodes().length).toBe(6));
}
const byId = (id: string) => nodes().find((n) => nodeId(n) === id)!;
const focusNode = (id: string) => act(() => byId(id).focus());

describe("moveFocus (pure)", () => {
  const laid = [
    { id: "a", x: 40, y: 40 },
    { id: "b", x: 40, y: 100 },
    { id: "c", x: 320, y: 40 },
    { id: "d", x: 600, y: 40 },
    { id: "e", x: 600, y: 100 },
  ];
  it("goes right and left to the adjacent column, to the row nearest in height", () => {
    expect(moveFocus(laid, "b", "ArrowRight")).toBe("c");
    expect(moveFocus(laid, "c", "ArrowRight")).toBe("d");
    expect(moveFocus(laid, "e", "ArrowLeft")).toBe("c");
    expect(moveFocus(laid, "c", "ArrowLeft")).toBe("a");
  });
  it("goes up and down within the column and stops at its ends", () => {
    expect(moveFocus(laid, "a", "ArrowDown")).toBe("b");
    expect(moveFocus(laid, "b", "ArrowDown")).toBe("b");
    expect(moveFocus(laid, "b", "ArrowUp")).toBe("a");
    expect(moveFocus(laid, "a", "ArrowUp")).toBe("a");
    expect(moveFocus(laid, "a", "ArrowLeft")).toBe("a");
  });
  it("Home and End are the first and last in reading order (columns left to right, rows top to bottom)", () => {
    expect(moveFocus(laid, "c", "Home")).toBe("a");
    expect(moveFocus(laid, "c", "End")).toBe("e");
  });
  it("returns null for any other key", () => {
    expect(moveFocus(laid, "a", "x")).toBeNull();
  });
});

describe("Blueprint keyboard", () => {
  it("has exactly one tab stop among the nodes, the first in reading order", async () => {
    await mount();
    const stops = nodes().filter((n) => n.getAttribute("tabindex") === "0");
    expect(stops.map(nodeId)).toEqual(["service:s1"]);
    expect(nodes().filter((n) => n.getAttribute("tabindex") === "-1")).toHaveLength(5);
  });

  it("arrow keys reach every node of the view", async () => {
    await mount();
    focusNode("service:s1");
    const seen = new Set<string>([active()!]);
    const run = (k: string) => {
      for (let i = 0; i < 10; i++) {
        const before = active();
        key(k);
        if (active() === before) break;
        seen.add(active()!);
      }
    };
    for (let col = 0; col < 3; col++) {
      run("ArrowUp");
      run("ArrowDown");
      key("ArrowRight");
      seen.add(active()!);
    }
    expect(Array.from(seen).sort()).toEqual(MODEL.elements.map((e) => e.id).sort());
  });

  it("the roving stop follows the focus, and arrows move focus without panning the diagram", async () => {
    await mount();
    const g = document.querySelector("svg > g")!;
    const before = g.getAttribute("transform");
    focusNode("service:s1");
    key("ArrowRight");
    expect(active()).toBe("workflow:w1");
    expect(
      nodes()
        .filter((n) => n.getAttribute("tabindex") === "0")
        .map(nodeId),
    ).toEqual(["workflow:w1"]);
    expect(g.getAttribute("transform")).toBe(before);
  });

  it("Home and End jump to the first and last node", async () => {
    await mount();
    focusNode("workflow:w1");
    key("End");
    expect(active()).toBe("table:t3");
    key("Home");
    expect(active()).toBe("service:s1");
  });

  it("Enter and Space open the panel", async () => {
    await mount();
    focusNode("service:s1");
    key("Enter");
    expect(await screen.findByTestId("bp-panel")).toBeTruthy();
    cleanup();
    await mount();
    focusNode("service:s1");
    key(" ");
    expect(await screen.findByTestId("bp-panel")).toBeTruthy();
  });

  it("Escape on a node returns focus to the viewport", async () => {
    await mount();
    focusNode("service:s1");
    key("Escape");
    expect(document.activeElement).toBe(screen.getByTestId("bp-viewport"));
  });

  it("draws a focus ring on the focused node only", async () => {
    await mount();
    expect(document.querySelectorAll("[data-focus-ring]")).toHaveLength(0);
    focusNode("service:s1");
    expect(byId("service:s1").querySelector("[data-focus-ring]")).not.toBeNull();
    key("ArrowRight");
    expect(byId("service:s1").querySelector("[data-focus-ring]")).toBeNull();
    expect(document.querySelectorAll("[data-focus-ring]")).toHaveLength(1);
    act(() => (document.activeElement as HTMLElement).blur());
    expect(document.querySelectorAll("[data-focus-ring]")).toHaveLength(0);
  });

  it("gives every node and every edge a screen-reader name", async () => {
    await mount();
    for (const n of nodes()) {
      expect(n.getAttribute("aria-label")).toMatch(/, (service|workflow|table)$/);
    }
    const edges = Array.from(document.querySelectorAll("[data-edge]"));
    expect(edges).toHaveLength(MODEL.edges.length);
    expect(edges.map((g) => g.getAttribute("aria-label"))).toContain(
      "data connection from Alpha service to Gamma workflow",
    );
    for (const g of edges) {
      expect(g.getAttribute("role")).toBe("img");
      expect(g.getAttribute("aria-label")).not.toMatch(/\|/);
    }
  });

  it("lists every edge of the open node as a button that highlights that edge on focus", async () => {
    await mount();
    focusNode("workflow:w1");
    key("Enter");
    const panel = await screen.findByTestId("bp-panel");
    const buttons = within(panel).getAllByRole("button");
    expect(buttons).toHaveLength(4); // all four edges touch the workflow
    for (const b of buttons) {
      expect(document.querySelectorAll('[data-edge-active="true"]')).toHaveLength(0);
      act(() => b.focus());
      expect(document.querySelectorAll('[data-edge-active="true"]')).toHaveLength(1);
      expect(screen.getByTestId("bp-summary").textContent).toMatch(/data|control/);
      act(() => b.blur());
    }
    expect(document.querySelectorAll('[data-edge-active="true"]')).toHaveLength(0);
  });

  it("shows no internal id in a connection button", async () => {
    await mount();
    focusNode("workflow:w1");
    key("Enter");
    const panel = await screen.findByTestId("bp-panel");
    const text = within(panel)
      .getAllByRole("button")
      .map((b) => b.textContent)
      .join("#");
    expect(text).toContain("Alpha service");
    expect(text).not.toMatch(/service:s1|\|data\|/);
  });

  it("offers Export as draw.io and Export as SVG for the shown view", async () => {
    await mount();
    expect(screen.getByRole("link", { name: "Export as draw.io" }).getAttribute("href")).toBe(
      "/api/blueprint/export?view=platform&format=drawio",
    );
    expect(screen.getByRole("link", { name: "Export as SVG" }).getAttribute("href")).toBe(
      "/api/blueprint/export?view=platform&format=svg",
    );
  });
});
