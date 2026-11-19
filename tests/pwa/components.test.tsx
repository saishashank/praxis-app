// M21 P1 (UXN-010, PLT-079, D-1231, D-1280): the offline badge, the install row and the service-worker registration.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OfflineBadge } from "@/components/pwa/OfflineBadge";
import { InstallRow } from "@/components/pwa/InstallRow";
import { RegisterSW } from "@/components/pwa/RegisterSW";

const setOnline = (v: boolean) =>
  Object.defineProperty(window.navigator, "onLine", { value: v, configurable: true });

afterEach(() => {
  cleanup();
  setOnline(true);
  vi.unstubAllEnvs();
});

describe("OfflineBadge", () => {
  beforeEach(() => setOnline(true));
  it("renders nothing while online", () => {
    const { container } = render(<OfflineBadge />);
    expect(container.textContent).toBe("");
  });
  it("appears on offline, says so in trading words, and goes away on online", () => {
    render(<OfflineBadge />);
    act(() => {
      setOnline(false);
      window.dispatchEvent(new Event("offline"));
    });
    const badge = screen.getByRole("status");
    expect(badge.textContent).toMatch(/offline/i);
    expect(badge.textContent).toMatch(/figures shown may be old/i);
    expect(badge.textContent).toMatch(/prices/i);
    expect(badge.textContent).not.toMatch(/\b[A-Z]{2,}-\d+\b|D-\d{3,}/);
    act(() => {
      setOnline(true);
      window.dispatchEvent(new Event("online"));
    });
    expect(screen.queryByRole("status")).toBeNull();
  });
  it("starts shown when the page loads offline", () => {
    setOnline(false);
    render(<OfflineBadge />);
    expect(screen.getByRole("status").textContent).toMatch(/offline/i);
  });
});

describe("InstallRow", () => {
  it("without an install prompt shows the browser's own way, no button", () => {
    render(<InstallRow />);
    expect(screen.getByText("Install Praxis on this device")).toBeTruthy();
    expect(screen.getByText(/browser menu/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /install/i })).toBeNull();
  });
  it("with the install prompt offers one button that calls it", async () => {
    const prompt = vi.fn(async () => undefined);
    render(<InstallRow />);
    const ev = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
      prompt,
      userChoice: Promise.resolve({ outcome: "accepted" }),
    });
    act(() => {
      window.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(true);
    const btn = screen.getByRole("button", { name: /install/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(prompt).toHaveBeenCalledTimes(1);
  });
});

describe("RegisterSW", () => {
  const reg = vi.fn(async () => ({}));
  beforeEach(() => {
    reg.mockClear();
    Object.defineProperty(window.navigator, "serviceWorker", {
      value: { register: reg },
      configurable: true,
    });
  });
  it("registers /sw.js in production only", () => {
    vi.stubEnv("NODE_ENV", "development");
    render(<RegisterSW />);
    expect(reg).not.toHaveBeenCalled();
    cleanup();
    vi.stubEnv("NODE_ENV", "production");
    render(<RegisterSW />);
    expect(reg).toHaveBeenCalledWith("/sw.js", { scope: "/" });
  });
});
