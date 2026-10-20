import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { opaqueDigest } from "@/lib/view/opaqueRef";

describe("opaqueDigest (D-139)", () => {
  const id = "card:2026-10-20.ZZD1.F4:E07";

  it("is keyed: not the plain SHA-256 of the id, and a different secret gives a different digest", () => {
    const plain = createHash("sha256").update(id).digest("hex").slice(0, 16);
    const a = opaqueDigest("ck", id, { AUTH_SECRET: "secret-a" });
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(plain);
    expect(opaqueDigest("ck", id, { AUTH_SECRET: "secret-b" })).not.toBe(a);
    expect(opaqueDigest("ck", id, { AUTH_SECRET: "secret-a" })).toBe(a);
  });

  it("separates kinds: the same id gives different card, pick and alert digests", () => {
    const env = { AUTH_SECRET: "s" };
    const all = new Set(["ck", "pk", "mk"].map((k) => opaqueDigest(k as "ck", id, env)));
    expect(all.size).toBe(3);
  });

  it("fails closed in production without AUTH_SECRET", () => {
    expect(() => opaqueDigest("pk", id, { NODE_ENV: "production" })).toThrow(/AUTH_SECRET/);
    expect(opaqueDigest("pk", id, { NODE_ENV: "test" })).toMatch(/^[0-9a-f]{16}$/);
  });
});
