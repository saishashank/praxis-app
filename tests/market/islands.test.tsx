// Client islands of the Market pages (M7 T15; TST-128): the watchlist star, the "i" overview sheet and
// the instant search. They talk to the server only through the action prop and the two same-origin GET
// routes; a fetch to any other host would throw in these tests.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarketSearch } from "@/app/(app)/market/MarketSearch";
import { OverviewSheet } from "@/app/(app)/market/OverviewSheet";
import { StarButton, StarDisabled } from "@/app/(app)/market/StarButton";
import { watchErrorText } from "@/app/(app)/market/messages";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const calls: string[] = [];
const respond = vi.fn<(url: string) => unknown>();
beforeEach(() => {
  calls.length = 0;
  respond.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (!url.startsWith("/")) throw new Error(`external call refused: ${url}`);
      const body = respond(url);
      return new Response(JSON.stringify(body), {
        status: body === null ? 404 : 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("StarButton", () => {
  it("is a pressed-state button named for the company, and flips after a successful call", async () => {
    const action = vi.fn(async () => ({ ok: true as const, starred: true, changed: true }));
    render(<StarButton code="ZZUP" starred={false} action={action} />);
    const btn = screen.getByRole("button", { name: "Add ZZUP to watchlist" });
    expect(btn).toHaveAttribute("aria-pressed", "false");
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const fd = (action.mock.calls[0] as unknown as [FormData])[0];
    expect(fd.get("code")).toBe("ZZUP");
    expect(fd.get("state")).toBe("on");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Remove ZZUP from watchlist" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
  });

  it("asks for 'off' when it is already starred", async () => {
    const action = vi.fn(async () => ({ ok: true as const, starred: false, changed: true }));
    render(<StarButton code="ZZUP" starred action={action} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove ZZUP from watchlist" }));
    });
    const fd = (action.mock.calls[0] as unknown as [FormData])[0];
    expect(fd.get("state")).toBe("off");
  });

  it("shows a plain-words alert for a refusal and keeps the old state", async () => {
    const action = vi.fn(async () => ({ error: "limit" as const }));
    render(<StarButton code="ZZUP" starred={false} action={action} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add ZZUP to watchlist" }));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(watchErrorText("limit"));
    expect(screen.getByRole("button", { name: "Add ZZUP to watchlist" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("an unknown error code still gives the generic text, never internals", () => {
    expect(watchErrorText("whatever")).toMatch(/nothing was changed/);
  });

  it("the disabled star says why in its name", () => {
    render(<StarDisabled label="Add Stock A to watchlist" reason="names are hidden" />);
    const b = screen.getByRole("button", { name: "Add Stock A to watchlist: names are hidden" });
    expect(b).toBeDisabled();
  });
});

describe("OverviewSheet", () => {
  const overview = {
    masked: false,
    stock: "ZZUP",
    slug: "ZZUP",
    name: "Zed Upward Holdings",
    sector: "Technology",
    d: "2026-10-19",
    close: { micro: "10500000" },
    changePpm: 50_000,
    volume: 1200,
    announcements: [
      {
        id: 1,
        title: "Full-year result",
        published: "2026-10-19T02:00:00.000Z",
        url: "https://news.example.test/doc.pdf",
      },
    ],
    summary:
      "A description of the business needs a company-profile source the app does not have yet.",
    swot: null,
    notice:
      "AI summary of public information — may be incomplete or out of date. Not financial advice.",
  };

  it("opens a dialog, fetches the overview from the same origin and shows facts only", async () => {
    respond.mockReturnValue(overview);
    render(<OverviewSheet slug="ZZUP" label="ZZUP" />);
    expect(calls).toEqual([]); // nothing is fetched until it is opened
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Company overview for ZZUP" }));
    });
    const dialog = await screen.findByRole("dialog", { name: "Overview: ZZUP" });
    await within(dialog).findByText("Zed Upward Holdings");
    expect(calls).toEqual(["/api/market/ZZUP/overview"]);
    expect(
      within(dialog).getByText(
        "A description of the business needs a company-profile source the app does not have yet.",
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/AI summary of public information/)).toBeInTheDocument();
    expect(within(dialog).getByText("A$10.50")).toBeInTheDocument();
    expect(within(dialog).getByText("+5.00%")).toBeInTheDocument();
    const link = within(dialog).getByRole("link", { name: "Full-year result" });
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(within(dialog).getByRole("link", { name: "Open the company page" })).toHaveAttribute(
      "href",
      "/market/ZZUP",
    );
    expect(
      (
        await axe.run(dialog, {
          runOnly: ["wcag2a", "wcag2aa"],
          rules: { "color-contrast": { enabled: false } },
        })
      ).violations,
    ).toEqual([]);
  });

  it("closes with Escape and returns focus to the 'i' button", async () => {
    respond.mockReturnValue(overview);
    render(<OverviewSheet slug="ZZUP" label="ZZUP" />);
    const trigger = screen.getByRole("button", { name: "Company overview for ZZUP" });
    await act(async () => {
      fireEvent.click(trigger);
    });
    await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it("says so in words when the overview cannot be loaded", async () => {
    respond.mockReturnValue(null);
    render(<OverviewSheet slug="stock-z" label="Stock Z" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Company overview for Stock Z" }));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be loaded/);
  });

  it("a masked overview shows derived numbers and no price or name", async () => {
    respond.mockReturnValue({
      ...overview,
      masked: true,
      stock: "Stock B",
      slug: "stock-b",
      name: null,
      sector: null,
      close: null,
      announcements: [],
    });
    render(<OverviewSheet slug="stock-b" label="Stock B" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Company overview for Stock B" }));
    });
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("Day change");
    expect(dialog.textContent).not.toMatch(/A\$|Zed|ZZ/);
    expect(within(dialog).getByText("No announcements stored yet.")).toBeInTheDocument();
  });
});

describe("MarketSearch", () => {
  const hits = [
    { code: "ZZUP", name: "Zed Upward Holdings", sector: "Technology", starred: false },
    { code: "ZZDN", name: "Zed Downward Mining", sector: "Materials", starred: true },
  ];
  const noStar = vi.fn(async () => ({ ok: true as const, starred: true, changed: true }));

  it("searches after a 150 ms pause and lists results with a star and an 'i' each", async () => {
    vi.useFakeTimers();
    respond.mockReturnValue({ results: hits });
    render(
      <MarketSearch
        initialQuery=""
        initialHits={[]}
        masked={false}
        note={null}
        mode="star"
        starAction={noStar}
      />,
    );
    const box = screen.getByLabelText("Search by company name or code");
    fireEvent.change(box, { target: { value: "zz" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(calls).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(calls).toEqual(["/api/market/search?q=zz"]);
    const list = screen.getByRole("list", { name: "Search results" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getByRole("button", { name: "Add ZZUP to watchlist" })).toBeInTheDocument();
    expect(
      within(list).getByRole("button", { name: "Remove ZZDN from watchlist" }),
    ).toBeInTheDocument();
    expect(
      within(list).getByRole("button", { name: "Company overview for ZZUP" }),
    ).toBeInTheDocument();
    expect(within(list).getByRole("link", { name: /Zed Upward Holdings/ })).toHaveAttribute(
      "href",
      "/market/ZZUP",
    );
  });

  it("only the last keystroke's request is kept (earlier ones are cancelled by the pause)", async () => {
    vi.useFakeTimers();
    respond.mockReturnValue({ results: hits });
    render(
      <MarketSearch
        initialQuery=""
        initialHits={[]}
        masked={false}
        note={null}
        mode="star"
        starAction={noStar}
      />,
    );
    const box = screen.getByLabelText("Search by company name or code");
    for (const v of ["z", "zz", "zzu"]) {
      fireEvent.change(box, { target: { value: v } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(calls).toEqual(["/api/market/search?q=zzu"]);
  });

  it("says 'No companies match' for an empty result and clears when the box is emptied", async () => {
    vi.useFakeTimers();
    respond.mockReturnValue({ results: [] });
    render(
      <MarketSearch
        initialQuery=""
        initialHits={[]}
        masked={false}
        note={null}
        mode="none"
        starAction={noStar}
      />,
    );
    const box = screen.getByLabelText("Search by company name or code");
    fireEvent.change(box, { target: { value: "qqq" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(screen.getByText("No companies match that search.")).toBeInTheDocument();
    fireEvent.change(box, { target: { value: "" } });
    expect(screen.queryByText("No companies match that search.")).toBeNull();
  });

  it("a Viewer's results have an 'i' and no star", async () => {
    vi.useFakeTimers();
    respond.mockReturnValue({ results: hits });
    render(
      <MarketSearch
        initialQuery=""
        initialHits={[]}
        masked={false}
        note={null}
        mode="none"
        starAction={noStar}
      />,
    );
    fireEvent.change(screen.getByLabelText("Search by company name or code"), {
      target: { value: "zz" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(screen.queryByRole("button", { name: /watchlist/ })).toBeNull();
    expect(screen.getAllByRole("button", { name: /Company overview/ })).toHaveLength(2);
  });

  it("masked: the box is disabled with the reason and no request is ever sent", async () => {
    vi.useFakeTimers();
    render(
      <MarketSearch
        initialQuery=""
        initialHits={[]}
        masked
        note="Company names and prices are hidden for your access level."
        mode="disabled"
        starAction={noStar}
      />,
    );
    const box = screen.getByLabelText("Search by company name or code");
    expect(box).toBeDisabled();
    expect(screen.getByRole("button", { name: "Search" })).toBeDisabled();
    expect(screen.getByText(/Search is switched off for you/)).toBeInTheDocument();
    fireEvent.change(box, { target: { value: "bhp" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(calls).toEqual([]);
  });

  it("shows a plain alert when the search route fails", async () => {
    vi.useFakeTimers();
    respond.mockReturnValue(null);
    render(
      <MarketSearch
        initialQuery=""
        initialHits={[]}
        masked={false}
        note={null}
        mode="star"
        starAction={noStar}
      />,
    );
    fireEvent.change(screen.getByLabelText("Search by company name or code"), {
      target: { value: "zz" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/not available right now/);
  });

  it("is a real GET form to /market (the no-JavaScript path) and has no axe violations", async () => {
    const { container } = render(
      <MarketSearch
        initialQuery="zz"
        initialHits={hits}
        masked={false}
        note={null}
        mode="star"
        starAction={noStar}
      />,
    );
    const form = container.querySelector("form")!;
    expect(form).toHaveAttribute("action", "/market");
    expect(form).toHaveAttribute("method", "get");
    expect(screen.getByRole("list", { name: "Search results" })).toBeInTheDocument();
    const res = await axe.run(container, {
      runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
      rules: { "color-contrast": { enabled: false } },
    });
    expect(res.violations).toEqual([]);
  });
});
