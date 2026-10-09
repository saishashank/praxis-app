import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import HomePage from "@/app/(app)/page";
import HealthPage from "@/app/(app)/health/page";
import Forbidden from "@/app/forbidden";
import SignInPage from "@/app/signin/page";
import PrivacyPage from "@/app/privacy/page";
import TermsPage from "@/app/terms/page";

vi.mock("@/lib/auth/guard", () => ({
  requireUser: vi.fn(async () => ({ id: 1, email: "e@example.test", name: null, role: "editor" })),
}));
const summaryMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/health/summary", () => ({ getHealthSummary: summaryMock }));
vi.mock("@/lib/db/client", () => ({ mainDb: () => ({}) }));
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

describe("home page health link", () => {
  it("links to System Health", async () => {
    render(await HomePage());
    expect(screen.getByRole("link", { name: "System Health" })).toHaveAttribute("href", "/health");
  });
});

describe("forbidden page", () => {
  it("is plain, with a way home", () => {
    render(<Forbidden />);
    expect(screen.getByText("You do not have access to this page.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /home/i })).toHaveAttribute("href", "/");
  });
});

describe("health page", () => {
  const jobs = [
    {
      job: "worker-heartbeat",
      label: "Worker heartbeat",
      lastRun: null,
      lastSuccessAt: null,
      stale: false,
      state: "no data",
      note: "Not reporting yet (M2)",
    },
    {
      job: "nightly-backup",
      label: "Nightly backup",
      lastRun: { status: "failed", endedAt: "2026-10-10T12:00:00.000Z" },
      lastSuccessAt: "2026-10-10T12:00:00.000Z",
      stale: true,
      state: "failed",
    },
    {
      job: "credential-selfcheck-vercel",
      label: "Credential self-check (Vercel)",
      lastRun: { status: "success", endedAt: "2026-10-10T12:00:00.000Z" },
      lastSuccessAt: "2026-10-10T12:00:00.000Z",
      stale: true,
      state: "stale",
      errorSummary: "2 check(s) failed",
    },
  ];
  const as = async (role: string) => {
    const { requireUser } = await import("@/lib/auth/guard");
    vi.mocked(requireUser).mockResolvedValueOnce({
      id: 1,
      email: "e@example.test",
      name: null,
      role,
    } as never);
  };

  it("viewer: table, Melbourne times, placeholders, footer, no secrets or error column", async () => {
    summaryMock.mockResolvedValueOnce({ jobs });
    await as("viewer");
    render(await HealthPage());
    expect(summaryMock).toHaveBeenLastCalledWith(expect.anything(), expect.any(Date), "viewer");
    expect(screen.getByRole("heading", { level: 1, name: "System Health" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Last success" })).toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: "Nightly backup" })).toBeInTheDocument();
    expect(screen.getAllByText("2026-10-10 23:00 AEDT").length).toBeGreaterThan(0);
    expect(screen.getByText("FAILED")).toBeInTheDocument();
    expect(screen.getByText("STALE")).toBeInTheDocument();
    expect(screen.getByText("Also stale")).toBeInTheDocument();
    expect(screen.getByText("Not reporting yet (M2)")).toBeInTheDocument();
    for (const t of [
      "Sentinel last poll",
      "Data freshness (last bar date per feed)",
      "LLM provider status",
      "Quota usage",
      "Last backup",
      "Last restore test",
      "Last email",
    ]) {
      expect(screen.getByText(t)).toBeInTheDocument();
    }
    expect(screen.queryByRole("heading", { name: "Secrets status" })).toBeNull();
    expect(screen.queryByText("Error details")).toBeNull();
    expect(screen.getByText(/not financial advice/)).toBeInTheDocument();
  });

  it("owner: secrets section with PASS/FAIL/PENDING and error details", async () => {
    summaryMock.mockResolvedValueOnce({
      jobs,
      secrets: {
        lastVerifiedAt: "2026-07-01T00:30:00.000Z",
        results: [
          { name: "A", ok: true, pending: false, detail: "present" },
          { name: "B", ok: false, pending: false, detail: "missing" },
          { name: "C", ok: false, pending: true, detail: "later" },
        ],
      },
    });
    await as("owner");
    render(await HealthPage());
    expect(screen.getByRole("heading", { name: "Secrets status" })).toBeInTheDocument();
    expect(screen.getByText(/2026-07-01 10:30 AEST/)).toBeInTheDocument();
    expect(screen.getByText("PASS")).toBeInTheDocument();
    expect(screen.getByText("FAIL")).toBeInTheDocument();
    expect(screen.getByText("PENDING")).toBeInTheDocument();
    expect(screen.getByText("2 check(s) failed")).toBeInTheDocument();
    expect(screen.getAllByText("None").length).toBe(2);
  });

  it("owner with no self-check yet", async () => {
    summaryMock.mockResolvedValueOnce({ jobs, secrets: { lastVerifiedAt: null, results: [] } });
    await as("owner");
    render(await HealthPage());
    expect(screen.getByText("No self-check has been recorded yet.")).toBeInTheDocument();
  });

  it("shows a neutral message when health data cannot be read", async () => {
    summaryMock.mockRejectedValueOnce(new Error("libsql://secret-host failed"));
    await as("owner");
    render(await HealthPage());
    expect(screen.getByRole("status")).toHaveTextContent(/^Health data unavailable$/);
    expect(document.body.textContent).not.toContain("secret-host");
    expect(screen.getByText("Sentinel last poll")).toBeInTheDocument();
  });
});
