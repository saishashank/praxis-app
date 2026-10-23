// UXR-004: the account menu is a person, not an icon — an avatar with the initial, the identity row
// first, then Settings and Sign out, then the other pages.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GearMenu, initialOf } from "@/components/shell/GearMenu";

vi.mock("next/link", () => ({
  default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...p}>
      {children}
    </a>
  ),
}));

afterEach(cleanup);

describe("initialOf", () => {
  it("uses the name, then the email, then a question mark", () => {
    expect(initialOf({ name: "saish", email: "x@example.test" })).toBe("S");
    expect(initialOf({ name: "  ", email: "owner@example.test" })).toBe("O");
    expect(initialOf({ name: null, email: "" })).toBe("?");
    expect(initialOf(undefined)).toBe("?");
  });
});

describe("account menu", () => {
  it("shows the avatar, then identity, Settings and Sign out before the admin pages", () => {
    render(
      <GearMenu
        role="owner"
        account={{ email: "owner@example.test", name: null }}
        signOut={async () => {}}
      />,
    );
    const button = screen.getByRole("button", { name: "Account and settings menu" });
    expect(button).toHaveTextContent("O");
    fireEvent.click(button);
    expect(screen.getByText("owner@example.test")).toBeInTheDocument();
    const panel = document.getElementById(button.getAttribute("aria-controls")!)!;
    const order = [...panel.querySelectorAll("a, button")].map((e) => e.textContent?.trim());
    expect(order.slice(0, 2)).toEqual(["Settings", "Sign out"]);
    expect(order).toContain("System health");
  });
});

describe("account menu without account details", () => {
  it("still shows the role line and Sign out (header read failed)", () => {
    render(<GearMenu role="viewer" signOut={async () => {}} />);
    const button = screen.getByRole("button", { name: "Account and settings menu" });
    expect(button).toHaveTextContent("?");
    fireEvent.click(button);
    expect(screen.getByText(/Signed in as/)).toHaveTextContent("Signed in as Viewer");
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });
});
