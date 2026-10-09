import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import HomePage from "@/app/page";
import PrivacyPage from "@/app/privacy/page";
import TermsPage from "@/app/terms/page";

describe("home page", () => {
  it("shows heading, simulated line and legal links", () => {
    render(<HomePage />);
    expect(screen.getByRole("heading", { name: "Praxis" })).toBeInTheDocument();
    expect(screen.getByText(/All trades are simulated\./)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "/privacy");
    expect(screen.getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");
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
