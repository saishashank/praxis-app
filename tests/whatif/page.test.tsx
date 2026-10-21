// What-if page and form (UX-119, ROL-102a; M7 T19b): guard first, the choices, the answer with a
// Simulated label, the plain refusal texts and the count left today.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import WhatIfPage from "@/app/(app)/what-if/page";
import { WhatIfForm } from "@/app/(app)/what-if/WhatIfForm";
import type { WhatIfOptions } from "@/lib/whatif/options";

const guard = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock("@/lib/auth/guard", () => guard);
const svc = vi.hoisted(() => ({ loadOptions: vi.fn(), budgetFor: vi.fn() }));
vi.mock("@/lib/whatif/service", () => svc);
vi.mock("@/lib/db/client", () => ({ mainDb: () => ({}), authDb: () => ({}) }));
vi.mock("@/app/(app)/what-if/actions", () => ({ runWhatIfAction: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const editor = { id: 2, email: "e@example.test", name: null, role: "editor" };
const options: WhatIfOptions = {
  strategies: [{ id: "E01", name: "Follow the trend" }],
  profiles: ["P3", "P5", "stress"],
  shocks: [-10, 10],
};

describe("what-if page", () => {
  it("asks for the what_if action first", async () => {
    guard.requireUser.mockRejectedValueOnce(new Error("NEXT_HTTP_ERROR_FALLBACK;403"));
    await expect(WhatIfPage()).rejects.toThrow(/403/);
    expect(guard.requireUser).toHaveBeenCalledWith("what_if", "/what-if");
    expect(svc.loadOptions).not.toHaveBeenCalled();
  });

  it("says plainly when no strategy is running", async () => {
    guard.requireUser.mockResolvedValueOnce(editor);
    svc.loadOptions.mockResolvedValueOnce({ strategies: [], profiles: [], shocks: [] });
    svc.budgetFor.mockResolvedValueOnce({ limit: 5, used: 0, remaining: 5 });
    render(await WhatIfPage());
    expect(screen.getByRole("heading", { level: 1, name: "What-if" })).toBeInTheDocument();
    expect(screen.getByText("No strategies are running yet")).toBeInTheDocument();
  });

  it("shows a neutral message when the data cannot be read", async () => {
    guard.requireUser.mockResolvedValueOnce(editor);
    svc.loadOptions.mockRejectedValueOnce(new Error("db down: secret detail"));
    svc.budgetFor.mockResolvedValueOnce({ limit: 5, used: 0, remaining: 5 });
    render(await WhatIfPage());
    expect(screen.getByRole("status")).toHaveTextContent("What-if unavailable");
    expect(screen.queryByText(/secret detail/)).toBeNull();
  });
});

describe("what-if form", () => {
  it("shows the answer with a Simulated label and the count left", async () => {
    const action = vi.fn().mockResolvedValue({
      ok: true,
      view: {
        execution: "E01",
        name: "Follow the trend",
        d: "2026-10-03",
        result: {
          kind: "cost",
          profile: "P3",
          ownProfile: "P5",
          liqNavMicro: 628_900_000,
          ownLiqNavMicro: 628_000_000,
          diffMicro: 900_000,
          feesMicro: 700_000,
          ownFeesMicro: 1_500_000,
        },
      },
      budget: { limit: 5, used: 3, remaining: 2 },
    });
    render(<WhatIfForm options={options} remaining={3} limit={5} action={action} />);
    expect(screen.getByRole("status")).toHaveTextContent("3 of 5 left today");
    fireEvent.click(screen.getByRole("button", { name: "Run what-if" }));
    await waitFor(() =>
      expect(screen.getByText(/From the nightly result of 2026-10-03/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/Simulated/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("2 of 5 left today");
    const fd = action.mock.calls[0]![0] as FormData;
    expect(fd.get("kind")).toBe("cost");
    expect(fd.get("key")).toBe("E01");
    expect(fd.get("profile")).toBe("P3");
  });

  it("shows the plain refusal text for a question the stored tables cannot answer", async () => {
    const action = vi.fn().mockResolvedValue({ error: "not_available" });
    render(<WhatIfForm options={options} remaining={3} limit={5} action={action} />);
    fireEvent.change(screen.getByLabelText("What do you want to ask?"), {
      target: { value: "custom" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run what-if" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Not available in this version"),
    );
    expect((action.mock.calls[0]![0] as FormData).get("kind")).toBe("custom");
  });

  it("disables the button and says when the count restarts once the day's runs are used", () => {
    render(<WhatIfForm options={options} remaining={0} limit={5} action={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Run what-if" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("midnight in Melbourne");
  });
});
