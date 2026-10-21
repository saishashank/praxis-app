// Focus handling and keyboard behaviour of the Radix islands (M7 T5): Esc closes, focus moves into
// the dialog and returns to the trigger, popover content is reachable, the confirm action submits.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ConfirmDialog, InfoButton, limitWords, Sheet, Term } from "@/components/ui/Overlays";

// The Radix half is a dynamic import (bundle budget). Load it once up front so the first test is not at
// the mercy of a cold transform on a busy machine; the components still resolve it through import().
beforeAll(async () => {
  await import("@/components/ui/OverlayPanels");
}, 60_000);

describe("limitWords", () => {
  it("keeps short text and cuts long text at 40 words", () => {
    expect(limitWords("one two")).toBe("one two");
    const long = Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ");
    const out = limitWords(long);
    expect(out.endsWith("…")).toBe(true);
    expect(out.split(" ")).toHaveLength(40);
  });
});

describe("Sheet", () => {
  it("opens as a named dialog, moves focus in, Esc closes and focus returns to the trigger", async () => {
    render(
      <Sheet trigger="Filters" title="Filters" description="Choose what to show">
        <button type="button">Inside</button>
      </Sheet>,
    );
    const trigger = screen.getByRole("button", { name: "Filters" });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Filters" });
    expect(dialog).toHaveAccessibleDescription("Choose what to show");
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(trigger).toHaveFocus();
  });
  it("is modal: content outside is hidden from assistive tech while open", async () => {
    render(
      <>
        <p>Outside</p>
        <Sheet trigger="Open" title="T" description="D">
          x
        </Sheet>
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await screen.findByRole("dialog");
    expect(screen.getByText("Outside").closest("[aria-hidden=true]")).not.toBeNull();
  });
  it("has a labelled close button", async () => {
    render(
      <Sheet trigger="Open" title="T" description="D">
        x
      </Sheet>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(await screen.findByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("ConfirmDialog", () => {
  it("Cancel closes without running the action; Confirm runs it", async () => {
    const action = vi.fn();
    render(
      <ConfirmDialog
        trigger="Revert"
        title="Revert this version?"
        description="This cannot be undone."
        confirmLabel="Yes, revert"
        action={action}
        danger
      >
        <input type="hidden" name="id" value="7" />
      </ConfirmDialog>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));
    expect(await screen.findByRole("dialog", { name: "Revert this version?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(action).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));
    await screen.findByRole("dialog");
    fireEvent.submit(screen.getByRole("button", { name: "Yes, revert" }).closest("form")!);
    expect(action).toHaveBeenCalledTimes(1);
  });
});

describe("Term and InfoButton", () => {
  it("Term opens a popover with official term, meaning and a More link; Esc closes", async () => {
    render(
      <Term meaning="What the strategy's pretend holdings are worth." official="NAV">
        Value
      </Term>,
    );
    const trigger = screen.getByRole("button", { name: "Value" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    expect(await screen.findByText(/pretend holdings/)).toBeInTheDocument();
    expect(screen.getByText("Official term: NAV")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "More" })).toHaveAttribute("href", "/reviews/glossary");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByText(/pretend holdings/)).toBeNull());
    expect(trigger).toHaveFocus();
  });
  it("Term opens from the keyboard", async () => {
    render(<Term meaning="Meaning text.">Word</Term>);
    const b = screen.getByRole("button", { name: "Word" });
    b.focus();
    expect(b).toHaveFocus();
    expect(b.tagName).toBe("BUTTON"); // a native button: Enter and Space activate it
    fireEvent.click(b);
    expect(await screen.findByText("Meaning text.")).toBeInTheDocument();
  });
  it("InfoButton has an accessible name and opens its content", async () => {
    render(<InfoButton label="About this number">Explained.</InfoButton>);
    fireEvent.click(screen.getByRole("button", { name: "About this number" }));
    expect(await screen.findByText("Explained.")).toBeInTheDocument();
  });
});
