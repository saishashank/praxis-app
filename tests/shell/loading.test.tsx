// D-201: the signed-in pages show a placeholder at once while their data loads.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import Loading from "@/app/(app)/loading";

afterEach(cleanup);

describe("signed-in loading placeholder (D-201)", () => {
  it("announces one busy status with a text label", () => {
    render(<Loading />);
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(status.textContent).toContain("Loading the page");
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });
});
