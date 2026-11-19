// M21 C7 (UXN-255, D-1201; AT-82): family groups above the Strategies grid. The component renders no tile, so
// nothing can be hidden by a group; the groups hold links only.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FamilyGroups, type FamilyGroupTile } from "@/app/(app)/strategies/FamilyGroups";

afterEach(cleanup);

const tiles: FamilyGroupTile[] = [
  { execution: "E01", family: "F1", name: "Breakout", moneyType: "Plain shares" },
  { execution: "E02", family: "F1", name: "Breakout", moneyType: "With leverage sleeve" },
  { execution: "E03", family: "F4", name: "Bounce", moneyType: "Plain shares" },
];

describe("FamilyGroups", () => {
  it("makes one closed group per family with a count and a link per strategy", () => {
    const { container } = render(<FamilyGroups tiles={tiles} />);
    expect(screen.getByRole("heading", { level: 2, name: "Group by family" })).toBeInTheDocument();
    const groups = container.querySelectorAll("details[data-family-group]");
    expect(groups).toHaveLength(2);
    for (const g of groups) expect((g as HTMLDetailsElement).open).toBe(false);
    expect(screen.getByText("Breakout (2 strategies)")).toBeInTheDocument();
    expect(screen.getByText("Bounce (1 strategy)")).toBeInTheDocument();
    expect(container.querySelectorAll("a")).toHaveLength(3);
  });
  it("holds links only, whether open or closed: no tile is drawn or removed by a group", () => {
    for (const open of [false, true]) {
      const { container } = render(<FamilyGroups tiles={tiles} open={open} />);
      expect(container.querySelectorAll("[data-strategy-tile]")).toHaveLength(0);
      expect(container.querySelectorAll("details[open]")).toHaveLength(open ? 2 : 0);
      const link = within(container).getByText("Breakout, with leverage sleeve");
      expect(link).toHaveAttribute("href", "#tile-E02");
      cleanup();
    }
  });
  it("renders nothing without tiles and shows no family code", () => {
    const { container } = render(<FamilyGroups tiles={[]} />);
    expect(container).toBeEmptyDOMElement();
    cleanup();
    const r = render(<FamilyGroups tiles={tiles} open />);
    expect(r.container.textContent).not.toMatch(/\bF\d\b/);
  });
});
