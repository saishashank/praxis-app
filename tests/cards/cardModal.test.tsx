// D-884: the Decision Card popup. A native dialog opened on mount; Close, Esc (the dialog's close
// event) and a click on the backdrop all go back to the page that opened the card.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const back = vi.hoisted(() => vi.fn());
const where = vi.hoisted(() => ({ path: "/cards/x" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ back }),
  usePathname: () => where.path,
}));

import { CardModal } from "@/app/(app)/@modal/(.)cards/[id]/CardModal";

beforeAll(() => {
  // jsdom has no modal dialogs: open/close set the attribute and close fires the close event
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});
afterEach(() => {
  cleanup();
  back.mockReset();
  where.path = "/cards/x";
});

describe("CardModal (D-884)", () => {
  it("opens on mount and shows the card", () => {
    render(
      <CardModal>
        <h1>Decision Card: AAA</h1>
      </CardModal>,
    );
    const d = document.querySelector("dialog")!;
    expect(d.hasAttribute("open")).toBe(true);
    expect(d).toHaveAccessibleName("Decision Card");
    expect(screen.getByRole("heading", { name: "Decision Card: AAA" })).toBeInTheDocument();
  });

  it("Close and a backdrop click go back; a click inside does not", () => {
    render(
      <CardModal>
        <p>body</p>
      </CardModal>,
    );
    fireEvent.click(screen.getByText("body"));
    expect(back).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(back).toHaveBeenCalledTimes(1);
    cleanup();
    render(
      <CardModal>
        <p>body</p>
      </CardModal>,
    );
    fireEvent.click(document.querySelector("dialog")!);
    expect(back).toHaveBeenCalledTimes(2);
  });

  it("draws nothing once the address is no longer a card", () => {
    where.path = "/strategies";
    render(
      <CardModal>
        <p>body</p>
      </CardModal>,
    );
    expect(document.querySelector("dialog")).toBeNull();
  });
});
