// UX-114, DAT-221, ROL-102a: the Data review queue page, its form, and the queue read model.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requireUser = vi.hoisted(() => vi.fn());
const queue = vi.hoisted(() => ({ loadReviewQueue: vi.fn() }));
const actions = vi.hoisted(() => ({
  confirmCorporateActionAction: vi.fn<(fd: FormData) => Promise<unknown>>(async () => ({
    ok: true,
  })),
  rejectCorporateActionAction: vi.fn<(fd: FormData) => Promise<unknown>>(async () => ({
    ok: true,
  })),
}));
vi.mock("@/lib/auth/guard", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("@/lib/db/client", () => ({ mainDb: () => ({}) }));
vi.mock("@/lib/data/corporateActions/queue", () => queue);
vi.mock("@/app/(app)/review/actions", () => actions);

import ReviewPage from "@/app/(app)/review/page";
import { ReviewForm } from "@/app/(app)/review/ReviewForm";

const card = {
  id: 7,
  code: "ZZA",
  typeLabel: "share split",
  exDate: "2026-10-13",
  terms: "1 old share(s) become 2 new share(s)",
  sources: ["announcement", "vendor"],
  reasons: ["the price move does not match the terms"],
  alternatives: ["share split: 1 old share(s) become 3 new share(s)"],
  observed: 0.51,
  queuedOn: "2026-10-13",
  applyOn: "2026-10-20",
  neverAuto: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  requireUser.mockResolvedValue({ id: 1, email: "owner@example.test", name: null, role: "owner" });
  queue.loadReviewQueue.mockResolvedValue({ cards: [card], blockedOnly: 0 });
});

describe("review page", () => {
  it("requires admin on /review and shows the card in plain language", async () => {
    render(await ReviewPage());
    expect(requireUser).toHaveBeenCalledWith("admin", "/review");
    expect(
      screen.getByRole("heading", { level: 1, name: "Data review queue" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
      "ZZA: share split, ex-date 2026-10-13",
    );
    // the two readings side by side, each in its own labelled block (UXR-029)
    const reported = screen.getByRole("region", { name: "Reported reading for ZZA" });
    const other = screen.getByRole("region", { name: "Other reading for ZZA" });
    expect(reported).toHaveTextContent("1 old share(s) become 2 new share(s)");
    expect(other).toHaveTextContent("1 old share(s) become 3 new share(s)");
    expect(other).toHaveTextContent("51.0% of the day before");
    expect(
      screen.getByText(/Reported terms: 1 old share\(s\) become 2 new share\(s\)\./),
    ).toBeInTheDocument();
    expect(screen.getByText(/company announcement, price vendor/)).toBeInTheDocument();
    expect(screen.getByText(/does not match the terms/)).toBeInTheDocument();
    expect(screen.getByText(/51.0% of the day before/)).toBeInTheDocument();
    expect(
      screen.getByText(/Another reading: share split: 1 old share\(s\) become 3/),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Applied automatically on 2026-10-20 if left alone."),
    ).toBeInTheDocument();
    // one Apply per row (UXR-029); Reject is a quiet secondary action
    expect(screen.getAllByRole("button", { name: /^Apply/ })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
    expect(document.querySelector("input[name=id]")).toHaveValue("7");
  });

  it("copes with missing evidence", async () => {
    queue.loadReviewQueue.mockResolvedValue({
      cards: [
        { ...card, sources: [], reasons: [], alternatives: [], observed: null, applyOn: null },
      ],
      blockedOnly: 0,
    });
    render(await ReviewPage());
    expect(screen.getByText(/Seen in: unknown\./)).toBeInTheDocument();
    expect(screen.queryByText(/Why it is here/)).toBeNull();
    expect(screen.queryByText(/of the day before/)).toBeNull();
    expect(screen.queryByText(/Another reading:/)).toBeNull();
    expect(screen.getByText(/after the configured number of sessions/)).toBeInTheDocument();
  });

  it("a GL-01 price-only item shows its veto reason in plain words and is never auto-applied", async () => {
    queue.loadReviewQueue.mockResolvedValue({
      cards: [
        {
          ...card,
          sources: ["price"],
          terms: "no price adjustment",
          reasons: [
            "only a price jump was seen; no announcement or vendor record, so it is never applied automatically",
            "the vendor adjusted close does not show a split on this date",
          ],
          alternatives: [],
          neverAuto: true,
        },
      ],
      blockedOnly: 0,
    });
    render(await ReviewPage());
    expect(screen.getByText(/Why it is here:/)).toHaveTextContent(
      "only a price jump was seen; no announcement or vendor record",
    );
    expect(screen.getByText(/Why it is here:/)).toHaveTextContent(
      "the vendor adjusted close does not show a split on this date",
    );
    expect(screen.getByText(/Seen in: price move only/)).toBeInTheDocument();
    expect(screen.getByText("No other reading was reported.")).toBeInTheDocument();
    expect(screen.getByText(/Never applied automatically/)).toBeInTheDocument();
    expect(screen.queryByText(/Applied automatically on/)).toBeNull();
  });

  it("says so when nothing is waiting, and mentions blocked-only conflicts", async () => {
    queue.loadReviewQueue.mockResolvedValue({ cards: [], blockedOnly: 2 });
    render(await ReviewPage());
    expect(screen.getByText("Nothing is waiting for review.")).toBeInTheDocument();
    expect(screen.getByText(/2 more conflict\(s\)/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Apply/ })).toBeNull();
  });

  it("is refused for a non-Owner (the guard throws before anything loads)", async () => {
    requireUser.mockRejectedValue(new Error("NEXT_HTTP_ERROR_FALLBACK;403"));
    await expect(ReviewPage()).rejects.toThrow(/403/);
    expect(queue.loadReviewQueue).not.toHaveBeenCalled();
  });
});

describe("review form", () => {
  type Act = (fd: FormData) => Promise<{ ok: true } | { error: string }>;
  const ok: Act = async () => ({ ok: true });
  const form = (c: Act = ok, r: Act = ok) => render(<ReviewForm id={7} confirm={c} reject={r} />);

  afterEach(() => vi.restoreAllMocks());

  it("Apply calls the confirm action with the id", async () => {
    const c = vi.fn<(fd: FormData) => Promise<{ ok: true }>>(async () => ({ ok: true }));
    const r = vi.fn<(fd: FormData) => Promise<{ ok: true }>>(async () => ({ ok: true }));
    form(c, r);
    fireEvent.click(screen.getByRole("button", { name: /^Apply/ }));
    await waitFor(() => expect(c).toHaveBeenCalled());
    expect(c.mock.calls[0][0].get("id")).toBe("7");
    expect(r).not.toHaveBeenCalled();
    expect(await screen.findByRole("status")).toHaveTextContent("Done.");
  });

  it("Reject calls the reject action", async () => {
    const c = vi.fn<(fd: FormData) => Promise<{ ok: true }>>(async () => ({ ok: true }));
    const r = vi.fn<(fd: FormData) => Promise<{ ok: true }>>(async () => ({ ok: true }));
    form(c, r);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(r).toHaveBeenCalled());
    expect(c).not.toHaveBeenCalled();
  });

  it.each([
    ["not_open", /no longer waiting/],
    ["conflicts_with_confirmed", /already confirmed/],
    ["anything-else", /Something went wrong/],
  ])("shows the %s error without internals", async (error, text) => {
    form(async () => ({ error }));
    fireEvent.click(screen.getByRole("button", { name: /^Apply/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
  });
});
