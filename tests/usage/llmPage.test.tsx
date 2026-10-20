// LLM usage section of the Usage page (LLM-051, UX-100; M7 T19b): rendering of the loader's rows, the
// empty state and the neutral failure message. The page stays Owner-only (guard, tested in page.test).
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import UsagePage from "@/app/(app)/usage/page";
import type { LlmUsage } from "@/lib/ui/loaders/usageLlm";

const guard = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock("@/lib/auth/guard", () => guard);
const metersMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/usage/meters", async (orig) => ({
  ...(await orig<typeof import("@/lib/usage/meters")>()),
  getMeters: metersMock,
}));
const llmMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ui/loaders/usageLlm", async (orig) => ({
  ...(await orig<typeof import("@/lib/ui/loaders/usageLlm")>()),
  loadLlmUsage: llmMock,
}));
vi.mock("@/lib/db/client", () => ({ mainDb: () => ({}) }));
vi.mock("@/lib/auth/actions", () => ({ signInAction: vi.fn(), signOutAction: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const owner = { id: 1, email: "o@example.test", name: null, role: "owner" };
const counts = {
  calls: 1234,
  tokensIn: 5000,
  tokensOut: 7000,
  cached: 100,
  fallbacks: 50,
  failures: 3,
  cachePct: 8,
  fallbackPct: 4,
};
const llm: LlmUsage = {
  sinceD: "2026-09-20",
  byRole: [{ role: "narrator", provider: "gemini", ...counts }],
  byDay: [{ d: "2026-10-19", provider: "gemini", ...counts, cachePct: null, fallbackPct: null }],
};

async function renderOwner(l: LlmUsage | null | Error) {
  guard.requireUser.mockResolvedValueOnce(owner);
  metersMock.mockResolvedValueOnce([]);
  if (l instanceof Error) llmMock.mockRejectedValueOnce(l);
  else llmMock.mockResolvedValueOnce(l);
  render(await UsagePage());
  return screen.getByRole("region", { name: "LLM usage" });
}

describe("LLM usage section", () => {
  it("is asked for with the signed-in role, so only the Owner gets rows", async () => {
    await renderOwner(llm);
    expect(llmMock).toHaveBeenCalledWith(expect.anything(), "owner", expect.any(Date));
  });

  it("shows tokens, requests, cache hit rate, fallback rate and failures per role, provider and day", async () => {
    const s = await renderOwner(llm);
    const byRole = within(s).getByRole("table", { name: /By role and provider since 2026-09-20/ });
    const row = within(byRole).getByRole("row", { name: /narrator/ });
    expect(within(row).getByText("gemini")).toBeInTheDocument();
    expect(within(row).getByText("1,234")).toBeInTheDocument();
    expect(within(row).getByText("5,000 / 7,000")).toBeInTheDocument();
    expect(within(row).getByText("8%")).toBeInTheDocument();
    expect(within(row).getByText("4%")).toBeInTheDocument();
    expect(within(row).getByText("3")).toBeInTheDocument();
    for (const h of ["Calls", "Tokens in / out", "Cache hits", "Fallbacks", "Failures"])
      expect(within(byRole).getByRole("columnheader", { name: h })).toBeInTheDocument();
    const byDay = within(s).getByRole("table", { name: /By day and provider/ });
    const dayRow = within(byDay).getByRole("row", { name: /2026-10-19/ });
    expect(within(dayRow).getAllByText("n/a")).toHaveLength(2); // rates over no calls are not invented
  });

  it("says plainly when nothing has been logged yet", async () => {
    const s = await renderOwner({ sinceD: "2026-09-20", byRole: [], byDay: [] });
    expect(s).toHaveTextContent("No LLM calls recorded in the last 30 days");
    expect(within(s).queryByRole("table")).toBeNull();
  });

  it("shows a neutral message when the call log cannot be read", async () => {
    const s = await renderOwner(new Error("db down: secret detail"));
    expect(s).toHaveTextContent("LLM usage unavailable");
    expect(screen.queryByText(/secret detail/)).toBeNull();
  });
});
