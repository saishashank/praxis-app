// @vitest-environment node
// LLM-070 / AT-46 roster half: retired models are unreachable; every model id in code is rostered.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isRetired, isRoutable, ROSTER } from "@/lib/llm/roster";

const ID_RE =
  /["'`]((?:gemini-|llama-|openai\/gpt-oss|qwen\/|meta-llama\/)[A-Za-z0-9._\/:-]*)["'`]/g;

describe("LLM roster", () => {
  it("has dated, sourced entries", () => {
    for (const e of ROSTER) {
      expect(e.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.sourceUrl).toMatch(/^https:\/\//);
      expect(["verified", "unverified", "retired"]).toContain(e.status);
    }
  });

  it("retires GitHub Models, Gemini 2.0 and Llama 3.3 70B", () => {
    expect(isRetired("github-models", "anything")).toBe(true);
    expect(isRetired("google", "gemini-2.0-flash")).toBe(true);
    expect(isRetired("google", "gemini-2.0-flash-lite")).toBe(true);
    expect(isRetired("groq", "llama-3.3-70b-versatile")).toBe(true);
    expect(isRoutable("google", "gemini-2.0-flash")).toBe(false);
    expect(isRoutable("github-models", "gpt-4o")).toBe(false);
    expect(isRoutable("google", "gemini-2.5-pro")).toBe(true);
    expect(isRoutable("google", "unlisted-model")).toBe(false);
  });

  it("OpenRouter is a free-only fallback and no retired entry carries a role", () => {
    for (const e of ROSTER.filter((x) => x.provider === "openrouter"))
      expect(e.modelId.endsWith(":free")).toBe(true);
    for (const e of ROSTER.filter((x) => x.status === "retired")) expect(e.roles).toEqual([]);
  });

  it("every model id literal under src/lib/llm is in the roster and not retired", () => {
    const dir = path.join(process.cwd(), "src", "lib", "llm");
    const known = new Set(ROSTER.filter((e) => e.status !== "retired").map((e) => e.modelId));
    const prefixOnly = new Set(["openai/gpt-oss"]); // Groq family prefix test in providers.ts
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts") && n !== "roster.ts")) {
      const text = readFileSync(path.join(dir, f), "utf8");
      for (const m of text.matchAll(ID_RE)) {
        const id = m[1]!;
        if (prefixOnly.has(id)) continue;
        expect(known.has(id), `${f}: ${id}`).toBe(true);
      }
    }
  });
});
