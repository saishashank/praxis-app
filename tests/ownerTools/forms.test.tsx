// M21 B1 (UXN-315, UXN-316, UXN-317; D-1217, D-1218, D-1220): the three Owner-tool forms post to their server
// action, show "Saved." on success and the action's own sentence on a refusal.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrokerLinksForm } from "@/components/ownerTools/BrokerLinksForm";
import { CapitalForm } from "@/components/ownerTools/CapitalForm";
import { HoldingsForm } from "@/components/ownerTools/HoldingsForm";
import type { OwnerActionResult } from "@/lib/ownerTools/result";

afterEach(cleanup);

type Act = (fd: FormData) => Promise<OwnerActionResult>;
const ok: Act = async () => ({ ok: true });
const refuse: Act = async () => ({ error: "invalid", message: "That did not look right." });
const submit = async (name: string | RegExp) => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
};

describe.each([
  ["CapitalForm", (a: Act) => <CapitalForm action={a} current={0} symbol="$" />, /save amount/i],
  ["BrokerLinksForm", (a: Act) => <BrokerLinksForm action={a} current={[]} />, /^save/i],
  ["HoldingsForm", (a: Act) => <HoldingsForm action={a} current={[]} />, "Save holdings"],
] as const)("%s", (_name, view, button) => {
  it("posts the form and says Saved", async () => {
    const action = vi.fn<Act>(ok);
    render(view(action));
    await submit(button);
    expect(action).toHaveBeenCalledTimes(1);
    expect((await screen.findByRole("status")).textContent).toBe("Saved.");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says the refusal in the action's own words", async () => {
    render(view(refuse));
    await submit(button);
    expect((await screen.findByRole("alert")).textContent).toBe("That did not look right.");
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("HoldingsForm", () => {
  it("the CSV button posts mode=csv and the screenshot control stays disabled", async () => {
    const action = vi.fn<Act>(ok);
    render(<HoldingsForm action={action} current={[]} />);
    expect(
      (screen.getByRole("button", { name: "Read from a screenshot" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await submit("Import CSV");
    expect(action).toHaveBeenCalledTimes(1);
  });
});
