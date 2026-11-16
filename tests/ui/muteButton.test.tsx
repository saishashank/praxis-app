// M21 C3 (UXN-303, UXN-322, D-1207): the Mute / Unmute / "Alerts for all picks" forms. A form post to a server
// action; a success shows a toast with Undo (when the shell's provider is there), a refusal is said in words.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AllPicksToggle, MuteButton, UnmuteButton } from "@/app/(app)/alerts/MuteButton";
import { ToastProvider } from "@/components/ui/Toast";
import type { ActionResult } from "@/lib/users/messages";

afterEach(cleanup);

const ID = "a".repeat(64);
const ok = async (): Promise<ActionResult> => ({ ok: true });
const fail = (error: string) => async (): Promise<ActionResult> => ({ error }) as ActionResult;
const withToast = (ui: ReactNode) => <ToastProvider>{ui}</ToastProvider>;
const click = async (name: string | RegExp) => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
};

describe("MuteButton", () => {
  it("posts the alert id, and with no toast provider shows nothing more", async () => {
    const action = vi.fn<(fd: FormData) => Promise<ActionResult>>(ok);
    render(<MuteButton action={action} alertId={ID} stock="ZZ1" />);
    await click("Mute the alert for ZZ1");
    expect(action).toHaveBeenCalledTimes(1);
    expect(action.mock.calls[0]![0].get("alert_id")).toBe(ID);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a success shows a toast and its Undo runs the opposite action on the same alert", async () => {
    const undo = vi.fn<(fd: FormData) => Promise<ActionResult>>(ok);
    render(withToast(<MuteButton action={ok} undoAction={undo} alertId={ID} stock="ZZ1" />));
    await click("Mute the alert for ZZ1");
    await waitFor(() => expect(screen.getByText("Muted the alert for ZZ1")).toBeTruthy());
    await click(/undo/i);
    expect(undo).toHaveBeenCalledTimes(1);
    expect(undo.mock.calls[0]![0].get("alert_id")).toBe(ID);
  });

  it("a success with no undo action still toasts", async () => {
    render(withToast(<MuteButton action={ok} alertId={ID} stock="ZZ1" />));
    await click("Mute the alert for ZZ1");
    await waitFor(() => expect(screen.getByText("Muted the alert for ZZ1")).toBeTruthy());
  });

  it("a refusal is said in the shared words", async () => {
    render(<MuteButton action={fail("forbidden")} alertId={ID} stock="ZZ1" />);
    await click("Mute the alert for ZZ1");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "You do not have access to do that.",
    );
  });
});

describe("UnmuteButton", () => {
  it("shows the Muted chip and Unmute; a success toasts with an Undo that re-mutes", async () => {
    const undo = vi.fn<(fd: FormData) => Promise<ActionResult>>(ok);
    render(withToast(<UnmuteButton action={ok} undoAction={undo} alertId={ID} stock="ZZ2" />));
    expect(screen.getByTestId("muted-chip").textContent).toBe("Muted");
    await click("Unmute the alert for ZZ2");
    await waitFor(() => expect(screen.getByText("Unmuted the alert for ZZ2")).toBeTruthy());
    await click(/undo/i);
    expect(undo).toHaveBeenCalledTimes(1);
    expect(undo.mock.calls[0]![0].get("alert_id")).toBe(ID);
  });

  it("a success without a provider or an undo action shows no error", async () => {
    render(<UnmuteButton action={ok} alertId={ID} stock="ZZ2" />);
    await click("Unmute the alert for ZZ2");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    ["alerts_off", "Turn on alerts for all picks first."],
    ["not_listed", "That pick is no longer on the list, so its alert cannot come back."],
    ["unavailable", "Something went wrong. Please try again."],
  ])("the refusal %s is said in words and the chip stays", async (code, words) => {
    render(<UnmuteButton action={fail(code)} alertId={ID} stock="ZZ2" />);
    await click("Unmute the alert for ZZ2");
    expect((await screen.findByRole("alert")).textContent).toBe(words);
    expect(screen.getByTestId("muted-chip")).toBeTruthy();
  });
});

describe("AllPicksToggle", () => {
  it("offers the opposite of the current state", () => {
    const { rerender } = render(<AllPicksToggle action={ok} on={false} />);
    const field = () => document.querySelector<HTMLInputElement>('input[name="pick_alerts"]')!;
    expect(screen.getByText("Off")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Turn on" })).toBeTruthy();
    expect(field().value).toBe("on");
    rerender(<AllPicksToggle action={ok} on={true} />);
    expect(screen.getByText("On")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Turn off" })).toBeTruthy();
    expect(field().value).toBe("off");
  });

  it("posts the choice and says a refusal in words", async () => {
    const action = vi.fn<(fd: FormData) => Promise<ActionResult>>(fail("forbidden"));
    render(<AllPicksToggle action={action} on={false} />);
    await click("Turn on");
    expect(action).toHaveBeenCalledTimes(1);
    expect(action.mock.calls[0]![0].get("pick_alerts")).toBe("on");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "You do not have access to do that.",
    );
  });
});
