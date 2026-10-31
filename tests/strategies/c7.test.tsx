// C7 Strategies (UXR-023, 010, 045, 052, 054): NAV bar with the start marker, state pill words, tab
// cues, the risk confirmation sheet as the only red place, and the signed outcome bars.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NavBar } from "@/app/(app)/strategies/NavBar";
import { OutcomeBars } from "@/app/(app)/strategies/OutcomeBars";
import { tileState } from "@/app/(app)/strategies/state";
import { StrategyTabs } from "@/app/(app)/strategies/StrategyTabs";
import { ControlButton } from "@/app/(app)/strategies/risk/ControlButton";
import { Pill } from "@/components/ui/Pill";

vi.mock("next/navigation", () => ({ usePathname: () => "/strategies" }));

beforeAll(async () => {
  await import("@/components/ui/SheetPanel");
}, 60_000);
afterEach(cleanup);

describe("NavBar", () => {
  it("marks the A$600 start on a bar from A$300 to A$1,200 and fills in the gain colour above it", () => {
    const { container } = render(<NavBar label="Follow the trend" navCents={75_000} />);
    const marker = container.querySelector("[data-nav-start]") as HTMLElement;
    expect(parseFloat(marker.style.left)).toBeCloseTo(33.33, 1); // (600-300)/(1200-300)
    expect(screen.getByText("Start A$600.00")).toBeInTheDocument();
    expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(/A\$750\.00.*start A\$600/);
    const fill = container.querySelector("[data-nav-fill]") as HTMLElement;
    expect(fill.getAttribute("data-hue")).toBe("positive");
  });
  it("uses the loss colour below the start and never a grey fill for a signed value", () => {
    const { container } = render(<NavBar label="x" navCents={45_000} />);
    expect(container.querySelector("[data-nav-fill]")?.getAttribute("data-hue")).toBe("negative");
  });
  it("draws no fill when the value is unknown", () => {
    const { container } = render(<NavBar label="x" navCents={null} />);
    expect(container.querySelector("[data-nav-fill]")).toBeNull();
    expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(/not measured yet/);
  });
});

describe("state pill", () => {
  const base = { hasCohort: true, stage: "seed", control: "enabled" } as const;
  it.each([
    [base, "running", "Running"],
    [{ ...base, control: "paused" }, "paused", "Paused"],
    [{ ...base, stage: "target" }, "target", "Target reached"],
    [{ ...base, stage: "bust" }, "stopped", "Stopped"],
    [{ ...base, control: "killed" }, "stopped", "Stopped"],
  ] as const)("maps to words, never colour alone", (t, state, text) => {
    expect(tileState(t)).toBe(state);
    render(<Pill kind="state" value={state as string} />);
    expect(screen.getByText(text)).toBeInTheDocument();
    cleanup();
  });
  it("has no state before a round starts", () => {
    expect(tileState({ ...base, hasCohort: false })).toBeNull();
  });
});

describe("tabs", () => {
  it("shows three cues on the current tab and none on the others", () => {
    const { container } = render(<StrategyTabs current="risk" />);
    const links = within(container).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/strategies",
      "/strategies/leaderboard",
      "/strategies/ideas",
      "/strategies/risk",
      "/what-if",
      "/cortex",
    ]);
    const on = links.filter((l) => l.getAttribute("aria-current") === "page");
    expect(on).toHaveLength(1);
    expect(on[0]!.textContent).toContain("Risk");
    expect(on[0]!.textContent).toContain("Selected"); // the word cue
    expect(on[0]!.querySelector("svg")).not.toBeNull(); // the check
    expect(on[0]!.className).toContain("bg-accent"); // the filled surface
    for (const l of links.filter((x) => x !== on[0])) expect(l.querySelector("svg")).toBeNull();
  });
});

describe("risk confirmation sheet", () => {
  it("keeps the list control neutral and shows red only on the confirm button inside the sheet", async () => {
    const action = vi.fn(async () => ({ ok: true as const }));
    const { container } = render(
      <ControlButton
        scope="family"
        keyId="F1"
        state="killed"
        subject="Breakout"
        label="Switch off"
        title="Switch off Breakout?"
        description="No new positions."
        confirmLabel="Confirm"
        danger
        action={action as never}
      />,
    );
    expect(document.body.innerHTML).not.toMatch(/danger/);
    expect(container.querySelector("[data-toggle]")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Switch off/ }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Confirm" });
    expect(confirm.className).toContain("bg-danger");
    expect(action).not.toHaveBeenCalled(); // nothing is sent before the confirm button
    const reds = [...document.body.querySelectorAll("[class*='danger']")];
    expect(reds).toEqual([confirm]);
    fireEvent.click(confirm);
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
  });
});

describe("outcome bars", () => {
  it("groups by sign, in the signed outcome colours, with the figure in text", () => {
    const { container } = render(
      <OutcomeBars
        items={[
          { key: "a", stock: "Stock A", returnPpm: 80_000 },
          { key: "b", stock: "Stock B", returnPpm: -40_000 },
        ]}
      />,
    );
    expect(screen.getByText("Pushing it up")).toBeInTheDocument();
    expect(screen.getByText("Pulling it down")).toBeInTheDocument();
    expect(container.querySelector("[data-outcome-group=positive]")?.textContent).toContain(
      "+8.00%",
    );
    expect(container.querySelector("[data-outcome-group=negative]")?.textContent).toContain(
      "-4.00%",
    );
    expect(container.querySelector("[data-outcome-bar]")?.className).toContain("--h-fill");
  });
});
