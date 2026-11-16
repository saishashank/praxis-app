// M21 C1 (UXN-320 a, D-1203): the review frame is sandbox="allow-same-origin" (never allow-scripts), starts at a
// server estimate and takes its exact height from the frame document on load; no fixed 80vh, no empty band.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ReviewFrame } from "@/app/(app)/reviews/[date]/ReviewFrame";
import {
  REVIEW_FRAME_MAX_PX,
  REVIEW_FRAME_MIN_PX,
  estimateReviewHeightPx,
} from "@/app/(app)/reviews/[date]/reviewHeight";

afterEach(cleanup);

const frame = () => screen.getByTitle("Evening Review, Fri 6 Nov") as HTMLIFrameElement;
const show = () =>
  render(
    <ReviewFrame title="Evening Review, Fri 6 Nov" html="<p>hello</p>" initialHeightPx={500} />,
  );

/** jsdom has no layout: give the frame document the heights a browser would report. */
function docHeights(el: HTMLIFrameElement, scrollHeight: number) {
  const d = el.contentDocument!;
  for (const node of [d.documentElement, d.body])
    Object.defineProperty(node, "scrollHeight", { configurable: true, value: scrollHeight });
}

describe("ReviewFrame", () => {
  it("is sandboxed with allow-same-origin and no allow-scripts", () => {
    show();
    const tokens = (frame().getAttribute("sandbox") ?? "").split(/\s+/).filter(Boolean);
    expect(tokens).toEqual(["allow-same-origin"]);
    expect(frame().getAttribute("srcdoc")).toBe("<p>hello</p>");
  });

  it("starts at the server estimate, with no fixed viewport height", () => {
    show();
    expect(frame().style.height).toBe("500px");
    expect(frame().className).not.toMatch(/80vh/);
  });

  it("takes the exact height from the frame document on load", () => {
    show();
    docHeights(frame(), 1234);
    act(() => {
      fireEvent.load(frame());
    });
    expect(frame().style.height).toBe("1234px");
  });

  it("a short document shrinks the frame (no empty band) down to the floor", () => {
    show();
    docHeights(frame(), 90);
    act(() => {
      fireEvent.load(frame());
    });
    expect(frame().style.height).toBe(`${REVIEW_FRAME_MIN_PX}px`);
  });

  it("a very long document is capped, not unbounded", () => {
    show();
    docHeights(frame(), 900_000);
    act(() => {
      fireEvent.load(frame());
    });
    expect(frame().style.height).toBe(`${REVIEW_FRAME_MAX_PX}px`);
  });

  it("keeps the estimate when the frame document cannot be read", () => {
    show();
    Object.defineProperty(frame(), "contentDocument", { configurable: true, value: null });
    act(() => {
      fireEvent.load(frame());
    });
    expect(frame().style.height).toBe("500px");
  });

  it("measures again on resize only when the frame's width changed", async () => {
    show();
    // jsdom fires its own load for a srcdoc frame: let it pass before the scene is set up
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const width = (w: number) =>
      Object.defineProperty(frame(), "clientWidth", { configurable: true, value: w });
    width(800);
    docHeights(frame(), 800);
    act(() => {
      fireEvent.load(frame());
    });
    const next = () => new Promise((r) => requestAnimationFrame(() => r(null)));
    // height-only resize (a URL bar): no new measure, the frame does not move
    docHeights(frame(), 1500);
    await act(async () => {
      fireEvent(window, new Event("resize"));
      await next();
    });
    expect(frame().style.height).toBe("800px");
    // width change: measured again
    width(400);
    await act(async () => {
      fireEvent(window, new Event("resize"));
      await next();
    });
    expect(frame().style.height).toBe("1500px");
  });
});

describe("estimateReviewHeightPx", () => {
  it("is 28 px per line of the plain-text alternative, clamped to 320..4000", () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");
    expect(estimateReviewHeightPx(lines(20))).toBe(20 * 28);
    expect(estimateReviewHeightPx(lines(2))).toBe(320);
    expect(estimateReviewHeightPx(lines(500))).toBe(4000);
  });
  it("falls back to the floor with no text", () => {
    expect(estimateReviewHeightPx(null)).toBe(320);
    expect(estimateReviewHeightPx("")).toBe(320);
  });
});
