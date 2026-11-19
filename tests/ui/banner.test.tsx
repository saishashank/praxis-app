// M21 C5 (UXN-320 d, D-1205, D-1315): each Banner tone sits on its own muted band token, and the status strip's
// neutral state sits on the neutral band; the mood gradient replaces it only when a mood is given.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Banner, StaleBanner } from "@/components/ui/States";
import { StatusStrip } from "@/components/ui/StatusStrip";
import { staleness } from "@/lib/view/staleness";
import palette from "@/styles/palette.tokens.json";

describe("Banner bands", () => {
  it("info, warning and stale tones use their own band token; danger keeps the plain surface", () => {
    render(
      <>
        <Banner>Info</Banner>
        <Banner tone="warning">Warn</Banner>
        <Banner tone="stale">Old</Banner>
        <Banner tone="danger">Bad</Banner>
      </>,
    );
    const band = (t: string) => screen.getByText(t).closest("[data-band]");
    expect(band("Info")?.getAttribute("data-band")).toBe("info");
    expect(band("Info")?.className).toContain("bg-[var(--band-info)]");
    expect(band("Warn")?.getAttribute("data-band")).toBe("warn");
    expect(band("Warn")?.className).toContain("bg-[var(--band-warn)]");
    expect(band("Old")?.getAttribute("data-band")).toBe("stale");
    expect(band("Old")?.className).toContain("bg-[var(--band-stale)]");
    expect(screen.getByText("Bad").closest("[data-band]")).toBeNull();
  });

  it("the stale banner for old data is the stale band and still an alert", () => {
    const now = new Date("2026-10-20T03:00:00Z");
    render(<StaleBanner status={staleness("2026-10-18T02:50:00Z", now, 60)} />);
    const el = screen.getByRole("alert");
    expect(el.getAttribute("data-band")).toBe("stale");
  });

  it("the status strip is on the neutral band without a mood and on the gradient with one", () => {
    const { container, rerender } = render(
      <StatusStrip label="Status" items={[{ label: "Data", value: "End of day" }]} />,
    );
    const strip = container.querySelector("section")!;
    expect(strip.getAttribute("data-band")).toBe("neutral");
    expect(strip.className).toContain("bg-[var(--band-neutral)]");
    rerender(
      <StatusStrip
        label="Status"
        items={[{ label: "Data", value: "End of day" }]}
        mood={{ key: "on", word: "Risk-on" }}
      />,
    );
    expect(container.querySelector("section")!.hasAttribute("data-band")).toBe(false);
  });

  it("the palette declares the four band tokens in every theme", () => {
    for (const theme of Object.keys(palette.themes)) {
      const t = (palette.themes as Record<string, Record<string, string>>)[theme];
      for (const b of ["info", "warn", "stale", "neutral"]) {
        expect(t[`--band-${b}`], `${theme} --band-${b}`).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });
});
