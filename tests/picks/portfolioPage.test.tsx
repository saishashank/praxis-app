// D-1849: "My portfolio" has its own page (/portfolio), read by every role, with the h1 "My portfolio" and the
// Simulated label for an unmasked user; the Picks page no longer carries it.
import { cleanup, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanupTempDbs } from "../db/helpers";
import { envOf, fullWorld, type Who, type World } from "../loaders/world";
import type { LoaderEnv } from "@/lib/ui/loaders/shell";
import PortfolioPage from "@/app/(app)/portfolio/page";
import PicksPage from "@/app/(app)/picks/page";

let current: LoaderEnv;
const guard = vi.fn(async () => ({ id: 1, role: "owner" }));
vi.mock("@/lib/auth/guard", () => ({ requireUser: (...a: unknown[]) => guard(...(a as [])) }));
vi.mock("@/lib/auth/ownerToolsGuard", () => ({ ownerToolsVisibleTo: vi.fn(async () => false) }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/ui/loaders/shell", async (orig) => ({
  ...(await orig<typeof import("@/lib/ui/loaders/shell")>()),
  envFor: async () => current,
}));

afterAll(cleanupTempDbs);
afterEach(cleanup);

describe("Portfolio page (D-1849)", () => {
  let w: World;
  beforeAll(async () => {
    w = await fullWorld();
  }, 60_000);

  it.each(["owner", "editor", "viewer"] as const)(
    "%s reads it under the read action",
    async (who: Who) => {
      current = envOf(w, who);
      render(await PortfolioPage({ searchParams: Promise.resolve({}) }));
      expect(guard).toHaveBeenLastCalledWith("read", "/portfolio");
      expect(screen.getByRole("heading", { level: 1, name: "My portfolio" })).toBeInTheDocument();
      expect(screen.getByTestId("pick-portfolio")).toBeInTheDocument();
      expect(screen.getAllByRole("group").length).toBeGreaterThanOrEqual(3);
    },
  );

  it("the Picks page does not render it any more", async () => {
    current = envOf(w, "owner");
    render(await PicksPage({ searchParams: Promise.resolve({}) }));
    expect(screen.queryByTestId("pick-portfolio")).toBeNull();
    expect(screen.queryByRole("heading", { name: "My portfolio" })).toBeNull();
  });
});
