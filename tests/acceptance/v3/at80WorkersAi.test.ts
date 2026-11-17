// @vitest-environment node
// AT-80 (Workers AI part, M22 L3; LLM-078, D-1413): a budget of 0 makes no request, whatever the credentials say.
import { afterEach, describe, expect, it, vi } from "vitest";
import { providerForRoster } from "@/lib/llm/providers";

const net = vi.fn();
afterEach(() => {
  net.mockReset();
  vi.unstubAllGlobals();
});

describe("AT-80 Workers AI: budget 0 makes no request", () => {
  it("credentials present, budget 0 (the default): unavailable, and a call is refused before any network", async () => {
    vi.stubGlobal("fetch", net);
    const p = providerForRoster("workers-ai", {
      models: { R2: "@cf/test/model-8b" },
      trainsOnPrompts: false,
      env: { CF_WORKERS_AI_TOKEN: "t", CF_ACCOUNT_ID: "a" },
    })!;
    expect(p.available()).toBe(false);
    await expect(
      p.call({
        role: "R2",
        model: "@cf/test/model-8b",
        prompt: "x",
        promptSha: "s",
        maxOutputTokens: 10,
      }),
    ).rejects.toThrow();
    expect(net).not.toHaveBeenCalled();
  });
});
