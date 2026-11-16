// M21 C1 (UXN-008, D-1232): SectionLoading shows a shaped skeleton of the arriving layout; the label stays as the
// one status, as screen-reader text; nothing is animated, so there is nothing to switch off for Motion: Off.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SectionLoading } from "@/app/(app)/market/sections";

afterEach(cleanup);

describe("SectionLoading", () => {
  it.each([
    ["rows", 5],
    ["tiles", 4],
    ["chart", 1],
  ] as const)("shape %s draws its bars", (shape, min) => {
    const { container } = render(<SectionLoading label="Loading the sectors" shape={shape} />);
    expect(container.querySelectorAll('[data-skeleton="bar"]').length).toBeGreaterThanOrEqual(min);
    expect(container.querySelector(`[data-skeleton-shape="${shape}"]`)).not.toBeNull();
  });
  it("is one status; the label is its only text, and the bars are hidden from assistive tech", () => {
    const { container } = render(<SectionLoading label="Loading the sectors" shape="rows" />);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toBe("Loading the sectors");
    for (const b of container.querySelectorAll('[data-skeleton="bar"]'))
      expect(b.closest('[aria-hidden="true"]')).not.toBeNull();
  });
  it("defaults to rows and never animates", () => {
    const { container } = render(<SectionLoading label="Loading" />);
    expect(container.querySelector('[data-skeleton-shape="rows"]')).not.toBeNull();
    expect(container.innerHTML).not.toMatch(/animate-|infinite/);
  });
});
