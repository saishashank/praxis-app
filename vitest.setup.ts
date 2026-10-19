import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { RESEND_HOST, LiveSendBlockedError } from "@/lib/email/provider";

afterEach(() => cleanup());

// No-live-send guard (D-096 decision 44, SEC-101): any fetch to the real Resend API from a test
// throws. Tests that exercise the Resend adapter stub fetch themselves with vi.stubGlobal, which
// replaces this wrapper for the length of the test only.
function hostOf(input: unknown): string {
  try {
    const raw = typeof input === "string" || input instanceof URL ? input : (input as Request).url;
    return new URL(String(raw)).hostname;
  } catch {
    return "";
  }
}
const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (hostOf(input) === RESEND_HOST) throw new LiveSendBlockedError();
    return realFetch(input, init);
  }) as typeof fetch;
});
afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.fetch = realFetch;
});
