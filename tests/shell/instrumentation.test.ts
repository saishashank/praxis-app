// @vitest-environment node
// M18 OPS-107 / D-965: the Next instrumentation hook installs the recorded-day guards only in the
// recorded app process (PRAXIS_ENV=recorded, Node runtime); in every other environment it does nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const guard = vi.hoisted(() => ({
  installHostGuard: vi.fn(),
  installNetGuard: vi.fn(),
  writeGuardMarker: vi.fn(),
}));
const clock = vi.hoisted(() => ({
  simNowFromEnv: vi.fn<(env: NodeJS.ProcessEnv) => number | null>(),
  installSimClock: vi.fn(),
}));
const wrapped = vi.hoisted(() => vi.fn());
const recordedQuoteFetch = vi.hoisted(() => vi.fn(() => wrapped));

vi.mock("@/lib/data/recorded/hostGuard.mjs", () => guard);
vi.mock("@/lib/data/recorded/simClock.mjs", () => clock);
vi.mock("@/lib/data/quotes/recordedFetch", () => ({ recordedQuoteFetch }));
vi.mock("@/lib/data/quotes/fetch", () => ({ QUOTE_CHART_URL: "https://quotes.invalid/chart" }));

import { register } from "@/instrumentation";

const saved = { ...process.env };
let realFetch: typeof fetch;

beforeEach(() => {
  vi.clearAllMocks();
  realFetch = globalThis.fetch;
  clock.simNowFromEnv.mockReturnValue(null);
});
afterEach(() => {
  process.env = { ...saved };
  globalThis.fetch = realFetch;
});

describe("register()", () => {
  it("does nothing outside the Node runtime", async () => {
    process.env.NEXT_RUNTIME = "edge";
    process.env.PRAXIS_ENV = "recorded";
    await register();
    expect(guard.installHostGuard).not.toHaveBeenCalled();
    expect(globalThis.fetch).toBe(realFetch);
  });

  it("does nothing in production or any environment other than recorded", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    for (const env of ["production", "staging", "development", ""]) {
      process.env.PRAXIS_ENV = env;
      await register();
    }
    delete process.env.PRAXIS_ENV;
    await register();
    expect(guard.installHostGuard).not.toHaveBeenCalled();
    expect(guard.installNetGuard).not.toHaveBeenCalled();
    expect(clock.installSimClock).not.toHaveBeenCalled();
    expect(globalThis.fetch).toBe(realFetch);
  });

  it("in recorded mode installs both guards, writes the marker and answers quotes in process", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.PRAXIS_ENV = "recorded";
    process.env.PRAXIS_NET_LABEL = "app-test";
    await register();
    expect(guard.installHostGuard).toHaveBeenCalledTimes(1);
    expect(guard.installNetGuard).toHaveBeenCalledTimes(1);
    expect(guard.writeGuardMarker).toHaveBeenCalledWith(process.env, "app-test");
    expect(clock.installSimClock).not.toHaveBeenCalled(); // no PRAXIS_SIM_NOW
    expect(recordedQuoteFetch).toHaveBeenCalledWith(realFetch, "https://quotes.invalid/chart");
    expect(globalThis.fetch).toBe(wrapped);
  });

  it("moves the clock when a simulated time is given; the marker label defaults to app", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.PRAXIS_ENV = "recorded";
    delete process.env.PRAXIS_NET_LABEL;
    clock.simNowFromEnv.mockReturnValue(1_700_000_000_000);
    await register();
    expect(guard.writeGuardMarker).toHaveBeenCalledWith(process.env, "app");
    expect(clock.installSimClock).toHaveBeenCalledWith(1_700_000_000_000);
  });
});
