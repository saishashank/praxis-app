// @vitest-environment node
// M21 A2 (D-1210): the generated known-route list equals a fresh scan, and isKnownRoute reads it.
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { isKnownRoute, patternToRegExp } from "@/lib/http/appRoutes";
import { GENERATED_EXPORT_ROUTES, KNOWN_ROUTE_PATTERNS } from "@/lib/http/appRoutes.generated";
import { render } from "../../scripts/routes/gen-app-routes.mjs";

describe("appRoutes.generated.ts", () => {
  it("equals a fresh scan (run: node scripts/routes/gen-app-routes.mjs --write)", async () => {
    const have = fs.readFileSync("src/lib/http/appRoutes.generated.ts", "utf8");
    expect(have).toBe(await render());
  });

  it("holds the pages, the route handlers, the metadata routes and the public files", () => {
    for (const p of [
      "/",
      "/market/[code]",
      "/api/auth/[...nextauth]",
      "/robots.txt",
      "/brand/praxis-logo-dark.svg",
      "/icon.png",
    ]) {
      expect(KNOWN_ROUTE_PATTERNS, p).toContain(p);
    }
    expect(GENERATED_EXPORT_ROUTES).toContain("/api/blueprint/export");
  });

  it("has no route-group, slot or modal segment", () => {
    for (const p of KNOWN_ROUTE_PATTERNS) expect(p, p).not.toMatch(/[()@]/);
  });
});

describe("isKnownRoute", () => {
  it("knows pages, dynamic pages, API routes, metadata and public files", () => {
    for (const p of [
      "/",
      "/picks",
      "/market/BHP",
      "/api/market/search",
      "/api/market/BHP/overview",
      "/api/auth/callback/google",
      "/robots.txt",
      "/brand/praxis-logo-dark.svg",
      "/picks/",
      "/_next/anything",
    ]) {
      expect(isKnownRoute(p), p).toBe(true);
    }
  });

  it("splits on / before decoding: an encoded slash stays inside its segment (D-1247)", () => {
    expect(isKnownRoute("/market/BH%2FP")).toBe(true);
    expect(isKnownRoute("/api/market/BH%2FP/overview")).toBe(true);
    expect(isKnownRoute("/market/BH/P")).toBe(false);
    expect(isKnownRoute("//market//BHP/")).toBe(true);
  });

  it("does not know a missing path, a path below a leaf, or an undecodable one", () => {
    for (const p of ["/zz-missing", "/api/zz-missing/model", "/picks/extra/x", "/%E0%A4%A"]) {
      expect(isKnownRoute(p), p).toBe(false);
    }
  });

  it("/sw.js and the manifest are known once a file serves them (P1)", () => {
    expect(isKnownRoute("/sw.js", [patternToRegExp("/sw.js")])).toBe(true);
    expect(isKnownRoute("/sw.js", [])).toBe(false);
  });

  it("patterns: [x] one segment, [...x] one or more, [[...x]] zero or more", () => {
    const m = (pat: string, p: string) => patternToRegExp(pat).test(p);
    expect(m("/a/[x]", "/a/1")).toBe(true);
    expect(m("/a/[x]", "/a/1/2")).toBe(false);
    expect(m("/a/[...x]", "/a/1/2")).toBe(true);
    expect(m("/a/[...x]", "/a")).toBe(false);
    expect(m("/a/[[...x]]", "/a")).toBe(true);
    expect(m("/a/[[...x]]", "/a/1/2")).toBe(true);
    expect(m("/", "/")).toBe(true);
    expect(m("/a.b", "/aXb")).toBe(false);
  });
});
