// What-if form branches (UX-119, D-919): the shock question with its percentage choices and answer, the
// plain names of unknown trading-cost profiles, and no profile or strategy chooser for the custom question.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WhatIfForm } from "@/app/(app)/what-if/WhatIfForm";
import type { WhatIfOptions } from "@/lib/whatif/options";

afterEach(cleanup);

const options: WhatIfOptions = {
  strategies: [
    { id: "E01", name: "Follow the trend" },
    { id: "E02", name: "Buy the dip" },
  ],
  profiles: ["P3", "mystery", "stress", "other"],
  profileNames: { mystery: "A$4.00 flat" },
  shocks: [-10, 5, 10],
};

describe("what-if form variants", () => {
  it("names each trading-cost choice in plain words, with the stored name or a neutral fallback", () => {
    render(<WhatIfForm options={options} remaining={3} limit={5} action={vi.fn()} />);
    const profile = screen.getByRole("combobox", { name: "Trading costs" });
    const texts = within(profile)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(texts[0]).toBe("High flat-fee broker: A$6.50 a trade");
    expect(texts[1]).toBe("Fees: A$4.00 flat");
    expect(texts[2]).toBe("Stress test: A$6.50 a trade and wider price gaps");
    expect(texts[3]).toBe("Its own trading costs");
    expect(texts.join(" ")).not.toMatch(/\bP3\b|mystery/);
  });

  it("asks for a price move for the shock question and shows its answer with signed amounts", async () => {
    const action = vi.fn().mockResolvedValue({
      ok: true,
      view: {
        execution: "E02",
        name: "Buy the dip",
        d: "2026-10-16",
        result: {
          kind: "shock",
          pct: 10,
          pnlMicro: 12_000_000,
          valueMicro: 120_000_000,
          navAfterMicro: 612_000_000,
        },
      },
      budget: { limit: 5, used: 1, remaining: 4 },
    });
    render(<WhatIfForm options={options} remaining={5} limit={5} action={action} />);
    fireEvent.change(screen.getByLabelText("What do you want to ask?"), {
      target: { value: "shock" },
    });
    expect(screen.queryByRole("combobox", { name: "Trading costs" })).toBeNull();
    const move = screen.getByRole("combobox", { name: "Price move" });
    expect(
      within(move)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["-10%", "+5%", "+10%"]);
    fireEvent.change(move, { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Run what-if" }));
    await waitFor(() =>
      expect(screen.getByText("Buy the dip", { selector: "h2" })).toBeInTheDocument(),
    );
    expect(screen.getByText(/Change in value if every share moved \+10%/)).toBeInTheDocument();
    expect(screen.getByText("Shares held now")).toBeInTheDocument();
    expect(screen.getByText(/From the nightly result for Fri 16 Oct/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("5 what-ifs a day; 4 left");
    expect((action.mock.calls[0]![0] as FormData).get("pct")).toBe("10");
  });

  it("words a falling shock without a plus sign", async () => {
    const action = vi.fn().mockResolvedValue({
      ok: true,
      view: {
        execution: "E01",
        name: "Follow the trend",
        d: "2026-10-16",
        result: {
          kind: "shock",
          pct: -10,
          pnlMicro: -12_000_000,
          valueMicro: 120_000_000,
          navAfterMicro: 588_000_000,
        },
      },
      budget: { limit: 5, used: 1, remaining: 4 },
    });
    render(<WhatIfForm options={options} remaining={5} limit={5} action={action} />);
    fireEvent.change(screen.getByLabelText("What do you want to ask?"), {
      target: { value: "shock" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Price move" }), {
      target: { value: "-10" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run what-if" }));
    await waitFor(() =>
      expect(screen.getByText(/Change in value if every share moved -10%/)).toBeInTheDocument(),
    );
  });

  it("offers no strategy or profile choice for the custom question", () => {
    render(<WhatIfForm options={options} remaining={3} limit={5} action={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("What do you want to ask?"), {
      target: { value: "custom" },
    });
    expect(screen.queryByRole("combobox", { name: "Strategy" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Trading costs" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Price move" })).toBeNull();
  });
});
