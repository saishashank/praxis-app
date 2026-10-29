// D-201: a clicked tab shows at once that its page is loading.
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const status = vi.hoisted(() => ({ pending: false }));
vi.mock("next/link", async (orig) => ({
  ...(await orig<typeof import("next/link")>()),
  useLinkStatus: () => status,
}));

import { TabPending } from "@/components/shell/TabBar";

afterEach(cleanup);

describe("tab loading bar (D-201)", () => {
  it("is hidden while nothing is loading", () => {
    status.pending = false;
    const { container } = render(<TabPending />);
    const bar = container.querySelector("span")!;
    expect(bar.getAttribute("aria-hidden")).toBe("true");
    expect(bar.hasAttribute("data-pending")).toBe(false);
    expect(bar.className).toContain("opacity-0");
  });

  it("shows while the clicked tab's page loads", () => {
    status.pending = true;
    const { container } = render(<TabPending />);
    const bar = container.querySelector("span")!;
    expect(bar.hasAttribute("data-pending")).toBe(true);
    expect(bar.className).toContain("animate-pulse");
  });
});
