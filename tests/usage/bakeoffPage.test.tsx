// Bake-off card of the Usage page (LLM-042; M8 T5 loader, page card by the orchestrator): latest run's
// stored rows, the "no run" state and the neutral failure message. The loader enforces Owner-only.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import UsagePage from "@/app/(app)/usage/page";
import type { BakeoffView } from "@/lib/ui/loaders/usageBakeoff";

const guard = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock("@/lib/auth/guard", () => guard);
const metersMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/usage/meters", async (orig) => ({
  ...(await orig<typeof import("@/lib/usage/meters")>()),
  getMeters: metersMock,
}));
vi.mock("@/lib/ui/loaders/usageLlm", async (orig) => ({
  ...(await orig<typeof import("@/lib/ui/loaders/usageLlm")>()),
  loadLlmUsage: vi.fn(async () => null),
}));
const bakeoffMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ui/loaders/usageBakeoff", () => ({ loadBakeoffResults: bakeoffMock }));
vi.mock("@/lib/db/client", () => ({ mainDb: () => ({}) }));
vi.mock("@/lib/auth/actions", () => ({ signInAction: vi.fn(), signOutAction: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const owner = { id: 1, email: "o@example.test", name: null, role: "owner" };
const run: BakeoffView = {
  runId: "bakeoff-2026-10-21-abcdef12",
  reportSha: "0123456789abcdef0123",
  lines: [
    {
      modelId: "model-a",
      category: "overall",
      items: 40,
      jsonValidPct: 98,
      inventedNumbers: 0,
      injectionResistancePct: 100,
      detectionPct: null,
      triageAgreementPct: null,
      passes: true,
      trainsOnPromptsCheckedD: "2026-10-20",
    },
    {
      modelId: "model-b",
      category: "overall",
      items: 40,
      jsonValidPct: 80,
      inventedNumbers: 3,
      injectionResistancePct: 90,
      detectionPct: null,
      triageAgreementPct: null,
      passes: false,
      trainsOnPromptsCheckedD: null,
    },
  ],
};

async function renderWith(b: BakeoffView | null | Error) {
  guard.requireUser.mockResolvedValueOnce(owner);
  metersMock.mockResolvedValueOnce([]);
  if (b instanceof Error) bakeoffMock.mockRejectedValueOnce(b);
  else bakeoffMock.mockResolvedValueOnce(b);
  render(await UsagePage());
  return screen.getByRole("region", { name: "Model bake-off" });
}

describe("bake-off card", () => {
  it("asks the loader with the signed-in role", async () => {
    await renderWith(null);
    expect(bakeoffMock).toHaveBeenCalledWith(expect.anything(), "owner");
  });

  it("shows the run, the report sha and one row per model and category", async () => {
    const s = await renderWith(run);
    expect(within(s).getByText("bakeoff-2026-10-21-abcdef12")).toBeInTheDocument();
    expect(within(s).getByText("0123456789ab")).toBeInTheDocument();
    const a = within(s).getByRole("rowheader", { name: "model-a" }).closest("tr")!;
    expect(within(a).getByText("Passes")).toBeInTheDocument();
    expect(within(a).getByText("2026-10-20")).toBeInTheDocument();
    const b = within(s).getByRole("rowheader", { name: "model-b" }).closest("tr")!;
    expect(within(b).getByText("Does not pass")).toBeInTheDocument();
    expect(within(b).getByText("Not checked")).toBeInTheDocument();
  });

  it("says no run yet when there is none", async () => {
    const s = await renderWith(null);
    expect(within(s).getByText("No bake-off has run yet.")).toBeInTheDocument();
  });

  it("shows a neutral message when the read fails, never the error", async () => {
    const s = await renderWith(new Error("secret detail"));
    expect(within(s).getByRole("status")).toHaveTextContent("Bake-off results unavailable");
    expect(s).not.toHaveTextContent("secret detail");
  });
});
