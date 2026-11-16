// M21 C1 (UXN-321 item 13, D-1206): the Market index strip is a one-row table with a screen-reader caption, a row
// header for the index, column headers and a visible one-line summary in trading words; the sparkline stays.
import { act, cleanup, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { IndexSection } from "@/app/(app)/market/sections";

afterEach(cleanup);

const strip = {
  code: "AXJO",
  label: "ASX 200",
  d: "2026-11-06",
  changePpm: 4_000,
  closeMicro: 8_512_300_000,
  closes: [8_400_000_000, 8_512_300_000],
  dates: ["2026-11-05", "2026-11-06"],
  live: null as { levelMicro: number; changePpm: number; at: string } | null,
};
const show = async (el: ReactElement) => {
  let r!: ReturnType<typeof render>;
  await act(async () => {
    r = render(el);
  });
  return r;
};
const summary = (c: HTMLElement) =>
  (c.querySelector('[data-testid="index-summary"]') as HTMLElement).textContent;

describe("Market index table", () => {
  it("is one table with a caption, a row header and column headers", async () => {
    await show(<IndexSection index={Promise.resolve(strip)} masked={false} />);
    const table = screen.getByRole("table", { name: "Main index, latest level and change" });
    expect(table.querySelector("caption")?.textContent).toBe("Main index, latest level and change");
    // the sparkline adds its own table of values, so count this table's own rows
    expect(table.tHead!.rows).toHaveLength(1);
    expect(table.tBodies[0]!.rows).toHaveLength(1);
    const heads = within(table.tHead!.rows[0]!).getAllByRole("columnheader");
    expect(heads.length).toBeGreaterThanOrEqual(3);
    for (const h of heads) expect(h.getAttribute("scope")).toBe("col");
    const rowHead = within(table.tBodies[0]!.rows[0]!).getAllByRole("rowheader")[0]!;
    expect(rowHead.textContent).toBe("ASX 200");
    expect(rowHead.getAttribute("scope")).toBe("row");
  });

  it("says the level, the move and the freshness in one visible line, in trading words", async () => {
    const { container } = await show(
      <IndexSection index={Promise.resolve(strip)} masked={false} />,
    );
    expect(summary(container)).toBe(
      "ASX 200: 8,512.30, up 0.40% on the day. End of day, Fri 6 Nov.",
    );
    expect(container.textContent).not.toMatch(/AXJO|\d{9,}|2026-/);
  });

  it("a delayed level is said as Delayed with its time", async () => {
    const live = { levelMicro: 8_520_000_000, changePpm: -2_500, at: "13:05" };
    const { container } = await show(
      <IndexSection index={Promise.resolve({ ...strip, live })} masked={false} />,
    );
    expect(summary(container)).toBe("ASX 200: 8,520.00, down 0.25% on the day. Delayed, 13:05.");
  });

  it("a flat day says so", async () => {
    const { container } = await show(
      <IndexSection index={Promise.resolve({ ...strip, changePpm: 0 })} masked={false} />,
    );
    expect(summary(container)).toContain("unchanged on the day");
  });

  it("a masked user gets the change only: no index name, level or date", async () => {
    const { container } = await show(<IndexSection index={Promise.resolve(strip)} masked />);
    expect(summary(container)).toBe("Market index: up 0.40% on the day. End of day.");
    expect(container.textContent).not.toMatch(/AXJO|ASX 200|8,512|Nov|2026-/);
    expect(within(screen.getAllByRole("table")[0]!).getAllByRole("rowheader")[0]!.textContent).toBe(
      "Market index",
    );
  });

  it("keeps the sparkline", async () => {
    await show(<IndexSection index={Promise.resolve(strip)} masked={false} />);
    expect(screen.getAllByRole("img", { name: /Main index, last month/ }).length).toBeGreaterThan(
      0,
    );
  });

  it("no index data keeps the existing words and no table", async () => {
    await show(<IndexSection index={Promise.resolve(null)} masked={false} />);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText(/No index data has been stored yet/)).toBeInTheDocument();
  });
});
