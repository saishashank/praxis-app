import { describe, expect, it } from "vitest";
import { safeCallbackUrl } from "@/lib/auth/callbackUrl";

describe("safeCallbackUrl", () => {
  it.each([
    "//evil.test",
    "https://evil.test",
    "javascript:alert(1)",
    "/\\evil.test",
    "/a\tb",
    "/a\nb",
    "",
    "relative",
    "/" + "a".repeat(2001),
    undefined,
    null,
    42,
  ])("rejects %j", (v) => {
    expect(safeCallbackUrl(v)).toBe("/");
  });

  it("accepts same-origin relative paths", () => {
    expect(safeCallbackUrl("/markets?x=1#y")).toBe("/markets?x=1#y");
    expect(safeCallbackUrl("/")).toBe("/");
  });

  it("uses the fallback", () => {
    expect(safeCallbackUrl("//x", "/home")).toBe("/home");
  });
});
