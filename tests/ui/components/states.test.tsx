// C12 shared illustration and empty state (UXR-007, UXR-055): sentence + svg in the section colour.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Illustration } from "@/components/ui/Illustration";
import { EmptyState } from "@/components/ui/States";

describe("EmptyState", () => {
  it("renders the sentence, an action and an aria-hidden svg in the section colour", () => {
    const { container } = render(
      <EmptyState title="No alerts" motif="alerts" hue="news" action={<a href="/x">Open</a>}>
        Urgent alerts will appear here first.
      </EmptyState>,
    );
    expect(screen.getByText("No alerts")).toBeInTheDocument();
    expect(screen.getByText("Urgent alerts will appear here first.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open" })).toBeInTheDocument();
    const svg = container.querySelector("svg[data-illustration='alerts']");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(container.innerHTML).toContain("var(--color-section-news)");
  });
  it("a hue stem that is not a section uses its -fill token; every motif draws", () => {
    const { container } = render(<Illustration motif="picks" hue="family-br" />);
    expect(container.innerHTML).toContain("var(--color-family-br-fill)");
    for (const m of [
      "picks",
      "market",
      "strategies",
      "news",
      "reviews",
      "home",
      "alerts",
      "list",
      "check",
    ] as const) {
      const r = render(<Illustration motif={m} />);
      expect(r.container.querySelector(`svg[data-illustration='${m}']`)).not.toBeNull();
    }
  });
});
