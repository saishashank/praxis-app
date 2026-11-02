// C1 shared V2 components (UXR-002, 040..046): selection cues, keyboard, Esc, toast timing, pill text.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FamilyBadge, Rail } from "@/components/ui/Family";
import { Chips, Tabs } from "@/components/ui/Nav";
import { OptionCard, OptionGrid } from "@/components/ui/OptionCard";
import { Pill } from "@/components/ui/Pill";
import { Segmented } from "@/components/ui/Segmented";
import { Sheet } from "@/components/ui/Sheet";
import { StatusStrip } from "@/components/ui/StatusStrip";
import { TOAST_MS, ToastProvider, useToast } from "@/components/ui/Toast";
import { ValueRow } from "@/components/ui/ValueRow";

beforeAll(async () => {
  await import("@/components/ui/SheetPanel");
}, 60_000);

afterEach(() => vi.useRealTimers());

const ITEMS = [
  { value: "a", label: "Top movers" },
  { value: "b", label: "Sectors" },
  { value: "c", label: "All" },
];

function Harness() {
  const [v, setV] = useState("a");
  return <Segmented label="View" items={ITEMS} value={v} onChange={setV} />;
}

describe("Segmented", () => {
  it("selected segment has aria-selected and a check; the others do not", () => {
    render(<Harness />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    expect(tabs[0].querySelector("svg")).not.toBeNull();
    expect(tabs[1].querySelector("svg")).toBeNull();
  });
  it("arrow keys move the selection and the focus; Home and End jump", () => {
    render(<Harness />);
    const tabs = () => screen.getAllByRole("tab");
    tabs()[0].focus();
    fireEvent.keyDown(tabs()[0], { key: "ArrowRight" });
    expect(tabs()[1]).toHaveAttribute("aria-selected", "true");
    expect(tabs()[1]).toHaveFocus();
    fireEvent.keyDown(tabs()[1], { key: "End" });
    expect(tabs()[2]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(tabs()[2], { key: "ArrowRight" });
    expect(tabs()[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(tabs()[0], { key: "ArrowLeft" });
    expect(tabs()[2]).toHaveAttribute("aria-selected", "true");
  });
  it("link mode: aria-current, check and a Selected text cue on the current link only", () => {
    render(
      <Segmented
        label="Profile"
        value="b"
        items={ITEMS.map((i) => ({ ...i, href: `/x?p=${i.value}` }))}
      />,
    );
    const links = screen.getAllByRole("link");
    expect(links.map((l) => l.getAttribute("aria-current"))).toEqual([null, "page", null]);
    expect(links[1]).toHaveTextContent("Selected");
    expect(links[1].querySelector("svg")).not.toBeNull();
    expect(links[0]).not.toHaveTextContent("Selected");
  });
});

describe("OptionCard", () => {
  it("selected card shows a check and the word Current; unselected does not", () => {
    render(
      <OptionGrid label="Theme">
        <OptionCard title="Dark" selected onSelect={() => {}} />
        <OptionCard title="Light" selected={false} onSelect={() => {}} />
      </OptionGrid>,
    );
    const [dark, light] = screen.getAllByRole("radio");
    expect(dark).toHaveAttribute("aria-checked", "true");
    expect(dark).toHaveTextContent("Current");
    expect(dark.querySelector("svg")).not.toBeNull();
    expect(light).toHaveAttribute("aria-checked", "false");
    expect(light).not.toHaveTextContent("Current");
    expect(dark.className).toContain("min-h-14");
    expect(screen.getByRole("radiogroup").className).toContain("min-[600px]:grid-cols-2");
  });
});

describe("ValueRow", () => {
  it("is one button with label, value and chevron; or one link", () => {
    const onClick = vi.fn();
    const { rerender } = render(<ValueRow label="Theme" value="Dark" onClick={onClick} />);
    const btn = screen.getByRole("button", { name: /Theme/ });
    expect(btn).toHaveTextContent("Dark");
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalled();
    rerender(<ValueRow label="Theme" value="Dark" href="/settings/appearance" />);
    expect(screen.getByRole("link", { name: /Theme/ })).toHaveAttribute(
      "href",
      "/settings/appearance",
    );
  });
});

describe("Sheet", () => {
  it("opens as a dialog; Esc closes it without running the primary action", async () => {
    const save = vi.fn();
    render(
      <Sheet
        trigger="Edit"
        href="/settings/time"
        title="Time format"
        primary={
          <button type="button" onClick={save}>
            Save
          </button>
        }
      >
        <p>Body</p>
      </Sheet>,
    );
    const trigger = screen.getByRole("link", { name: "Edit" });
    expect(trigger).toHaveAttribute("href", "/settings/time"); // no-JS fallback
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Time format" });
    expect(dialog.className).toContain("max-h-[90vh]");
    expect(dialog.className).toContain("lg:w-[480px]");
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(save).not.toHaveBeenCalled();
  });
  it("can be controlled from a ValueRow", async () => {
    function C() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <ValueRow label="Motion" value="On" onClick={() => setOpen(true)} />
          <Sheet title="Motion" open={open} onOpenChange={setOpen}>
            <p>Choose</p>
          </Sheet>
        </>
      );
    }
    render(<C />);
    fireEvent.click(screen.getByRole("button", { name: /Motion/ }));
    await screen.findByRole("dialog", { name: "Motion" });
  });
});

describe("StatusStrip", () => {
  it("items are label over value; mood prints the word and sets the gradient", () => {
    render(
      <StatusStrip
        label="Today"
        items={[{ label: "Cash", value: "A$100" }]}
        mood={{ key: "off", word: "Risk-off" }}
      />,
    );
    const strip = screen.getByRole("region", { name: "Today" });
    expect(strip).toHaveTextContent("Risk-off");
    expect(strip).toHaveTextContent("Cash");
    expect(strip.getAttribute("data-mood")).toBe("off");
    expect(strip.className).toContain("flex-wrap");
  });
});

describe("Pill", () => {
  it("always renders text for every kind, including unknown values", () => {
    const cases: Array<[Parameters<typeof Pill>[0]["kind"], string]> = [
      ["state", "running"],
      ["state", "nonsense"],
      ["tier", "P1"],
      ["thesis", "amber"],
      ["validation", "PASSED-BACKTEST"],
      ["family", "br"],
      ["sector", "tech"],
      ["status", "bad"],
    ];
    for (const [kind, value] of cases) {
      const { container, unmount } = render(<Pill kind={kind} value={value} />);
      expect((container.textContent ?? "").replace(/\s/g, "").length).toBeGreaterThan(1);
      unmount();
    }
  });
  it("explicit text wins; colour comes from tokens (no literal colours)", () => {
    const { container } = render(
      <Pill kind="tier" value="P0" mark="P0">
        Urgent
      </Pill>,
    );
    expect(container).toHaveTextContent("Urgent");
    const el = container.firstElementChild as HTMLElement;
    expect(el.getAttribute("style")).toContain("--color-tier-p0-fill");
    expect(el.getAttribute("style")).not.toMatch(/#[0-9a-f]{3,6}/i);
  });
});

describe("Family badge and Rail", () => {
  it("badge shows the two-letter mark, label and info slot; rail uses the family fill", () => {
    const { container } = render(
      <>
        <FamilyBadge code="br" label="Breakout" info={<button type="button">i</button>} />
        <Rail hue="family-br" header="Head">
          Body
        </Rail>
      </>,
    );
    expect(container).toHaveTextContent("BR");
    expect(container).toHaveTextContent("Breakout");
    expect(screen.getByRole("button", { name: "i" })).toBeInTheDocument();
    const rail = container.querySelector("[data-hue]") as HTMLElement;
    expect(rail.getAttribute("style")).toContain("--color-family-br-fill");
    expect(container.innerHTML).toContain("--tint-band");
  });
});

describe("Toast", () => {
  function Fire({ undo }: { undo?: () => void }) {
    const { toast } = useToast();
    return (
      <button type="button" onClick={() => toast("Saved", { undo })}>
        go
      </button>
    );
  }
  it("shows for 4 s then disappears", () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Fire />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("go"));
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
    act(() => {
      vi.advanceTimersByTime(TOAST_MS - 1);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(screen.getByRole("status")).not.toHaveTextContent("Saved");
    expect(TOAST_MS).toBe(4000);
  });
  it("Undo runs the callback and closes the toast", () => {
    const undo = vi.fn();
    render(
      <ToastProvider>
        <Fire undo={undo} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("go"));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(undo).toHaveBeenCalledOnce();
    expect(screen.getByRole("status")).not.toHaveTextContent("Saved");
  });
});

describe("Nav selection cues (UXR-002)", () => {
  const items = [
    { href: "/a", label: "One", current: true },
    { href: "/b", label: "Two" },
  ];
  it.each([
    ["Tabs", <Tabs key="t" label="T" items={items} />],
    ["Chips", <Chips key="c" label="C" items={items} />],
  ])("%s: current item has a check and a Selected text cue", (_n, el) => {
    render(el);
    const [one, two] = screen.getAllByRole("link");
    expect(one).toHaveAttribute("aria-current", "page");
    expect(one.querySelector("svg")).not.toBeNull();
    expect(one).toHaveTextContent("Selected");
    expect(two.querySelector("svg")).toBeNull();
    expect(two).not.toHaveTextContent("Selected");
  });
});
