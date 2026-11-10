// Plain-words helpers of the strategy pages and the live day change (D-915, D-919): the fallbacks and
// the pure arithmetic, with no database.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { costProfileText, dayText, MoodBadge, rankingName } from "@/app/(app)/strategies/plain";
import { liveDayByCohort, liveDayChange } from "@/lib/ui/loaders/liveDay";
import type { LatestQuote } from "@/lib/data/quotes/latest";

afterEach(cleanup);

describe("dayText", () => {
  it("turns an ISO day into trading words and keeps a week, or says n/a", () => {
    expect(dayText("2026-11-03")).toBe("Tue 3 Nov");
    expect(dayText("2026-W45")).toBe("2026-W45");
    expect(dayText(null)).toBe("n/a");
    expect(dayText(undefined)).toBe("n/a");
  });
});

describe("costProfileText and rankingName", () => {
  it("never prints an internal code", () => {
    expect(costProfileText("P5")).toMatch(/^brokerage /);
    expect(costProfileText("P5")).not.toMatch(/\bP5\b/);
    expect(costProfileText("ZZ")).toBe("standard brokerage");
    expect(costProfileText(null)).toBe("standard brokerage");
    expect(costProfileText(undefined)).toBe("standard brokerage");
  });
  it("names rankings as sentences and keeps unknown names", () => {
    expect(rankingName("v1")).toBe("Standard ranking");
    expect(rankingName("composite3, vol_scaled")).toBe(
      "Blend of momentum, calm and volume, Standard ranking scaled by how much the share swings",
    );
    expect(rankingName("Ranking 2")).toBe("Ranking 2");
  });
});

describe("MoodBadge", () => {
  it("shows one plain word with the meaning on hover, and a neutral badge for an unknown mood", () => {
    render(<MoodBadge regime="SHOCK" />);
    expect(screen.getByText("Market mood").parentElement!).toHaveAttribute(
      "title",
      "A sudden, sharp market fall.",
    );
    expect(screen.getByText("Market mood").parentElement!.className).toContain("text-regime-shock");
    expect(document.body.textContent).not.toContain("SHOCK");
    cleanup();
    render(<MoodBadge regime={null} />);
    const badge = screen.getByText("Market mood").parentElement!;
    expect(badge.className).toContain("text-regime-neutral");
    expect(badge.getAttribute("title")).toBeTruthy();
    cleanup();
    render(<MoodBadge regime="WEIRD" />);
    expect(screen.getByText("Market mood").parentElement!.className).toContain(
      "text-regime-neutral",
    );
  });
});

const quote = (code: string, last: number, at: string, d: string): LatestQuote => ({
  code,
  lastMicro: BigInt(last),
  prevCloseMicro: null,
  quoteAt: at,
  quoteD: d,
});

describe("liveDayChange", () => {
  const pos = [
    { code: "ZZUP", qty: 10, closeMicro: 10_000_000 },
    { code: "ZZDN", qty: 5, closeMicro: 4_000_000 },
    { code: "ZZNONE", qty: 1, closeMicro: 1_000_000 },
  ];
  it("is null when no holding has a quote from a later day than the close", () => {
    expect(liveDayChange(pos, new Map(), "2026-10-16")).toBeNull();
    const stale = new Map([
      ["ZZUP", quote("ZZUP", 11_000_000, "2026-10-16T05:00:00Z", "2026-10-16")],
    ]);
    expect(liveDayChange(pos, stale, "2026-10-16")).toBeNull();
    expect(liveDayChange([], new Map(), "2026-10-16")).toBeNull();
  });
  it("adds shares times the move for every fresh holding and reports the newest quote time", () => {
    const quotes = new Map([
      ["ZZUP", quote("ZZUP", 11_000_000, "2026-10-19T01:00:00Z", "2026-10-19")],
      ["ZZDN", quote("ZZDN", 3_000_000, "2026-10-19T02:30:00Z", "2026-10-19")],
      ["ZZOLD", quote("ZZOLD", 9_000_000, "2026-10-16T02:30:00Z", "2026-10-16")],
    ]);
    const r = liveDayChange(pos, quotes, "2026-10-16");
    expect(r).toEqual({ changeMicro: 10 * 1_000_000 + 5 * -1_000_000, at: "2026-10-19T02:30:00Z" });
    const reversed = liveDayChange([pos[1]!, pos[0]!], quotes, "2026-10-16");
    expect(reversed!.at).toBe("2026-10-19T02:30:00Z");
  });
});

describe("liveDayByCohort", () => {
  it("returns nothing and reads nothing when there are no cohorts", async () => {
    const db = {
      execute: async () => {
        throw new Error("must not be called");
      },
    };
    expect(await liveDayByCohort(db, "AU", [])).toEqual({ byCohort: new Map(), anyAt: null });
  });
});
