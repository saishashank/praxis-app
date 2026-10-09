import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import HomePage from "@/app/(app)/page";
import SignInPage from "@/app/signin/page";
import PrivacyPage from "@/app/privacy/page";
import TermsPage from "@/app/terms/page";

vi.mock("@/lib/auth/guard", () => ({
  requireUser: vi.fn(async () => ({ id: 1, email: "e@example.test", name: null, role: "editor" })),
}));
vi.mock("@/lib/auth/actions", () => ({ signInAction: vi.fn(), signOutAction: vi.fn() }));

describe("home page", () => {
  it("shows heading, simulated line, role, sign-out and the disclaimer footer", async () => {
    render(await HomePage());
    expect(screen.getByRole("heading", { name: "Praxis" })).toBeInTheDocument();
    expect(screen.getByText(/All trades are simulated./)).toBeInTheDocument();
    expect(screen.getByText("Signed in as editor")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(
      screen.getByText("Simulation for personal information only — not financial advice"),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "/privacy");
    expect(screen.getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");
  });
});

describe("sign-in page", () => {
  it("offers only the Google button and the legal links", async () => {
    render(await SignInPage({ searchParams: Promise.resolve({ callbackUrl: "/markets" }) }));
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Sign in with Google" })).toBeInTheDocument();
    expect(screen.getAllByRole("link").map((l) => l.getAttribute("href"))).toEqual([
      "/privacy",
      "/terms",
    ]);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.querySelector("input[name=callbackUrl]")).toHaveValue("/markets");
  });

  it("shows only the neutral message on error and sanitises callbackUrl", async () => {
    render(
      await SignInPage({
        searchParams: Promise.resolve({ error: "AccessDenied", callbackUrl: "//evil.test" }),
      }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/^This account is not authorised.$/);
    expect(document.querySelector("input[name=callbackUrl]")).toHaveValue("/");
  });
});

describe("privacy page", () => {
  it("states scopes, retention and no-sale", () => {
    render(<PrivacyPage />);
    expect(screen.getByRole("heading", { name: "Privacy" })).toBeInTheDocument();
    expect(screen.getByText(/openid, email and profile only/)).toBeInTheDocument();
    expect(screen.getByText(/90 days later/)).toBeInTheDocument();
    expect(screen.getByText(/never sold and never shared for advertising/)).toBeInTheDocument();
    expect(screen.getByText("Last updated: 2026-10-09")).toBeInTheDocument();
  });
});

describe("terms page", () => {
  it("states simulated trading, no advice, as-is", () => {
    render(<TermsPage />);
    expect(screen.getByRole("heading", { name: "Terms" })).toBeInTheDocument();
    expect(screen.getByText(/simulated paper trading/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing in Praxis is financial advice/)).toBeInTheDocument();
    expect(screen.getByText(/as-is, with no warranty/)).toBeInTheDocument();
    expect(screen.getByText("Last updated: 2026-10-09")).toBeInTheDocument();
  });
});
